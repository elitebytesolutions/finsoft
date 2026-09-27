import { Writable } from 'node:stream'
import { Controller, Get, Module, type INestApplication } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import { Redis } from 'ioredis'
import request from 'supertest'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { prepareTestDatabase, teardownTestDatabase } from '@finsoft/database/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { FinsoftNestLogger } from '../../apps/api/src/common/nest-logger.ts'
import { TenantGuard } from '../../apps/api/src/common/tenant.guard.ts'
import { AuthModule } from '../../apps/api/src/auth/auth.module.ts'
import { createActiveUserFixture } from './helpers/auth-seed.ts'

/*
 * A deliberately sensitive error must not reach the log through EITHER
 * logger, nor the HTTP response.
 *
 * There were two log streams. NestJS's own `Logger` wrote unstructured text
 * to the same stdout the JSON pipeline reads, and the exception filter used
 * it to log a full stack for every 5xx — which is the likeliest place a `pg`
 * connection error carrying host, port, database and role reaches a log.
 *
 * This asserts the whole path at once: the response body, the structured log
 * line, and NestJS's own framework messages. All three now go through
 * `redactError` / the logger's choke point.
 */

/* A connection string of the shape `pg` actually produces on failure. */
const DSN = 'postgresql://finsoft_app:hunter2@db.internal:5432/finsoft'
const JWT = [
  // The RFC 7519 example token, assembled so no JWT-shaped literal exists
  // in the repository. See redact.test.ts for why that matters.
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
].join('.')

@Controller('leak')
class LeakController {
  /** A driver error, with the topology attached the way `pg` attaches it. */
  @Get('driver')
  driver(): never {
    throw Object.assign(new Error(`could not connect to ${DSN}`), {
      code: 'ECONNREFUSED',
      host: 'db.internal',
      port: 5432,
      database: 'finsoft',
      user: 'finsoft_app',
    })
  }

  /** A secret interpolated into a message, the way someone debugging writes it. */
  @Get('token')
  token(): never {
    throw new Error(`upstream rejected the token ${JWT}`)
  }
}

@Module({ controllers: [LeakController] })
class LeakModule {}

let app: INestApplication
let lines: Record<string, unknown>[]

beforeEach(async () => {
  resetLoggerForTests()
  lines = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)))
      callback()
    },
  })
  initLogger({ service: 'api', destination: stream, level: 'debug' })

  const moduleRef = await Test.createTestingModule({ imports: [LeakModule] }).compile()
  app = moduleRef.createNestApplication({ bufferLogs: true })
  app.useLogger(new FinsoftNestLogger('test'))
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new AllExceptionsFilter())
  await app.init()
}, 60_000)

afterEach(async () => {
  await app?.close()
  resetLoggerForTests()
})

/** Everything written to the log stream, as one string. */
const logged = (): string => JSON.stringify(lines)

describe('a driver error with connection topology', () => {
  it('returns a flat 500 that names nothing internal', async () => {
    const res = await request(app.getHttpServer()).get('/api/leak/driver').expect(500)

    const body = JSON.stringify(res.body)
    for (const secret of [DSN, 'hunter2', 'db.internal', 'finsoft_app', '5432']) {
      expect(body, `the RESPONSE leaked ${secret}`).not.toContain(secret)
    }
  })

  it('does not write the credential to the log', async () => {
    await request(app.getHttpServer()).get('/api/leak/driver')

    expect(logged(), 'the LOG leaked the password').not.toContain('hunter2')
    expect(logged(), 'the LOG leaked the full connection string').not.toContain(DSN)
  })

  /*
   * Where the line is drawn, deliberately.
   *
   * The PASSWORD is a credential and is removed everywhere — from the error's
   * fields and from its message. The HOST is topology, not a credential, and
   * the two are treated differently on purpose:
   *
   *   - stripped from the structured error FIELDS, where it is machine-
   *     readable and trivial to harvest across every line at once;
   *   - kept in the free-text message, because "could not connect to
   *     [redacted]" tells an on-call engineer nothing, and a redaction that
   *     destroys the diagnosis is one that gets switched off within a month.
   *
   * If an internal hostname is ever judged sensitive enough to remove, this
   * is the test that has to change, and it should change with a reason
   * written next to it rather than by tightening a regex.
   */
  it('strips the topology from the error FIELDS', async () => {
    await request(app.getHttpServer()).get('/api/leak/driver')

    const err = lines.find((l) => l.level === 'error')?.err as Record<string, unknown> | undefined

    expect(err).toBeDefined()
    expect(err?.host, 'host must not survive as a structured field').toBeUndefined()
    expect(err?.port).toBeUndefined()
    expect(err?.database).toBeUndefined()
    expect(err?.user).toBeUndefined()
  })

  it('still records enough to diagnose the incident', async () => {
    await request(app.getHttpServer()).get('/api/leak/driver')

    /*
     * Redaction that removed the diagnosis would be its own failure: the
     * point is to lose the credential, not the incident.
     */
    expect(logged()).toContain('ECONNREFUSED')
    expect(logged()).toContain('/api/leak/driver')
    expect(logged()).toContain('500')
  })

  it('emits ONE structured line, not a second unstructured stream', async () => {
    await request(app.getHttpServer()).get('/api/leak/driver')

    // Every captured line parsed as JSON in the stream's write(), so a
    // non-JSON write would already have thrown. This asserts the 5xx was
    // reported exactly once rather than by two loggers.
    const errors = lines.filter((l) => l.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.service).toBe('api')
  })
})

