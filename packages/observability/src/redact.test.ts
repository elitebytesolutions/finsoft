import { describe, expect, it } from 'vitest'

import {
  CIRCULAR,
  isDeniedKey,
  REDACTED,
  redact,
  redactError,
  redactValueShapes,
  TOO_DEEP,
  TRUNCATED,
} from './redact.ts'

describe('denied keys (layer 1)', () => {
  it.each([
    'password',
    'Password',
    'PASSWORD',
    'user_password',
    'userPassword',
    'access_token',
    'accessToken',
    'ACCESS-TOKEN',
    'refreshToken',
    'apiKey',
    'authorization',
    'Authorization',
    'cookie',
    'setCookie',
    'clientSecret',
    'privateKey',
    'db_password_hash',
  ])('denies %s', (key) => {
    expect(isDeniedKey(key)).toBe(true)
  })

  it.each(['tenantId', 'userId', 'requestId', 'amount', 'productId', 'entityType', 'hash'])(
    'allows %s',
    (key) => {
      expect(isDeniedKey(key)).toBe(false)
    },
  )

  /*
   * `hash` is the audit chain hash (NON_NEGOTIABLES rule 9). Redacting it would
   * break the tamper-evidence trail, so it is deliberately not denied — while
   * anything that is a password hash still is.
   */
  it('allows the audit chain hash but not a password hash', () => {
    expect(isDeniedKey('hash')).toBe(false)
    expect(isDeniedKey('previous_hash')).toBe(false)
    expect(isDeniedKey('passwordHash')).toBe(true)
  })
})

describe('session identifiers', () => {
  /*
   * The rule this package exists to hold: a raw session id is a bearer
   * credential and is never logged, while the approved non-secret correlation
   * id is. Both contain the word "session", so the allow-list has to be
   * explicit or the substring rule swallows the one we need.
   */
  it.each(['sessionId', 'session_id', 'session', 'sid', 'sessionToken', 'SESSIONID'])(
    'denies the raw session identifier %s',
    (key) => {
      expect(isDeniedKey(key)).toBe(true)
    },
  )

  it.each(['sessionCorrelationId', 'session_correlation_id', 'SESSION-CORRELATION-ID'])(
    'allows the approved correlation identifier %s',
    (key) => {
      expect(isDeniedKey(key)).toBe(false)
    },
  )

  it('redacts a session id nested inside a logged object', () => {
    const out = redact({ user: { name: 'Asma', sessionId: 'sess_abc123' } }) as {
      user: Record<string, unknown>
    }
    expect(out.user.sessionId).toBe(REDACTED)
    expect(out.user.name).toBe('Asma')
  })
})

describe('value shapes (layer 2)', () => {
  const JWT = [
    /*
     * ASSEMBLED, not written as a literal — and the reason is the point.
     *
     * This is the public RFC 7519 / jwt.io example token: HS256, signed with
     * the literal secret "your-256-bit-secret", payload {"sub":"1234567890"}.
     * It authenticates to nothing, and it has to exist somewhere or nothing
     * proves the redaction works.
     *
     * It used to be a literal, suppressed by a `.gitleaks.toml` allowlist
     * scoped to this file. That allowlist was a HOLE: measured against
     * gitleaks 8.30.1, `condition = "AND"` with `paths` and `regexes` did not
     * require both — a DIFFERENT, unrelated JWT added to an allowlisted file
     * was also suppressed, while the same token in any other file was caught.
     * So the exception silenced the jwt rule for this entire file rather than
     * for one known-safe string.
     *
     * Joining the segments means no JWT-shaped literal exists here, the rule
     * needs no exception, and the scanner's default coverage is restored in
     * full. The test still handles a real token at runtime, which is what it
     * was always about.
     */
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ].join('.')

  it('redacts a JWT whatever the key is called', () => {
    const out = redact({ payload: JWT }) as Record<string, string>
    expect(out.payload).toBe(REDACTED)
    expect(out.payload).not.toContain('eyJ')
  })

  it('redacts a JWT embedded in a larger string', () => {
    const out = redactValueShapes(`request failed with ${JWT} attached`)
    expect(out).toContain(REDACTED)
    expect(out).not.toContain('eyJ')
  })

  it('redacts bearer and basic credentials', () => {
    expect(redactValueShapes('Bearer abc123def456ghi')).toBe(REDACTED)
    expect(redactValueShapes('Basic dXNlcjpwYXNzd29yZA==')).toBe(REDACTED)
  })

  it('leaves ordinary text alone', () => {
    const text = 'posted sale INV-2026-000123 for Rs 9,533.33'
    expect(redactValueShapes(text)).toBe(text)
  })
})

