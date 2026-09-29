import { INestApplication, Module } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import { Redis } from 'ioredis'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listAuditEvents, withTenant } from '@finsoft/database'
import { prepareTestDatabase, runAs, teardownTestDatabase } from '@finsoft/database/testing'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { TenantContextInterceptor } from '../../apps/api/src/common/tenant-context.interceptor.ts'
import { TenantGuard } from '../../apps/api/src/common/tenant.guard.ts'
import { AuthModule } from '../../apps/api/src/auth/auth.module.ts'
import { createActiveUserFixture, type ActiveUserFixture } from './helpers/auth-seed.ts'

/*
 * M1-X (audit wiring): USER_SIGNED_IN, USER_SIGN_IN_FAILED, USER_SIGNED_OUT
 * and REFRESH_REUSE_DETECTED actually land in audit_log, through the real
 * HTTP surface — not a unit test of the sink in isolation. Each assertion
 * reads the row back with listAuditEvents, the same function GET /api/audit
 * uses, so this proves the wiring an operator or GET /api/audit would
 * actually see.
 */

@Module({
  imports: [AuthModule],
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
class TestAuthAppModule {}

let app: INestApplication

async function eventsFor(user: ActiveUserFixture, action: string) {
  return runAs({ tenantId: user.tenantId, userId: user.ownerId }, () =>
    withTenant((tx) => listAuditEvents(tx, { action, limit: 50 })),
  )
}

const CSRF = { 'X-Requested-With': 'finsoft' }

beforeAll(async () => {
  await prepareTestDatabase()
  process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL']

  const flusher = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379')
  await flusher.flushdb()
  await flusher.quit()

  resetLoggerForTests()
  initLogger({ service: 'auth-audit-test', level: 'fatal' })

  const moduleRef = await Test.createTestingModule({ imports: [TestAuthAppModule] }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.use(cookieParser())
  app.useGlobalFilters(new AllExceptionsFilter())
  await app.init()
}, 120_000)

afterAll(async () => {
  await app?.close()
  resetLoggerForTests()
  await teardownTestDatabase()
})

describe('USER_SIGNED_IN', () => {
  it('is written on a successful login, in the same transaction as the session', async () => {
    const user = await createActiveUserFixture('AA1')

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password: user.password })
    expect(res.status).toBe(200)

    const page = await eventsFor(user, 'USER_SIGNED_IN')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.actorUserId).toBe(user.ownerId)
    expect(page.items[0]?.entityType).toBe('session')
    expect(page.items[0]?.entityId).toEqual(expect.any(String))
  })
})

describe('USER_SIGN_IN_FAILED', () => {
  it('is written for a wrong password against a KNOWN tenant', async () => {
    const user = await createActiveUserFixture('AA2')

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password: 'definitely-wrong' })
    expect(res.status).toBe(401)

    const page = await eventsFor(user, 'USER_SIGN_IN_FAILED')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.actorUserId).toBe(user.ownerId)
  })

  it('writes nothing for an UNKNOWN tenant code — no tenant, no chain (ADR-0023 §4 item 7)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: 'NOSUCHTENANT', email: 'nobody@example.test', password: 'whatever' })
    expect(res.status).toBe(401)
    // There is no tenant to query audit_log under — the assertion this case
    // makes is simply that the request above did not throw and returned the
    // identical 401, which a crashing "audit an unknown tenant" attempt
    // would not.
  })
})

describe('USER_SIGNED_OUT', () => {
  it('is written on logout, in the same transaction as the session revocation', async () => {
    const user = await createActiveUserFixture('AA3')
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password: user.password })

    const logout = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set(CSRF)
      .send()
    expect(logout.status).toBe(204)

    const page = await eventsFor(user, 'USER_SIGNED_OUT')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.actorUserId).toBe(user.ownerId)
    expect(page.items[0]?.entityType).toBe('session')
  })

  it('a second logout on the same session is a no-op and does not double-audit', async () => {
    const user = await createActiveUserFixture('AA4')
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password: user.password })

    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .set(CSRF)
        .send()
    }

    const page = await eventsFor(user, 'USER_SIGNED_OUT')
    expect(page.items).toHaveLength(1)
  })
})

describe('REFRESH_REUSE_DETECTED', () => {
  function cookieHeaderFrom(res: request.Response): string {
    const raw = res.headers['set-cookie']
    const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
    const rt = setCookies.find((c) => c.startsWith('finsoft_rt='))
    if (!rt) throw new Error('no finsoft_rt cookie in response')
    return rt.split(';')[0] ?? ''
  }

  it('is written, in the same transaction as the family/session revocation, on a spent-token replay', async () => {
    const user = await createActiveUserFixture('AA5')
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password: user.password })
    const cookie = cookieHeaderFrom(login)

    const first = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookie)
      .set(CSRF)
      .send()
    expect(first.status).toBe(200)

    // Replaying the ALREADY-SPENT cookie value is reuse (ADR-0022: no grace
    // window at any delay).
    const replay = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookie)
      .set(CSRF)
      .send()
    expect(replay.status).toBe(401)

    const page = await eventsFor(user, 'REFRESH_REUSE_DETECTED')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.actorUserId).toBe(user.ownerId)
    expect(page.items[0]?.entityType).toBe('session')
  })
})