describe('a secret interpolated into an error message', () => {
  it('does not reach the log', async () => {
    await request(app.getHttpServer()).get('/api/leak/token')

    expect(logged(), 'the LOG leaked a JWT from a message string').not.toContain('eyJ')
  })

  it('does not reach the response', async () => {
    const res = await request(app.getHttpServer()).get('/api/leak/token').expect(500)
    expect(JSON.stringify(res.body)).not.toContain('eyJ')
  })
})

describe('framework messages go through the same redactor', () => {
  it('redacts a secret logged through the NestJS logger interface', () => {
    const nest = new FinsoftNestLogger('probe')

    nest.log(`connecting with ${DSN}`)
    nest.error(`token was ${JWT}`)
    nest.warn('ordinary message')

    expect(logged()).not.toContain('hunter2')
    expect(logged()).not.toContain('eyJ')
    expect(logged()).toContain('ordinary message')
  })

  it('writes JSON, so the aggregator can parse framework output', () => {
    new FinsoftNestLogger('probe').log('mapped route')

    const line = lines.find((l) => String(l.msg).includes('mapped route'))
    expect(line?.level).toBe('info')
    expect(line?.service).toBe('api')
  })
})

/*
 * B6, security re-review 2026-09-27: the auth routes themselves, exercised
 * with REAL secret-shaped values — a real password, a real bearer access
 * token, a real cookie value (the raw refresh token) — asserting none of
 * them, nor any bare 64-hex digest (a token hash), ever reaches a log line.
 * A separate app instance and log stream from the generic tests above, so
 * this can run against real PostgreSQL and Redis without disturbing them.
 */
describe('the auth routes leak neither credentials nor their hashes', () => {
  @Module({
    imports: [AuthModule],
    providers: [{ provide: APP_GUARD, useClass: TenantGuard }],
  })
  class LogLeakAuthModule {}

  let authApp: INestApplication
  let authLines: Record<string, unknown>[]
  const HEX_64 = /\b[0-9a-f]{64}\b/

  beforeAll(async () => {
    await prepareTestDatabase()
    process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL']
    const flusher = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379')
    await flusher.flushdb()
    await flusher.quit()
  }, 120_000)

  afterAll(async () => {
    await authApp?.close()
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    resetLoggerForTests()
    authLines = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        authLines.push(JSON.parse(String(chunk)))
        callback()
      },
    })
    initLogger({ service: 'api', destination: stream, level: 'debug' })

    const moduleRef = await Test.createTestingModule({ imports: [LogLeakAuthModule] }).compile()
    authApp = moduleRef.createNestApplication()
    authApp.setGlobalPrefix('api')
    authApp.use(cookieParser())
    authApp.useGlobalFilters(new AllExceptionsFilter())
    await authApp.init()
  }, 60_000)

  afterEach(async () => {
    await authApp?.close()
    resetLoggerForTests()
  })

  const authLogged = (): string => JSON.stringify(authLines)

  it('does not log the password on a failed login', async () => {
    const user = await createActiveUserFixture('LLK1')
    const password = 'S3cret-Password-Nobody-Should-See'

    await request(authApp.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password })

    expect(authLogged(), 'the password leaked into a log line').not.toContain(password)
  })

  it('does not log the password, the access token or the raw refresh token on a successful login', async () => {
    const user = await createActiveUserFixture('LLK2')

    const res = await request(authApp.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password: user.password })
    expect(res.status).toBe(200)

    const setCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('finsoft_rt='),
    )
    const rawRefreshToken = setCookie?.split(';')[0]?.split('=')[1]
    expect(rawRefreshToken).toBeTruthy()

    expect(authLogged(), 'the password leaked').not.toContain(user.password)
    expect(authLogged(), 'the access token leaked').not.toContain(res.body.accessToken)
    expect(authLogged(), 'the raw refresh token (the cookie value) leaked').not.toContain(
      rawRefreshToken,
    )
    // A bare 64-hex digest would be the token's SHA-256 hash — never logged
    // either, per §5's own note on the refresh throttle key.
    expect(authLogged(), 'a 64-hex digest (a token hash) leaked').not.toMatch(HEX_64)
  })

  it('does not log the cookie value or the new token on a rotation', async () => {
    const user = await createActiveUserFixture('LLK3')
    const login = await request(authApp.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password: user.password })
    const cookieHeader = (login.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('finsoft_rt='))
      ?.split(';')[0]
    expect(cookieHeader).toBeTruthy()

    resetLoggerForTests()
    authLines = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        authLines.push(JSON.parse(String(chunk)))
        callback()
      },
    })
    initLogger({ service: 'api', destination: stream, level: 'debug' })

    const refreshed = await request(authApp.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader as string)
      .set('X-Requested-With', 'finsoft')
      .send()
    expect(refreshed.status).toBe(200)

    const rawPresented = (cookieHeader as string).split('=')[1]
    expect(authLogged(), 'the presented raw refresh token leaked').not.toContain(rawPresented)
    expect(authLogged(), 'the successor access token leaked').not.toContain(
      refreshed.body.accessToken,
    )
    expect(authLogged(), 'a 64-hex digest leaked').not.toMatch(HEX_64)
  })

  it('does not log the bearer token on GET /me', async () => {
    const user = await createActiveUserFixture('LLK4')
    const login = await request(authApp.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password: user.password })

    resetLoggerForTests()
    authLines = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        authLines.push(JSON.parse(String(chunk)))
        callback()
      },
    })
    initLogger({ service: 'api', destination: stream, level: 'debug' })

    await request(authApp.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)

    expect(authLogged(), 'the bearer access token leaked').not.toContain(login.body.accessToken)
  })
})