describe('bounds', () => {
  it('terminates on a circular structure', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    const out = redact(node) as Record<string, unknown>
    expect(out.self).toBe(CIRCULAR)
  })

  it('stops at maximum depth', () => {
    let deep: Record<string, unknown> = { value: 'bottom' }
    for (let i = 0; i < 20; i += 1) deep = { nested: deep }
    expect(JSON.stringify(redact(deep))).toContain(TOO_DEEP)
  })

  it('truncates a long array and says how long it was', () => {
    const out = redact(Array.from({ length: 500 }, (_, i) => i)) as unknown[]
    expect(out.length).toBe(101)
    expect(String(out.at(-1))).toContain('500 items')
  })

  it('truncates a very long string', () => {
    const out = redact('x'.repeat(10_000)) as string
    expect(out.length).toBeLessThan(10_000)
    expect(out).toContain(TRUNCATED)
  })
})

describe('error sanitising (layer 3)', () => {
  /*
   * A `pg` connection error carries the host, port, database and role. None of
   * that has a secret-sounding key name or a token shape, so layers 1 and 2
   * both miss it — which is why this layer exists at all.
   */
  it('drops connection topology from a driver error', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'ECONNREFUSED',
      host: '10.0.0.5',
      port: 5432,
      database: 'finsoft',
      user: 'finsoft_app',
      address: '10.0.0.5',
    })

    const out = redactError(error) as unknown as Record<string, unknown>

    expect(out.code).toBe('ECONNREFUSED')
    expect(out.host).toBeUndefined()
    expect(out.port).toBeUndefined()
    expect(out.database).toBeUndefined()
    expect(out.user).toBeUndefined()
    expect(out.address).toBeUndefined()
  })

  it('keeps diagnostic context that is not topology', () => {
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'uq_grn_no',
      table: 'grn_headers',
      severity: 'ERROR',
    })

    const out = redactError(error) as unknown as Record<string, unknown>

    expect(out.constraint).toBe('uq_grn_no')
    expect(out.table).toBe('grn_headers')
    expect(out.severity).toBe('ERROR')
  })

  it('drops a connection string attached to an error', () => {
    const error = Object.assign(new Error('failed'), {
      connectionString: 'postgres://finsoft_app:hunter2@db:5432/finsoft',
    })
    const out = redactError(error) as unknown as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain('hunter2')
  })

  it('sanitises a nested cause', () => {
    const cause = Object.assign(new Error('inner'), { host: 'db.internal' })
    const error = new Error('outer', { cause })
    const out = redactError(error) as unknown as { cause: Record<string, unknown> }
    expect(out.cause.name).toBe('Error')
    expect(out.cause.host).toBeUndefined()
  })

  it('handles a thrown non-Error', () => {
    const out = redactError('just a string') as unknown as Record<string, unknown>
    expect(out.name).toBe('NonError')
    expect(out.message).toBe('just a string')
  })
})

