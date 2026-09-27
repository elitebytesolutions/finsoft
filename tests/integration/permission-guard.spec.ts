import type { NextFunction, Request, Response } from 'express'
import { Controller, Get, INestApplication, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContext, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { seedSystemRoles } from '@finsoft/permissions'
import { PermissionGuard } from '../../apps/api/src/common/permission.guard.ts'
import { RequirePermission } from '../../apps/api/src/common/permission.decorator.ts'

/*
 * PermissionGuard, exercised through a real Nest application and real HTTP —
 * the same discipline as tests/integration/api-app.spec.ts, and for the same
 * reason: a guard, a status code and a response shape only exist once a
 * request has actually gone through the framework.
 *
 * `packages/auth`'s real guard does not exist yet (m1-auth, forbidden here).
 * The middleware below is a TEST-ONLY stand-in for its documented contract —
 * it reads test-only headers and sets `req.auth` plus `TenantContext`, the
 * two things PermissionGuard depends on and nothing more. It is not, and
 * must never become, an authentication mechanism: it trusts a header
 * precisely because this file controls both ends of the request.
 */

@Controller('probe')
class ProbeController {
  /** No @RequirePermission at all — proves the guard is opt-in, not deny-by-default. */
  @Get('open')
  open() {
    return { reached: true }
  }

  @RequirePermission('voucher.view')
  @Get('vouchers')
  vouchers() {
    return { reached: true }
  }

  @RequirePermission('voucher.post')
  @Get('post-voucher')
  postVoucher() {
    return { reached: true }
  }
}

@Module({
  controllers: [ProbeController],
  providers: [{ provide: APP_GUARD, useClass: PermissionGuard }],
})
class TestAppModule {}

describe('PermissionGuard', () => {
  let app: INestApplication
  let tenant: TenantFixture
  let otherTenant: TenantFixture
  let viewerUserId: string

  beforeAll(async () => {
    await prepareTestDatabase()
    tenant = await createTenantFixture('PGA')
    otherTenant = await createTenantFixture('PGB')

    viewerUserId = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        await seedSystemRoles(tx, tenant.tenantId)

        /*
         * seedSystemRoles only creates the roles and their permission grants
         * (docs/briefs/M1-R-rbac.md) — assigning the Owner role to the
         * tenant's provisioned owner is a provisioning-flow step, not this
         * package's job. Done explicitly here, the way a real provisioning
         * flow would.
         */
        const ownerRole = await tx
          .selectFrom('roles')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'owner')
          .executeTakeFirstOrThrow()

        await tx
          .insertInto('user_roles')
          .values({
            tenant_id: tenant.tenantId,
            user_id: tenant.ownerId,
            role_id: ownerRole.id,
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .execute()

        const viewer = await tx
          .insertInto('users')
          .values({
            tenant_id: tenant.tenantId,
            email: `viewer.${unique()}@example.test`,
            full_name: 'Viewer User',
            status: 'INVITED',
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()

        const viewerRole = await tx
          .selectFrom('roles')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'viewer')
          .executeTakeFirstOrThrow()

        await tx
          .insertInto('user_roles')
          .values({
            tenant_id: tenant.tenantId,
            user_id: viewer.id,
            role_id: viewerRole.id,
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .execute()

        return viewer.id
      }),
    )

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
    app = moduleRef.createNestApplication()

    app.use((req: Request, res: Response, next: NextFunction) => {
      const userId = req.header('x-test-user-id')
      const tenantId = req.header('x-test-tenant-id')
      if (!userId || !tenantId) {
        next()
        return
      }
      ;(req as Request & { auth: { userId: string; tenantId: string } }).auth = {
        userId,
        tenantId,
      }
      TenantContext.run({ tenantId, userId }, () => next())
    })

    await app.init()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await teardownTestDatabase()
  })

  const asAuth = (userId: string, tenantId: string) => ({
    'x-test-user-id': userId,
    'x-test-tenant-id': tenantId,
  })

  describe('a route with no @RequirePermission', () => {
    it('runs the handler whether or not req.auth is present', async () => {
      const noAuth = await request(app.getHttpServer()).get('/probe/open')
      expect(noAuth.status).toBe(200)
      expect(noAuth.body.reached).toBe(true)

      const withAuth = await request(app.getHttpServer())
        .get('/probe/open')
        .set(asAuth(viewerUserId, tenant.tenantId))
      expect(withAuth.status).toBe(200)
    })
  })

  describe('a route with @RequirePermission', () => {
    it('401s when there is no req.auth at all', async () => {
      const res = await request(app.getHttpServer()).get('/probe/vouchers')
      expect(res.status).toBe(401)
    })

    it('200s and runs the handler when the resolved permission set contains the code', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/vouchers')
        .set(asAuth(viewerUserId, tenant.tenantId))
      expect(res.status).toBe(200)
      expect(res.body.reached).toBe(true)
    })

    it('403s with the documented body when the permission is missing (Viewer cannot post a voucher)', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/post-voucher')
        .set(asAuth(viewerUserId, tenant.tenantId))

      expect(res.status).toBe(403)
      expect(res.body).toEqual({
        statusCode: 403,
        error: 'forbidden',
        message: 'You do not have permission to do this.',
      })
    })

    it('200s for the Owner, who holds every MVP permission', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/post-voucher')
        .set(asAuth(tenant.ownerId, tenant.tenantId))
      expect(res.status).toBe(200)
    })

    it('a role granted in tenant A resolves to nothing when presented against tenant B', async () => {
      /*
       * The viewer's user_roles row lives in tenant A. Presenting the SAME
       * user id under tenant B's tenant_id cannot resolve any permission —
       * RLS scopes the resolvePermissions query to whatever tenant
       * TenantContext carries, and the row simply is not there.
       */
      const res = await request(app.getHttpServer())
        .get('/probe/vouchers')
        .set(asAuth(viewerUserId, otherTenant.tenantId))
      expect(res.status).toBe(403)
    })
  })
})
