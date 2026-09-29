import { Writable } from 'node:stream'

import { pino } from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  asSessionCorrelationId,
  extendCorrelation,
  getCorrelation,
  newRequestId,
  newSessionCorrelationId,
  withCorrelation,
} from './context.ts'
import { BUSINESS_EVENTS, logCommittedBusinessEvent } from './events.ts'
import { baseOptions, childLogger, getLogger, initLogger, resetLoggerForTests } from './logger.ts'
import { REDACTED } from './redact.ts'

/** Collects the JSON lines a logger writes, so the output can be asserted. */
function capture() {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)))
      callback()
    },
  })
  /*
   * Indexed access is checked (`noUncheckedIndexedAccess`), and a test that
   * silently reads `undefined` because nothing was logged would pass its
   * `not.toContain` assertions for the wrong reason. This throws instead.
   */
  const line = (index = 0): Record<string, unknown> => {
    const found = lines[index]
    if (!found) throw new Error(`expected a log line at index ${index}, got ${lines.length}`)
    return found
  }
  return { lines, stream, line }
}

describe('log line shape', () => {
  it('emits JSON with a level label, ISO timestamp and base fields', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api', version: '1.2.3' }), stream)

    log.info('started')

    expect(line().level).toBe('info')
    expect(line().service).toBe('api')
    expect(line().version).toBe('1.2.3')
    expect(line().msg).toBe('started')
    /* ISO 8601, not epoch millis — readable at the moment someone needs it. */
    expect(String(line().time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('omits pid and hostname, which are noise in a container', () => {
    const { stream, line } = capture()
    pino(baseOptions({ service: 'api' }), stream).info('x')
    expect(line().pid).toBeUndefined()
    expect(line().hostname).toBeUndefined()
  })
})

describe('redaction is not bypassable', () => {
  it('redacts a denied key passed directly to the logger', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)

    log.info({ user: 'asma', password: 'hunter2' }, 'sign-in attempt')

    expect(line().password).toBe(REDACTED)
    expect(JSON.stringify(line())).not.toContain('hunter2')
  })

  it('redacts a denied key nested several levels down', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)

    log.info({ a: { b: { c: { apiKey: 'sk_live_9999' } } } }, 'nested')

    expect(JSON.stringify(line())).not.toContain('sk_live_9999')
  })

  it('sanitises an error through the err serialiser', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)

    log.error(
      { err: Object.assign(new Error('connect failed'), { host: 'db.internal', port: 5432 }) },
      'database unreachable',
    )

    const serialised = JSON.stringify(line())
    expect(serialised).not.toContain('db.internal')
    expect(serialised).toContain('connect failed')
  })
})

describe('correlation', () => {
  it('attaches the ambient context to every line without being passed it', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)
    const requestId = newRequestId()

    withCorrelation({ requestId, tenantId: 'tenant-1' }, () => {
      log.info('inside')
    })

    expect(line().requestId).toBe(requestId)
    expect(line().tenantId).toBe('tenant-1')
  })

  it('adds nothing when there is no ambient context', () => {
    const { stream, line } = capture()
    pino(baseOptions({ service: 'worker' }), stream).info('outside')
    expect(line().requestId).toBeUndefined()
  })

  /*
   * M1-C, Architecture seat condition: `ip` is carried on
   * `CorrelationContext` solely so `recordAudit` can default an audit row's
   * `ip` column from it — it must NEVER reach a log line. An IP address is
   * personal data, and broadcasting one onto every line of output for the
   * life of a request is a data-protection policy decision, not something
   * ADR-0016's secret/topology redaction layers were built to gate. This
   * asserts the actual logger OUTPUT, not `mixin()` in isolation, so a
   * regression that bypassed the strip (e.g. a future field spread after
   * it) would still be caught here.
   */
  it('never logs the ip, even though requestId and other fields still appear', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)
    const requestId = newRequestId()

    withCorrelation({ requestId, tenantId: 'tenant-1', ip: '203.0.113.7' }, () => {
      log.info('inside')
    })

    expect(line().requestId).toBe(requestId)
    expect(line().tenantId).toBe('tenant-1')
    expect(line().ip).toBeUndefined()
    expect(JSON.stringify(line())).not.toContain('203.0.113.7')
  })

  it('extends the context without leaking into a sibling scope', () => {
    const outer = { requestId: 'req-1' }

    withCorrelation(outer, () => {
      extendCorrelation({ tenantId: 'tenant-a' }, () => {
        expect(getCorrelation()?.tenantId).toBe('tenant-a')
      })
      /* The extension is scoped to its callback, not to the request. */
      expect(getCorrelation()?.tenantId).toBeUndefined()
    })
  })

  it('refuses to extend outside a correlation scope', () => {
    expect(() => extendCorrelation({ tenantId: 't' }, () => undefined)).toThrow(
      /outside a correlation scope/,
    )
  })

  /*
   * ADR-0021. `sessions.session_correlation_id` is unique PER TENANT, so the
   * log join key is the pair. Both guardians refused a globally unique index
   * on the grounds that this context already carries both — which is only
   * true if something enforces it.
   */
  it('refuses a correlation id with no tenant', () => {
    expect(() =>
      withCorrelation(
        { requestId: newRequestId(), sessionCorrelationId: newSessionCorrelationId() },
        () => undefined,
      ),
    ).toThrow(/only be set alongside tenantId/)
  })

  it('refuses to extend a tenantless context with a correlation id', () => {
    // Checked on the MERGED context: the id may arrive in a later call than
    // the tenant, and a context that has neither is not yet in violation.
    expect(() =>
      withCorrelation({ requestId: newRequestId() }, () =>
        extendCorrelation({ sessionCorrelationId: newSessionCorrelationId() }, () => undefined),
      ),
    ).toThrow(/only be set alongside tenantId/)
  })

  it('allows the id and the tenant to arrive in separate calls', () => {
    expect(() =>
      withCorrelation({ requestId: newRequestId(), tenantId: 't' }, () =>
        extendCorrelation({ sessionCorrelationId: newSessionCorrelationId() }, () => undefined),
      ),
    ).not.toThrow()
  })
})

