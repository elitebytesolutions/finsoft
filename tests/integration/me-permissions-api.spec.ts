import type { INestApplication, NestMiddleware } from '@nestjs/common'
import { Injectable, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContext } from '@finsoft/database'
import { migrateTestDatabase, prepareTestDatabase, teardownTestDatabase } from '@finsoft/database/testing'
import { PERMISSION_CODES } from '@finsoft/permissions'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { PermissionGuard } from '../../apps/api/src/common/permission.guard.ts'
import { MeModule } from '../../apps/api/src/me/me.module.ts'
import { createCustomersTenant, type CustomersTenantFixture } from './helpers/customers-fixture.ts'

/*
 * Architecture seat (c) (Council review, 2026-09-29): GET /api/me/permissions
 * (S1, api-contract.md §2 row S1). Same test-only middleware pattern as
 * tests/integration/customers/customers-api.spec.ts.
 */
const TEST_TENANT_HEADER = 'x-test-tenant-id'
const TEST_USER_HEADER = 'x-test-user-id'
const PERM_VERSION_HEADER = 'x-test-permission-version'

@Injectable()
class TestTenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const tenantId = req.header(TEST_TENANT_HEADER)
    const userId = req.header(TEST_USER_HEADER)
    if (!tenantId || !userId) {
      next()
      return
    }
    req.auth = {
      userId,
      tenantId,
      sessionId: 'test-session',
      permissionVersion: Number(req.header(PERM_VERSION_HEADER) ?? '7'),
      mfa: false,
    }
    TenantContext.run({ tenantId, userId }, next)
  }
}

@Module({
  imports: [MeModule],
  providers: [{ provide: APP_GUARD, useClass: PermissionGuard }],
})
class TestAppModule {
  configure(consumer: import('@nestjs/common').MiddlewareConsumer) {
    consumer.apply(TestTenantContextMiddleware).forRoutes('*')
  }
}

let app: INestApplication
let tenant: CustomersTenantFixture

const authHeaders = (tenantId: string, userId: string) => ({
  [TEST_TENANT_HEADER]: tenantId,
  [TEST_USER_HEADER]: userId,
  [PERM_VERSION_HEADER]: '7',
})

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()

  tenant = await createCustomersTenant('MPRM')

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new AllExceptionsFilter())
  await app.init()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await teardownTestDatabase()
})

describe('GET /api/me/permissions (S1)', () => {
  it("200s with the Owner's exact permission codes and the token's permissionVersion", async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me/permissions')
      .set(authHeaders(tenant.tenantId, tenant.ownerId))
      .expect(200)

    expect(res.body.permissionVersion).toBe(7)
    expect([...res.body.permissions].sort()).toEqual([...PERMISSION_CODES].sort())
  })

  it("200s with the Viewer's exact (narrower) permission set — never the Owner's", async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me/permissions')
      .set(authHeaders(tenant.tenantId, tenant.viewerId))
      .expect(200)

    expect([...res.body.permissions].sort()).toEqual(
      ['customer.view', 'report.financial', 'voucher.view'].sort(),
    )
    // The Viewer set is a strict subset — proves this is genuinely THIS
    // caller's own resolved set, not accidentally the Owner's.
    for (const code of res.body.permissions as string[]) {
      expect(PERMISSION_CODES).toContain(code)
    }
    expect(res.body.permissions).not.toContain('customer.create')
    expect(res.body.permissions).not.toContain('admin.user_manage')
  })

  it('returns an empty array for a user with no role at all', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me/permissions')
      .set(authHeaders(tenant.tenantId, tenant.noRoleId))
      .expect(200)

    expect(res.body.permissions).toEqual([])
  })

  it('401s with no session', async () => {
    await request(app.getHttpServer()).get('/api/me/permissions').expect(401)
  })
})
