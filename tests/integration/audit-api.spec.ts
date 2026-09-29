import type { NestMiddleware, INestApplication } from '@nestjs/common'
import { Injectable, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordAudit, TenantContext, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { AuditModule } from '../../apps/api/src/audit/audit.module.ts'

/*
 * GET /api/audit, over real HTTP, tenant isolation.
 *
 * ── Why a middleware, and a note for the auth lane ─────────────────────────
 *
 * There is no real authentication on this branch (Wave 1's TenantGuard is a
 * stub that refuses every non-@Public() route — apps/api/src/common/
 * tenant.guard.ts). This test therefore needs its OWN way to put a tenant
 * into TenantContext for the duration of a request, and it is worth being
 * precise about which mechanism actually works, because the real guard will
 * face the identical problem.
 *
 * A NestJS Guard's canActivate cannot do it. TenantContext.run(principal, fn)
 * only keeps AsyncLocalStorage's store active for the synchronous extent of
 * `fn` and whatever `fn` itself schedules — but a guard's job is to return a
 * boolean (or a Promise<boolean>) to Nest's OWN internal dispatcher, which
 * THEN calls the interceptor chain and the handler as its own separate
 * continuation, outside anything the guard's `run()` callback scheduled.
 * Measured while building this test: a guard doing
 * `return TenantContext.run(principal, () => true)` left TenantContext empty
 * by the time the controller method executed.
 *
 * Express MIDDLEWARE works, because `next()` is called SYNCHRONOUSLY by our
 * own code from inside `TenantContext.run`, and `next()` is what triggers
 * Express (and, on top of it, Nest's whole per-request pipeline: guards,
 * interceptors, the handler) to run as a continuation of that same call —
 * so every `await` inside recordAudit/withTenant downstream still resolves
 * `TenantContext.current()` correctly. This is the shape the real
 * authentication integration almost certainly needs too; flagged here rather
 * than discovered again.
 *
 * This harness is TEST-ONLY: it reads tenant/user ids from headers, which
 * production code must never do (rule 8) — real authentication reads a
 * verified JWT claim, not a header.
 */
const TEST_TENANT_HEADER = 'x-test-tenant-id'
const TEST_USER_HEADER = 'x-test-user-id'

@Injectable()
class TestTenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const tenantId = req.header(TEST_TENANT_HEADER)
    const userId = req.header(TEST_USER_HEADER) ?? null
    if (!tenantId) {
      next()
      return
    }
    // M1-X: the controller now reads req.auth (for the per-caller audit-read
    // rate limit) as well as relying on TenantContext for the query itself —
    // set both, matching what the real TenantGuard/PermissionGuard chain
    // would have populated by this point.
    if (userId) {
      req.auth = {
        userId,
        tenantId,
        sessionId: 'test-session',
        permissionVersion: 0,
        mfa: false,
      }
    }
    TenantContext.run({ tenantId, userId }, next)
  }
}

@Module({
  imports: [AuditModule],
})
class TestAppModule {
  configure(consumer: import('@nestjs/common').MiddlewareConsumer) {
    consumer.apply(TestTenantContextMiddleware).forRoutes('*')
  }
}

let app: INestApplication
let alpha: TenantFixture
let beta: TenantFixture

async function seedEvent(tenant: TenantFixture, action: string) {
  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant((tx) =>
      recordAudit(tx, {
        actorUserId: tenant.ownerId,
        action,
        entityType: 'probe',
        entityId: null,
        beforeJson: null,
        afterJson: { via: 'seed' },
        ip: '203.0.113.7',
        requestId: null,
      }),
    ),
  )
}

beforeAll(async () => {
  await prepareTestDatabase()
  resetLoggerForTests()
  initLogger({ service: 'audit-api-test', level: 'fatal' })

  alpha = await createTenantFixture('AAPI')
  beta = await createTenantFixture('BAPI')
  await seedEvent(alpha, 'ALPHA_ONE')
  await seedEvent(alpha, 'ALPHA_TWO')
  await seedEvent(beta, 'BETA_ONE')

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new AllExceptionsFilter())
  await app.init()
}, 120_000)

afterAll(async () => {
  await app?.close()
  resetLoggerForTests()
  await teardownTestDatabase()
})