describe('session correlation id', () => {
  it('logs the approved correlation id and never a raw session id', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)
    const sessionCorrelationId = newSessionCorrelationId()

    // `tenantId` is required alongside a correlation id (ADR-0021). This test
    // is about redaction, not pairing — the fixture simply never had a tenant.
    withCorrelation({ requestId: newRequestId(), tenantId: 't', sessionCorrelationId }, () => {
      log.info({ sessionId: 'sess_raw_secret' }, 'request')
    })

    expect(line().sessionCorrelationId).toBe(sessionCorrelationId)
    expect(line().sessionId).toBe(REDACTED)
    expect(JSON.stringify(line())).not.toContain('sess_raw_secret')
  })

  it('mints a distinct id per session', () => {
    expect(newSessionCorrelationId()).not.toBe(newSessionCorrelationId())
  })

  /*
   * The guard that makes the rule mechanical rather than cultural: a raw
   * session id routed here throws instead of being logged.
   */
  it('rejects a value that is not a minted correlation id', () => {
    expect(() => asSessionCorrelationId('sess_abc123')).toThrow(/never be used here/)
    expect(() => asSessionCorrelationId('')).toThrow()
  })

  it('rejects a bare UUID — ADR-0016 debt D8', () => {
    /*
     * THE WHOLE POINT OF THE FORMAT CHANGE.
     *
     * The guard used to validate UUID *shape*. A raw session id from any
     * randomUUID()-backed store is also a UUID, so the guard could not tell a
     * correlation id from the credential it exists to replace — it would have
     * accepted the one value it was written to refuse. `scid_` is a prefix
     * this module mints for nothing else, so it is a value the guard can
     * reject.
     */
    expect(() => asSessionCorrelationId('550e8400-e29b-41d4-a716-446655440000')).toThrow(
      /a bare UUID is exactly what this guard exists to refuse/,
    )
  })

  it('mints the format migration 005 stores', () => {
    // sessions.session_correlation_id: DEFAULT scid_ || 32 hex, and a
    // sessions_scid_shape CHECK. The guard and the column must agree, or the
    // schema stores values the only sanctioned reader throws on.
    expect(newSessionCorrelationId()).toMatch(/^scid_[0-9a-f]{32}$/)
  })

  it('accepts a minted id round-tripped through storage', () => {
    const minted = newSessionCorrelationId()
    expect(asSessionCorrelationId(String(minted))).toBe(minted)
  })
})

describe('business events', () => {
  beforeEach(() => resetLoggerForTests())

  it('rejects a name that is not ENTITY_PAST_TENSE', () => {
    initLogger({ service: 'api' })
    expect(() => logCommittedBusinessEvent({ event: 'salePosted' })).toThrow(/SCREAMING_SNAKE/)
    expect(() => logCommittedBusinessEvent({ event: 'SALE' })).toThrow()
    expect(() => logCommittedBusinessEvent({ event: 'sale_posted' })).toThrow()
  })

  it('accepts the convention', () => {
    initLogger({ service: 'api' })
    expect(() => logCommittedBusinessEvent({ event: 'SALE_POSTED' })).not.toThrow()
  })

  /*
   * The catalogue is deliberately sparse: a name appears only with the code
   * that raises it. SALE_POSTED is absent because nothing can post a sale yet.
   */
  it('does not pre-declare events for operations that do not exist', () => {
    expect(Object.keys(BUSINESS_EVENTS)).not.toContain('SALE_POSTED')
  })
})

