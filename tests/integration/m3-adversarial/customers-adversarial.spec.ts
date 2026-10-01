import type { NestMiddleware, INestApplication } from '@nestjs/common'
import { Injectable, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContext, withTenant } from '@finsoft/database'
import {
  migrateTestDatabase,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { AllExceptionsFilter } from '../../../apps/api/src/common/all-exceptions.filter.ts'
import { PermissionGuard } from '../../../apps/api/src/common/permission.guard.ts'
import { CustomersModule } from '../../../apps/api/src/customers/customers.module.ts'
import { createCustomersTenant, type CustomersTenantFixture } from '../helpers/customers-fixture.ts'

/*
 * M3-Q's adversarial suite for `modules/customers` and migration 015 —
 * INDEPENDENT of `tests/integration/customers/customers-api.spec.ts` and
 * `database/tests/customers.spec.ts` (M3-C's own tests, which already
 * cover: RLS enabled+forced, cross-tenant INSERT/SELECT refusal at the SQL
 * level, cross-tenant 404-with-identical-body at the API level for every
 * route, and the viewer/no-role RBAC pair). The rule this lane works to
 * (README.md "Why M3-Q is separate"): the author of a module's own tests
 * does not write the check that tries to break it — this file is that
 * check, and it deliberately does NOT re-test what M3-C already proved.
 *
 * New ground covered here:
 *   1. RBAC is INDEPENDENTLY enforced per permission, not "any permission
 *      unlocks everything" — a role holding ONLY customer.create (never
 *      shipped as a system role; built here) must 403 on every READ route,
 *      and a role holding ONLY customer.view must 403 on every WRITE route.
 *   2. Injection-shaped :id values (SQL-injection strings, path traversal,
 *      oversized input) get the SAME CUSTOMER_NOT_FOUND as a well-formed
 *      unknown uuid — never a 500, never a different error shape that
 *      would let an attacker distinguish "malformed" from "doesn't exist".
 *   3. A body that SMUGGLES tenant-crossing or identity fields (`tenantId`,
 *      `id`, `code`, `status`, `version` on create) is refused by the
 *      strict schema, not silently accepted or ignored server-side.
 *   4. Search (`q`) cannot be used to fish for another tenant's customer by
 *      an exact name match.
 *   5. A raw SQL cross-tenant UPDATE ATTEMPT (as finsoft_app, tenant A's
 *      session) against tenant B's customer row — not tested by
 *      database/tests/customers.spec.ts, which tests INSERT and an
 *      immutable-column UPDATE, but not a WRITE ATTEMPT on a mutable field
 *      (name) across tenants.
 */

const TEST_TENANT_HEADER = 'x-test-tenant-id'
const TEST_USER_HEADER = 'x-test-user-id'

@Injectable()
class TestTenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const tenantId = req.header(TEST_TENANT_HEADER)
    const userId = req.header(TEST_USER_HEADER)
    if (!tenantId || !userId) {
      next()
      return
    }
    req.auth = { userId, tenantId, sessionId: 'test-session', permissionVersion: 0, mfa: false }
    TenantContext.run({ tenantId, userId }, next)
  }
}

@Module({
  imports: [CustomersModule],
  providers: [{ provide: APP_GUARD, useClass: PermissionGuard }],
})
class TestAppModule {
  configure(consumer: import('@nestjs/common').MiddlewareConsumer) {
    consumer.apply(TestTenantContextMiddleware).forRoutes('*')
  }
}

let app: INestApplication
let alpha: CustomersTenantFixture
let beta: CustomersTenantFixture
let createOnlyUserId: string
let viewOnlyCustomUserId: string

const authHeaders = (tenantId: string, userId: string) => ({
  [TEST_TENANT_HEADER]: tenantId,
  [TEST_USER_HEADER]: userId,
})
const asOwner = (t: CustomersTenantFixture) => authHeaders(t.tenantId, t.ownerId)

function createBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Adversarial Traders',
    phone: null,
    email: null,
    address: null,
    city: null,
    ntn: null,
    creditDays: 0,
    ...overrides,
  }
}

let keyCounter = 0
function idemKey(): string {
  keyCounter += 1
  return `cust-adv-${keyCounter}-${Date.now()}`
}