describe('GET /api/audit', () => {
  it("returns only the calling tenant's events", async () => {
    const res = await request(app.getHttpServer())
      .get('/api/audit')
      .set(TEST_TENANT_HEADER, alpha.tenantId)
      .set(TEST_USER_HEADER, alpha.ownerId)
      .expect(200)

    const actions = res.body.items.map((i: { action: string }) => i.action)
    expect(actions).toEqual(expect.arrayContaining(['ALPHA_ONE', 'ALPHA_TWO']))
    expect(actions).not.toContain('BETA_ONE')
  })

  it("tenant B never sees tenant A's rows, even by exact id", async () => {
    const alphaEvents = await request(app.getHttpServer())
      .get('/api/audit')
      .set(TEST_TENANT_HEADER, alpha.tenantId)
      .set(TEST_USER_HEADER, alpha.ownerId)
      .expect(200)
    const alphaEntityIds = alphaEvents.body.items.map((i: { id: string }) => i.id)

    const asBeta = await request(app.getHttpServer())
      .get('/api/audit')
      .set(TEST_TENANT_HEADER, beta.tenantId)
      .set(TEST_USER_HEADER, beta.ownerId)
      .expect(200)
    const betaVisibleIds = asBeta.body.items.map((i: { id: string }) => i.id)

    for (const id of alphaEntityIds) {
      expect(betaVisibleIds).not.toContain(id)
    }
  })

  it('filters by action', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/audit')
      .query({ action: 'ALPHA_ONE' })
      .set(TEST_TENANT_HEADER, alpha.tenantId)
      .set(TEST_USER_HEADER, alpha.ownerId)
      .expect(200)

    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].action).toBe('ALPHA_ONE')
  })

  it('rejects a malformed cursor with 400', async () => {
    await request(app.getHttpServer())
      .get('/api/audit')
      .query({ cursor: 'not-a-number' })
      .set(TEST_TENANT_HEADER, alpha.tenantId)
      .set(TEST_USER_HEADER, alpha.ownerId)
      .expect(400)
  })

  it('paginates with a cursor that does not repeat or skip rows', async () => {
    const page1 = await request(app.getHttpServer())
      .get('/api/audit')
      .query({ limit: 1 })
      .set(TEST_TENANT_HEADER, alpha.tenantId)
      .set(TEST_USER_HEADER, alpha.ownerId)
      .expect(200)

    expect(page1.body.items).toHaveLength(1)
    expect(page1.body.nextCursor).not.toBeNull()

    const page2 = await request(app.getHttpServer())
      .get('/api/audit')
      .query({ limit: 1, cursor: page1.body.nextCursor })
      .set(TEST_TENANT_HEADER, alpha.tenantId)
      .set(TEST_USER_HEADER, alpha.ownerId)
      .expect(200)

    expect(page2.body.items).toHaveLength(1)
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id)
  })

  it('strips undeclared query fields rather than smuggling them through, per ADR-0004:76', async () => {
    // tenant_id is never accepted from the request — Query is validated by
    // auditQuerySchema, which does not declare it, so it is discarded by the
    // pipe regardless of what the client sends.
    const res = await request(app.getHttpServer())
      .get('/api/audit')
      .query({ tenant_id: beta.tenantId })
      .set(TEST_TENANT_HEADER, alpha.tenantId)
      .set(TEST_USER_HEADER, alpha.ownerId)
      .expect(200)

    const actions = res.body.items.map((i: { action: string }) => i.action)
    expect(actions).not.toContain('BETA_ONE')
  })

  describe('S5: bounded inputs — 400, never 500', () => {
    it('rejects a cursor longer than 19 digits', async () => {
      await request(app.getHttpServer())
        .get('/api/audit')
        .query({ cursor: '1'.repeat(20) })
        .set(TEST_TENANT_HEADER, alpha.tenantId)
        .set(TEST_USER_HEADER, alpha.ownerId)
        .expect(400)
    })

    it('rejects a 19-digit cursor that exceeds int8 max', async () => {
      // 2^63 - 1 = 9223372036854775807 (19 digits). One higher, still 19
      // digits, is not representable as a PostgreSQL bigint.
      await request(app.getHttpServer())
        .get('/api/audit')
        .query({ cursor: '9223372036854775808' })
        .set(TEST_TENANT_HEADER, alpha.tenantId)
        .set(TEST_USER_HEADER, alpha.ownerId)
        .expect(400)
    })

    it('accepts a cursor exactly at int8 max', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/audit')
        .query({ cursor: '9223372036854775807' })
        .set(TEST_TENANT_HEADER, alpha.tenantId)
        .set(TEST_USER_HEADER, alpha.ownerId)
      expect(res.status).toBe(200)
    })

    it('rejects a date far outside the bounded range', async () => {
      await request(app.getHttpServer())
        .get('/api/audit')
        .query({ from: '0001-01-01T00:00:00.000Z' })
        .set(TEST_TENANT_HEADER, alpha.tenantId)
        .set(TEST_USER_HEADER, alpha.ownerId)
        .expect(400)

      await request(app.getHttpServer())
        .get('/api/audit')
        .query({ to: '9999-12-31T23:59:59.999Z' })
        .set(TEST_TENANT_HEADER, alpha.tenantId)
        .set(TEST_USER_HEADER, alpha.ownerId)
        .expect(400)
    })
  })
})

describe('GET /api/audit, through the REAL AppModule — S4', () => {
  /*
   * Not the TestAppModule above: this boots apps/api/src/app.module.ts
   * exactly as main.ts does, so the assertion is about the actual
   * TenantGuard wiring, not a test harness's approximation of it.
   */
  let realApp: INestApplication

  beforeAll(async () => {
    const { AppModule } = await import('../../apps/api/src/app.module.ts')
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    realApp = moduleRef.createNestApplication()
    realApp.setGlobalPrefix('api')
    realApp.useGlobalFilters(new AllExceptionsFilter())
    await realApp.init()
  }, 60_000)

  afterAll(async () => {
    await realApp?.close()
  })

  it('refuses GET /api/audit with no credentials at all', async () => {
    // Today's stub TenantGuard fails closed with 403 for every non-@Public()
    // route, because Wave 1 authentication has not landed on this branch —
    // see apps/api/src/common/tenant.guard.ts. Once it does (M1-A), the
    // same request becomes 401 (no credentials) rather than 403 (credentials
    // present but insufficient); this test's job is only "not 200", which
    // holds under both.
    const res = await request(realApp.getHttpServer()).get('/api/audit')
    expect([401, 403]).toContain(res.status)
    expect(res.body.items).toBeUndefined()
  })
})