describe('root logger lifecycle', () => {
  beforeEach(() => resetLoggerForTests())

  it('refuses to hand out a logger before startup configured one', async () => {
    const { getLogger } = await import('./logger.ts')
    expect(() => getLogger()).toThrow(/initLogger\(\)/)
  })

  it('is idempotent, so two callers cannot create two roots', () => {
    expect(initLogger({ service: 'api' })).toBe(initLogger({ service: 'worker' }))
  })
})

describe('the message path is redacted too', () => {
  /*
   * pino applies formatters.log to the merge OBJECT only, so until the
   * logMethod hook existed a secret interpolated into the MESSAGE went
   * straight to the output. That is the most likely leak in practice:
   * `logger.error(\`auth failed: ${header}\`)` is what someone writes while
   * debugging the thing that is going wrong.
   */
  const JWT = [
    // The RFC 7519 example token, assembled so no JWT-shaped literal exists
    // in the repository. See redact.test.ts for why that matters.
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ].join('.')

  it('redacts a token concatenated into the message', () => {
    const { stream, line } = capture()
    pino(baseOptions({ service: 'api' }), stream).info(`auth failed with ${JWT}`)

    expect(String(line().msg)).toContain(REDACTED)
    expect(JSON.stringify(line())).not.toContain('eyJ')
  })

  it('redacts a token passed as an interpolation argument', () => {
    const { stream, line } = capture()
    pino(baseOptions({ service: 'api' }), stream).info({ ok: 1 }, 'token %s', JWT)

    expect(JSON.stringify(line())).not.toContain('eyJ')
    expect(line().ok).toBe(1)
  })

  it('redacts a bearer credential in a message', () => {
    const { stream, line } = capture()
    pino(baseOptions({ service: 'api' }), stream).warn('header was Bearer abc123def456ghi789')

    expect(JSON.stringify(line())).not.toContain('abc123def456ghi789')
  })

  it('leaves an ordinary message intact', () => {
    const { stream, line } = capture()
    pino(baseOptions({ service: 'api' }), stream).info('posted sale INV-2026-000123')

    expect(line().msg).toBe('posted sale INV-2026-000123')
  })
})

describe('the unredacted child logger is unreachable', () => {
  /*
   * pino's own `.child()` does NOT pass its bindings through
   * `formatters.log`, so it bypassed the redaction choke point outright:
   *
   *   getLogger().child({ password: 'hunter2' }).info('x')
   *   → {"password":"hunter2", …}
   *
   * The fix is not to ban child loggers — they are useful and childLogger()
   * does the same job safely — but to make the UNREDACTED one unreachable
   * through the exported type, the same device used for branded handles.
   */
  beforeEach(() => resetLoggerForTests())

  it('childLogger redacts its bindings', () => {
    const { stream, line } = capture()
    initLogger({ service: 'api', destination: stream })

    childLogger({ module: 'sales', password: 'hunter2' }).info('with bindings')

    expect(line().module).toBe('sales')
    expect(JSON.stringify(line())).not.toContain('hunter2')
  })

  it('carries the bindings onto every line, so it is a real child', () => {
    const { stream, line } = capture()
    initLogger({ service: 'api', destination: stream })

    const child = childLogger({ module: 'procurement' })
    child.info('one')

    expect(line().module).toBe('procurement')
    expect(line().service).toBe('api')
  })

  it('refuses before startup, like getLogger', () => {
    expect(() => childLogger({ module: 'x' })).toThrow(/initLogger\(\)/)
  })

  it('does not expose child on the returned logger type', () => {
    const { stream } = capture()
    initLogger({ service: 'api', destination: stream })

    /*
     * The control is the TYPE: `Logger` declares six log methods and nothing
     * else, so `getLogger().child(...)` does not compile. The runtime method
     * still exists underneath — this asserts the surface, which is what stops
     * it being reached by accident.
     */
    const log = getLogger()
    const surface = Object.keys(log as unknown as Record<string, unknown>)
    expect(typeof log.info).toBe('function')
    expect(typeof log.error).toBe('function')
    // @ts-expect-error — child is deliberately absent from the exported type
    expect(log.child).toBeDefined()
    expect(surface).toBeDefined()
  })
})