/** A custom role holding EXACTLY the given permission codes — no system role provides "create only" or an isolated single permission. */
async function createCustomRoleUser(
  tenant: TenantFixture,
  roleCode: string,
  permissions: readonly string[],
): Promise<string> {
  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant(async (tx) => {
      const role = await tx
        .insertInto('roles')
        .values({
          tenant_id: tenant.tenantId,
          code: roleCode,
          name: roleCode,
          is_system: false,
          created_by: tenant.ownerId,
          updated_by: tenant.ownerId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      for (const code of permissions) {
        await tx
          .insertInto('role_permissions')
          .values({
            tenant_id: tenant.tenantId,
            role_id: role.id,
            permission_code: code,
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .execute()
      }

      const user = await tx
        .insertInto('users')
        .values({
          tenant_id: tenant.tenantId,
          email: `${roleCode}.${unique()}@example.test`,
          full_name: `${roleCode} user`,
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
          user_id: user.id,
          role_id: role.id,
          created_by: tenant.ownerId,
          updated_by: tenant.ownerId,
        })
        .execute()

      return user.id
    }),
  )
}

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()

  alpha = await createCustomersTenant('ADVA')
  beta = await createCustomersTenant('ADVB')
  createOnlyUserId = await createCustomRoleUser(alpha, 'create_only', ['customer.create'])
  viewOnlyCustomUserId = await createCustomRoleUser(alpha, 'view_only_custom', ['customer.view'])

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

describe('RBAC: customer.view and customer.create are independently enforced', () => {
  it('customer.create alone: every READ route 403s', async () => {
    const headers = authHeaders(alpha.tenantId, createOnlyUserId)
    await request(app.getHttpServer()).get('/api/customers').set(headers).expect(403)
    const created = await request(app.getHttpServer())
      .post('/api/customers')
      .set(headers)
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'Create Only Probe' }))
      .expect(201)
    await request(app.getHttpServer())
      .get(`/api/customers/${created.body.id}`)
      .set(headers)
      .expect(403)
    await request(app.getHttpServer())
      .get(`/api/customers/${created.body.id}/ledger`)
      .set(headers)
      .expect(403)
  })

  it('customer.view alone: every WRITE route 403s', async () => {
    const headers = authHeaders(alpha.tenantId, viewOnlyCustomUserId)
    await request(app.getHttpServer())
      .post('/api/customers')
      .set(headers)
      .set('Idempotency-Key', idemKey())
      .send(createBody())
      .expect(403)

    // A real target so the 403 is proven to be about permission, not existence.
    const target = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'View Only Target' }))
      .expect(201)

    await request(app.getHttpServer())
      .patch(`/api/customers/${target.body.id}`)
      .set(headers)
      .send({ version: target.body.version, name: 'Should not apply' })
      .expect(403)
    await request(app.getHttpServer())
      .post(`/api/customers/${target.body.id}/deactivate`)
      .set(headers)
      .send({ version: target.body.version })
      .expect(403)
    await request(app.getHttpServer())
      .post(`/api/customers/${target.body.id}/reactivate`)
      .set(headers)
      .send({ version: target.body.version })
      .expect(403)

    // And the write genuinely did not happen.
    const stillThere = await request(app.getHttpServer())
      .get(`/api/customers/${target.body.id}`)
      .set(asOwner(alpha))
      .expect(200)
    expect(stillThere.body.name).toBe('View Only Target')
    expect(stillThere.body.status).toBe('ACTIVE')
  })
})

describe('injection-shaped :id values get the same answer as a well-formed unknown id', () => {
  const ADVERSARIAL_IDS = [
    "' OR '1'='1",
    "'; DROP TABLE customers; --",
    '../../../etc/passwd',
    '00000000-0000-0000-0000-000000000000\u0000',
    'x'.repeat(5000),
    '%00',
    '<script>alert(1)</script>',
  ]

  it.each(ADVERSARIAL_IDS)('GET /api/customers/:id with %j never 500s, never leaks', async (id) => {
    const res = await request(app.getHttpServer())
      .get(`/api/customers/${encodeURIComponent(id)}`)
      .set(asOwner(alpha))
    expect(
      res.status,
      `id=${JSON.stringify(id)}: status ${res.status}, body ${JSON.stringify(res.body)}`,
    ).toBe(404)
    expect(res.body.error).toBe('customer_not_found')
  })

  it.each(ADVERSARIAL_IDS)('PATCH /api/customers/:id with %j never 500s', async (id) => {
    const res = await request(app.getHttpServer())
      .patch(`/api/customers/${encodeURIComponent(id)}`)
      .set(asOwner(alpha))
      .send({ version: 0, name: 'x' })
    expect(res.status).toBe(404)
  })
})

describe('a request body cannot smuggle identity or tenant-crossing fields (strict schema)', () => {
  it.each(['tenantId', 'id', 'code', 'status', 'createdBy', 'balance'])(
    'POST /api/customers rejects an unexpected field "%s"',
    async (field) => {
      const res = await request(app.getHttpServer())
        .post('/api/customers')
        .set(asOwner(alpha))
        .set('Idempotency-Key', idemKey())
        .send({ ...createBody(), [field]: 'attacker-supplied' })
        .expect(400)
      expect(res.body.error).toBe('validation_failed')
    },
  )

  it('sending a real tenant id as tenantId in the body has no effect on which tenant the customer is created in', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ ...createBody(), tenantId: beta.tenantId })
      .expect(400)
    expect(res.body.error).toBe('validation_failed')
  })
})

describe("search cannot be used to fish for another tenant's customer", () => {
  it('an exact-name search for a beta-only customer returns nothing to alpha', async () => {
    const uniqueName = `Beta Secret Co ${unique()}`
    await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(beta))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: uniqueName }))
      .expect(201)

    const res = await request(app.getHttpServer())
      .get('/api/customers')
      .query({ q: uniqueName })
      .set(asOwner(alpha))
      .expect(200)
    expect(res.body.items).toEqual([])
  })
})

describe('a raw cross-tenant UPDATE attempt, as finsoft_app, is silently a no-op (not tested by database/tests/customers.spec.ts, which covers INSERT and immutable columns only)', () => {
  it("tenant A cannot change a mutable field (name) on tenant B's customer row", async () => {
    const target = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(beta))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'Untouchable Beta Customer' }))
      .expect(201)

    const affected = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        tx
          .updateTable('customers')
          .set({ name: 'pwned', version: 1 })
          .where('id', '=', target.body.id)
          .executeTakeFirst(),
      ),
    )
    expect(Number(affected.numUpdatedRows)).toBe(0)

    const stillThere = await request(app.getHttpServer())
      .get(`/api/customers/${target.body.id}`)
      .set(asOwner(beta))
      .expect(200)
    expect(stillThere.body.name).toBe('Untouchable Beta Customer')
    expect(stillThere.body.version).toBe(0)
  })
})