describe('credentials, wherever they hide', () => {
  /*
   * A URL is one credential location, not the only one — and "any scheme" is
   * a claim a handful of examples cannot prove, so the schemes are tabulated.
   *
   * Rule 20 is about SECRETS. Topology (host, port, database, role) is not a
   * secret: it is stripped from the structured error fields, where it is
   * machine-readable and easy to harvest in bulk, and kept in free text
   * because a message reading "could not connect to [redacted]" helps nobody
   * at 3am. The diagnostic codes are always preserved for the same reason.
   */

  it.each([
    ['postgresql', 'postgresql://finsoft_app:hunter2@db:5432/finsoft'],
    ['postgres', 'postgres://u:p4ss@db/x'],
    ['redis', 'redis://default:s3cr3t@cache:6379'],
    ['rediss', 'rediss://default:s3cr3t@cache:6379'],
    ['amqp', 'amqp://guest:guest@rabbit:5672'],
    ['mongodb+srv', 'mongodb+srv://u:pw@cluster.example/db'],
    ['https', 'https://user:pw@example.com/path'],
    ['smtp', 'smtp://mailer:letmein@smtp.example:587'],
    ['mysql', 'mysql://root:toor@db:3306/app'],
  ])('removes the credential from a %s URL', (_scheme, url) => {
    const out = redactValueShapes(url)
    expect(out).toContain(REDACTED)
    for (const secret of ['hunter2', 'p4ss', 's3cr3t', 'guest:guest', 'pw@', 'letmein', 'toor']) {
      expect(out).not.toContain(secret)
    }
  })

  it.each([
    ['query parameter', 'https://api.example.com/v1?api_key=abc123xyz&page=2', 'abc123xyz'],
    ['token query parameter', '/callback?access_token=zzz999&state=ok', 'zzz999'],
    ['libpq connection string', 'host=db user=app password=hunter2 sslmode=require', 'hunter2'],
    ['quoted libpq value', "host=db password='hun ter2' sslmode=require", 'hun ter2'],
    ['signature parameter', 'GET /x?sig=deadbeefcafe&ts=1', 'deadbeefcafe'],
  ])('removes a credential in a %s', (_label, input, secret) => {
    const out = redactValueShapes(input)
    expect(out, `${secret} survived`).not.toContain(secret)
    expect(out).toContain(REDACTED)
  })

  it('keeps the key name, so the line still says which credential it was', () => {
    expect(redactValueShapes('password=hunter2')).toBe(`password=${REDACTED}`)
  })

  it('preserves safe diagnostic codes', () => {
    for (const diagnostic of [
      'Error: ECONNREFUSED 10.0.0.5:5432',
      'ETIMEDOUT after 2000ms',
      'SQLSTATE 23505 duplicate key',
      'GET /invoices?page=3 -> 200',
      'at Socket.connect (net.js:1:1)',
    ]) {
      expect(redactValueShapes(diagnostic)).toBe(diagnostic)
    }
  })
})

describe('a credential anywhere in the error survives nothing', () => {
  const DSN = 'postgresql://finsoft_app:hunter2@db.internal:5432/finsoft'

  it('is removed from the message', () => {
    const out = redactError(new Error(`connect failed: ${DSN}`)) as unknown as Record<
      string,
      string
    >
    expect(out.message).not.toContain('hunter2')
  })

  it('is removed from the STACK, not only the message', () => {
    const error = new Error('connect failed')
    error.stack = `Error: connect failed\n    at connect (${DSN})\n    at run (x.js:1:1)`

    const out = redactError(error) as unknown as Record<string, string>
    expect(out.stack, 'the stack leaked the password').not.toContain('hunter2')
    // and the frames survive, because the stack is why the field is kept
    expect(out.stack).toContain('at run')
  })

  it('is removed from a NESTED cause', () => {
    const inner = new Error(`inner: password=hunter2`)
    const outer = new Error('outer', { cause: inner })

    expect(JSON.stringify(redactError(outer))).not.toContain('hunter2')
  })

  it('is removed from a cause two levels down', () => {
    const deepest = new Error(`deepest: ${DSN}`)
    const middle = new Error('middle', { cause: deepest })
    const outer = new Error('outer', { cause: middle })

    expect(JSON.stringify(redactError(outer))).not.toContain('hunter2')
  })

  it('is removed from an arbitrary attached property', () => {
    const error = Object.assign(new Error('failed'), { detail: `retry with ${DSN}` })
    expect(JSON.stringify(redactError(error))).not.toContain('hunter2')
  })
})
