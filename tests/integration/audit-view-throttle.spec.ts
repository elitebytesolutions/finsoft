import { INestApplication, Module } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { Redis } from 'ioredis'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@finsoft/database'
import { runAs, prepareTestDatabase, teardownTestDatabase } from '@finsoft/database/testing'
import { seedSystemRoles } from '@finsoft/permissions'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { AuditModule } from '../../apps/api/src/audit/audit.module.ts'
import { AuthModule } from '../../apps/api/src/auth/auth.module.ts'
import { PermissionGuard } from '../../apps/api/src/common/permission.guard.ts'
import { TenantContextInterceptor } from '../../apps/api/src/common/tenant-context.interceptor.ts'
import { TenantGuard } from '../../apps/api/src/common/tenant.guard.ts'
import { createActiveUserFixture, type ActiveUserFixture } from './helpers/auth-seed.ts'

/*
 * M1-X (deliverable 5): GET /api/audit is rate-limited per (tenant, user),
 * reusing packages/auth's throttle primitive. Exercised through the real
 * guard chain (TenantGuard, PermissionGuard) and a real login, so an
 * Owner (who holds audit.view via seedSystemRoles) is the caller — not a
 * test-only header stand-in.
 */

@Module({
  imports: [AuthModule, AuditModule],
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
class TestAppModule {}

let app: INestApplication
let owner: ActiveUserFixture
let accessToken: string

beforeAll(async () => {
  await prepareTestDatabase()
  process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL']
  const flusher = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379')
  await flusher.flushdb()
  await flusher.quit()

  resetLoggerForTests()
  initLogger({ service: 'audit-throttle-test', level: 'fatal' })

  owner = await createActiveUserFixture('AVT1')

  await runAs({ tenantId: owner.tenantId, userId: owner.ownerId }, () =>
    withTenant(async (tx) => {
      await seedSystemRoles(tx, owner.tenantId)
      const ownerRole = await tx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', owner.tenantId)
        .where('code', '=', 'owner')
        .executeTakeFirstOrThrow()
      await tx
        .insertInto('user_roles')
        .values({
          tenant_id: owner.tenantId,
          user_id: owner.ownerId,
          role_id: ownerRole.id,
          created_by: owner.ownerId,
          updated_by: owner.ownerId,
        })
        .execute()
    }),
  )

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new AllExceptionsFilter())
  await app.init()

  const login = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ tenantCode: owner.code, email: owner.email, password: owner.password })
  accessToken = login.body.accessToken
}, 120_000)

afterAll(async () => {
  await app?.close()
  resetLoggerForTests()
  await teardownTestDatabase()
})

describe('GET /api/audit rate limiting (M1-X)', () => {
  it('an ordinary read succeeds for the Owner (audit.view)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/audit')
      .set('Authorization', `Bearer ${accessToken}`)
    expect(res.status).toBe(200)
  })

  it('the (tenant, user) budget is exhaustible and returns 429 with Retry-After', async () => {
    // The first call above already spent one. AUDIT_VIEW_LIMIT is 120/60s —
    // send enough additional requests to exceed it, sequentially, so each
    // one really does increment the same Redis counter rather than racing.
    let last: request.Response | undefined
    for (let i = 0; i < 125; i++) {
      last = await request(app.getHttpServer())
        .get('/api/audit')
        .set('Authorization', `Bearer ${accessToken}`)
      if (last.status === 429) break
    }

    expect(last?.status).toBe(429)
    expect(last?.body).toMatchObject({
      statusCode: 429,
      error: 'rate_limited',
      message: 'Too many audit reads. Try again later.',
    })
    expect(last?.headers['retry-after']).toEqual(expect.any(String))
  }, 30_000)
})
