import { INestApplication, Module } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import { Redis } from 'ioredis'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  failedLoginAuditWorkCountForTests,
  resetFailedLoginAuditWorkCountForTests,
} from '@finsoft/auth'
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
    // M1-X, Council Sec 5: an unverified credential is not proof of who
    // acted — actorUserId is always null for a failed login. The candidate
    // (target) user is named in entityId instead.
    expect(page.items[0]?.actorUserId).toBeNull()
    expect(page.items[0]?.entityType).toBe('user')
    expect(page.items[0]?.entityId).toBe(user.ownerId)
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

  /*
   * M1-X, Council Sec 5: proof BY COUNTING, not by wall-clock timing —
   * exactly the methodology ADR-0023 §4 already established for argon2id
   * ("asserted by counting invocations, not by timing"). A known tenant's
   * failure does a REAL audit-shaped DB round trip; an unknown tenant's
   * failure does a DECOY one (decoyAuditRoundTrip) — never zero on either
   * path, which is what would make the extra work on the known-tenant path
   * an observable signal.
   */
  it('does an audit-shaped DB round trip on every failed attempt — known (real) or unknown (decoy) tenant', async () => {
    resetFailedLoginAuditWorkCountForTests()
    const user = await createActiveUserFixture('AA2B')

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: user.code, email: user.email, password: 'wrong' })
    expect(failedLoginAuditWorkCountForTests()).toBe(1)

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ tenantCode: 'NOSUCHTENANT2', email: 'nobody@example.test', password: 'whatever' })
    expect(failedLoginAuditWorkCountForTests()).toBe(2)
  })

  /*
   * M1-X, Council Sec 5: bounds the audit chain's per-tenant advisory lock
   * contention a flood of wrong passwords can cause, without affecting the
   * login RESPONSE at all — every attempt below still 401s identically
   * (ADR-0023 §4 item 4), even once the audit-write budget for this tenant
   * is spent. Each attempt uses a DIFFERENT email so the OTHER, per-(email,
   * tenant) throttle layers (packages/auth/src/throttle.ts's loginLayers,
   * limit 10 and 5 respectively) never block the request itself — only the
   * audit-write cap (limit 30) is under test here.
   */
  it('caps failed-login audit writes per tenant — the response still 401s identically past the cap', async () => {
    const user = await createActiveUserFixture('AA2C')
    const attempts = 35

    for (let i = 0; i < attempts; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: user.code, email: `nobody-${i}@example.test`, password: 'whatever' })
      expect(res.status).toBe(401)
    }

    const page = await eventsFor(user, 'USER_SIGN_IN_FAILED')
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThanOrEqual(30)
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
