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

  /** SEC-C3: a caller mistake, not "no requirement". */
  @RequirePermission()
  @Get('empty-requirement')
  emptyRequirement() {
    return { reached: true }
  }
}

/**
 * A second controller with a CLASS-level requirement, to prove
 * handler-level and class-level decorators COMBINE (SEC-C3) rather than the
 * closer one overriding the other.
 */
@RequirePermission('customer.view')
@Controller('combined')
class CombinedController {
  @RequirePermission('voucher.post')
  @Get('both-required')
  bothRequired() {
    return { reached: true }
  }
}

@Module({
  controllers: [ProbeController, CombinedController],
  providers: [{ provide: APP_GUARD, useClass: PermissionGuard }],
})
class TestAppModule {}

describe('PermissionGuard', () => {
  let app: INestApplication
  let tenant: TenantFixture
  let otherTenant: TenantFixture
  let viewerUserId: string
  let suspendedUserId: string

  beforeAll(async () => {
    await prepareTestDatabase()
    tenant = await createTenantFixture('PGA')
    otherTenant = await createTenantFixture('PGB')

    ;[viewerUserId, suspendedUserId] = await runAs(
      { tenantId: tenant.tenantId, userId: tenant.ownerId },
      () =>
        withTenant(async (tx) => {
          await seedSystemRoles(tx, tenant.tenantId)

          /*
           * seedSystemRoles only creates the roles and their permission
           * grants (docs/briefs/M1-R-rbac.md) — assigning the Owner role to
           * the tenant's provisioned owner is a provisioning-flow step, not
           * this package's job. Done explicitly here, the way a real
           * provisioning flow would.
           *
           * The fixture's provisioned owner is INVITED by default
           * (packages/database/src/testing/harness.ts, outside this lane's
           * ALLOWED paths) — activated here, in this test, rather than by
           * changing the shared harness, so SEC-C4's ACTIVE gate has a
           * positive case to exercise.
           */
          await tx
            .updateTable('users')
            .set({ status: 'ACTIVE', password_hash: 'test-hash-not-real', version: 1 })
            .where('tenant_id', '=', tenant.tenantId)
            .where('id', '=', tenant.ownerId)
            .execute()

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

          const viewerRole = await tx
            .selectFrom('roles')
            .select('id')
            .where('tenant_id', '=', tenant.tenantId)
            .where('code', '=', 'viewer')
            .executeTakeFirstOrThrow()

          const viewer = await tx
            .insertInto('users')
            .values({
              tenant_id: tenant.tenantId,
              email: `viewer.${unique()}@example.test`,
              full_name: 'Viewer User',
              status: 'ACTIVE',
              password_hash: 'test-hash-not-real',
              created_by: tenant.ownerId,
              updated_by: tenant.ownerId,
            })
            .returning('id')
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

          // SEC-C4: a SUSPENDED user, otherwise identical to the Owner
          // (same role, same permissions on paper), to prove status gates
          // resolution regardless of role.
          const suspended = await tx
            .insertInto('users')
            .values({
              tenant_id: tenant.tenantId,
              email: `suspended.${unique()}@example.test`,
              full_name: 'Suspended Owner',
              status: 'SUSPENDED',
              created_by: tenant.ownerId,
              updated_by: tenant.ownerId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()

          await tx
            .insertInto('user_roles')
            .values({
              tenant_id: tenant.tenantId,
              user_id: suspended.id,
              role_id: ownerRole.id,
              created_by: tenant.ownerId,
              updated_by: tenant.ownerId,
            })
            .execute()

          return [viewer.id, suspended.id]
        }),
    )

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
    app = moduleRef.createNestApplication()

    /*
     * Test-only stand-in for the real auth guard's contract. Three extra,
     * test-only headers let individual cases exercise SEC-C6 without a real
     * TenantContext-establishing guard existing yet:
     *
     *   x-test-no-context           req.auth is set; TenantContext never is.
     *   x-test-context-user-id      overrides the userId TenantContext.run
     *   x-test-context-tenant-id    receives, independent of req.auth's.
     */
    app.use((req: Request, res: Response, next: NextFunction) => {
      const userId = req.header('x-test-user-id')
      const tenantId = req.header('x-test-tenant-id')
      if (!userId || !tenantId) {
        next()
        return
      }
      /*
       * `unknown` first, not `Request & {...}`: Request.auth is declared as
       * the full AuthContext (apps/api/src/common/tenant.guard.ts, landed
       * after this file was first written against the narrower RequestAuth
       * shape) — intersecting types the way this cast previously did makes
       * TS require an object satisfying BOTH shapes. Going through
       * `unknown` replaces the type for this expression instead of adding
       * to it; `req` elsewhere in this handler is still the real `Request`.
       */
      ;(req as unknown as { auth: { userId: string; tenantId: string } }).auth = {
        userId,
        tenantId,
      }

      if (req.header('x-test-no-context') === '1') {
        next()
        return
      }

      const contextUserId = req.header('x-test-context-user-id') ?? userId
      const contextTenantId = req.header('x-test-context-tenant-id') ?? tenantId
      TenantContext.run({ tenantId: contextTenantId, userId: contextUserId }, () => next())
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

  describe('SEC-C4: a non-ACTIVE user resolves to no permissions', () => {
    it('403s a SUSPENDED user who holds the Owner role', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/post-voucher')
        .set(asAuth(suspendedUserId, tenant.tenantId))
      expect(res.status).toBe(403)
    })
  })

  describe('SEC-C3: an empty @RequirePermission() is a configuration mistake', () => {
    it('never silently passes; it fails loudly instead', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/empty-requirement')
        .set(asAuth(tenant.ownerId, tenant.tenantId))
      expect(res.status).toBe(500)
      expect(res.body.reached).toBeUndefined()
    })
  })

  describe('SEC-C3: handler- and class-level requirements combine', () => {
    it('403s a user who holds only the class-level permission', async () => {
      // Owner holds customer.view (the class requirement) but the ROUTE also
      // requires voucher.post — Owner holds that too, so use the Viewer
      // instead, who holds customer.view and not voucher.post.
      const res = await request(app.getHttpServer())
        .get('/combined/both-required')
        .set(asAuth(viewerUserId, tenant.tenantId))
      expect(res.status).toBe(403)
    })

    it('200s a user who holds both the class- and handler-level permission', async () => {
      const res = await request(app.getHttpServer())
        .get('/combined/both-required')
        .set(asAuth(tenant.ownerId, tenant.tenantId))
      expect(res.status).toBe(200)
    })
  })

  describe('M1-X C5: PermissionGuard establishes its own tenant context, independent of any ambient one', () => {
    /*
     * Superseded SEC-C6. Under the pre-M1-X architecture, TenantContext was
     * established ad hoc by whatever ran before the guard, and PermissionGuard
     * only VERIFIED it agreed with req.auth. Under C5, the request-wide
     * TenantContext is established by an INTERCEPTOR (tenant-context.interceptor.ts)
     * that runs strictly after every guard — PermissionGuard, itself a guard,
     * can never depend on it having already run (see permission.guard.ts's own
     * header). It establishes its OWN scoped context instead, via
     * withTenantAsPrincipal, sourced only from req.auth — so it now resolves
     * correctly with NO ambient context at all, and is immune to an ambient
     * context that (however it got there) disagrees with req.auth.
     */
    it('resolves correctly with no ambient TenantContext at all', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/vouchers')
        .set({ ...asAuth(viewerUserId, tenant.tenantId), 'x-test-no-context': '1' })
      expect(res.status).toBe(200)
    })

    it('ignores an ambient TenantContext naming a different tenant than req.auth', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/vouchers')
        .set({
          ...asAuth(viewerUserId, tenant.tenantId),
          'x-test-context-tenant-id': otherTenant.tenantId,
        })
      expect(res.status).toBe(200)
    })

    it('ignores an ambient TenantContext naming a different user than req.auth', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/vouchers')
        .set({
          ...asAuth(viewerUserId, tenant.tenantId),
          'x-test-context-user-id': tenant.ownerId,
        })
      expect(res.status).toBe(200)
    })

    it('still 401s with no req.auth at all — there is no context to fall back to', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/vouchers')
        .set({ 'x-test-no-context': '1' })
      expect(res.status).toBe(401)
    })
  })
})
