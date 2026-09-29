import type { NestMiddleware, INestApplication } from '@nestjs/common'
import { Injectable, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listAuditEvents, TenantContext, withTenant } from '@finsoft/database'
import {
  migrateTestDatabase,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { AllExceptionsFilter } from '../../../apps/api/src/common/all-exceptions.filter.ts'
import { PermissionGuard } from '../../../apps/api/src/common/permission.guard.ts'
import { CustomersModule } from '../../../apps/api/src/customers/customers.module.ts'
import { createCustomersTenant, type CustomersTenantFixture } from '../helpers/customers-fixture.ts'

/*
 * The customers HTTP API, over real HTTP against real PostgreSQL.
 * docs/design/M3/api-contract.md §2, §4.1; docs/design/M3/modules.md §8, §9.
 *
 * Same test-only middleware pattern as tests/integration/accounting-api.spec.ts:
 * packages/auth's real login flow is outside this lane's ALLOWED paths, so a
 * middleware sets req.auth + TenantContext from test-only headers, standing
 * in for TenantGuard. PermissionGuard itself is real and registered exactly
 * as app.module.ts registers it, so every RBAC assertion here is the real
 * guard.
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
    req.auth = {
      userId,
      tenantId,
      sessionId: 'test-session',
      permissionVersion: 0,
      mfa: false,
    }
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

const authHeaders = (tenantId: string, userId: string) => ({
  [TEST_TENANT_HEADER]: tenantId,
  [TEST_USER_HEADER]: userId,
})
const asOwner = (t: CustomersTenantFixture) => authHeaders(t.tenantId, t.ownerId)
const asViewer = (t: CustomersTenantFixture) => authHeaders(t.tenantId, t.viewerId)
const asNoRole = (t: CustomersTenantFixture) => authHeaders(t.tenantId, t.noRoleId)

function createBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Acme Traders',
    phone: '0300-1234567',
    email: 'ap@acme.test',
    address: '12 Mall Road',
    city: 'Lahore',
    ntn: '1234567-8',
    creditDays: 30,
    ...overrides,
  }
}

let keyCounter = 0
function idemKey(): string {
  keyCounter += 1
  return `cust-test-${keyCounter}-${Date.now()}`
}

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()

  alpha = await createCustomersTenant('MCPA')
  beta = await createCustomersTenant('MCPB')

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

describe('POST /api/customers', () => {
  it('creates a customer with a system-generated CUST-000001 code, and registers a party in the same transaction', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'First Customer' }))
      .expect(201)

    expect(res.body.code).toMatch(/^CUST-\d{6}$/)
    expect(res.body.status).toBe('ACTIVE')
    expect(res.body.balance).toBe('0.0000')
    expect(res.body.version).toBe(0)
    expect(res.body.id).toBeTruthy()

    const partyRow = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        tx
          .selectFrom('parties')
          .select(['id', 'party_type'])
          .where('id', '=', res.body.id)
          .executeTakeFirst(),
      ),
    )
    expect(partyRow).toBeDefined()
    expect(partyRow?.party_type).toBe('CUSTOMER')
  })

  it('assigns sequential codes per tenant', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(beta))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'Beta Customer One' }))
      .expect(201)
    const second = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(beta))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'Beta Customer Two' }))
      .expect(201)

    const firstN = Number(first.body.code.split('-')[1])
    const secondN = Number(second.body.code.split('-')[1])
    expect(secondN).toBe(firstN + 1)
  })

  it('rejects a request with no Idempotency-Key header', async () => {
    await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .send(createBody())
      .expect(400)
  })

  it('rejects an unknown field with VALIDATION_FAILED (strict schema)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ ...createBody(), code: 'CUST-999999' })
      .expect(400)
    expect(res.body.error).toBe('validation_failed')
  })

  it('replays an identical request under the same key, one customer', async () => {
    const key = idemKey()
    const body = createBody({ name: 'Replay Customer' })
    const first = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201)
    const second = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201)

    expect(second.body.id).toBe(first.body.id)
    expect(second.body.code).toBe(first.body.code)
  })

  it('rejects the same key reused with a different body', async () => {
    const key = idemKey()
    await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', key)
      .send(createBody({ name: 'Original Name' }))
      .expect(201)

    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', key)
      .send(createBody({ name: 'Different Name' }))
      .expect(409)
    expect(res.body.error).toBe('idempotency_key_reused')
  })

  it('writes a customer.created audit record', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'Audited Customer' }))
      .expect(201)

    const events = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        listAuditEvents(tx, { entityType: 'customer', entityId: res.body.id, limit: 10 }),
      ),
    )
    const created = events.items.find((e) => e.action === 'CUSTOMER_CREATED')
    expect(created).toBeDefined()
    expect(created?.beforeJson).toBeNull()
    expect((created?.afterJson as { code: string }).code).toBe(res.body.code)
  })

  it('403s without customer.create (viewer)', async () => {
    await request(app.getHttpServer())
      .post('/api/customers')
      .set(asViewer(alpha))
      .set('Idempotency-Key', idemKey())
      .send(createBody())
      .expect(403)
  })

  it('403s with no permission at all', async () => {
    await request(app.getHttpServer())
      .post('/api/customers')
      .set(asNoRole(alpha))
      .set('Idempotency-Key', idemKey())
      .send(createBody())
      .expect(403)
  })

  it('401s with no session', async () => {
    await request(app.getHttpServer())
      .post('/api/customers')
      .set('Idempotency-Key', idemKey())
      .send(createBody())
      .expect(401)
  })
})

describe('GET /api/customers', () => {
  it('lists customers ordered by code, and the viewer role can read', async () => {
    await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'List Test Customer' }))
      .expect(201)

    const res = await request(app.getHttpServer())
      .get('/api/customers')
      .set(asViewer(alpha))
      .expect(200)

    expect(Array.isArray(res.body.items)).toBe(true)
    expect(res.body.items.length).toBeGreaterThan(0)
    const codes = res.body.items.map((i: { code: string }) => i.code)
    expect([...codes].sort()).toEqual(codes)
  })

  it('filters by q (name substring, case-insensitive)', async () => {
    await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'Zephyr Traders' }))
      .expect(201)

    const res = await request(app.getHttpServer())
      .get('/api/customers')
      .query({ q: 'zephyr' })
      .set(asOwner(alpha))
      .expect(200)

    expect(res.body.items.length).toBeGreaterThan(0)
    expect(res.body.items.every((i: { name: string }) => /zephyr/i.test(i.name))).toBe(true)
  })

  it('403s for a user with no customer.view', async () => {
    await request(app.getHttpServer()).get('/api/customers').set(asNoRole(alpha)).expect(403)
  })

  it("never returns another tenant's customer in the list (tenant isolation, rule 8)", async () => {
    const betaOnly = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(beta))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'Beta Isolation Target' }))
      .expect(201)

    const res = await request(app.getHttpServer())
      .get('/api/customers')
      .set(asOwner(alpha))
      .expect(200)

    expect(res.body.items.some((i: { id: string }) => i.id === betaOnly.body.id)).toBe(false)
  })
})

describe('GET /api/customers/:id', () => {
  it('returns 404 for an unknown id', async () => {
    await request(app.getHttpServer())
      .get('/api/customers/00000000-0000-0000-0000-000000000000')
      .set(asOwner(alpha))
      .expect(404)
  })

  it("returns 404 for another tenant's id — same body as unknown", async () => {
    const created = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(beta))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name: 'Beta Only Customer' }))
      .expect(201)

    const unknown = await request(app.getHttpServer())
      .get('/api/customers/00000000-0000-0000-0000-000000000000')
      .set(asOwner(alpha))
      .expect(404)
    const crossTenant = await request(app.getHttpServer())
      .get(`/api/customers/${created.body.id}`)
      .set(asOwner(alpha))
      .expect(404)

    expect(crossTenant.body.error).toBe(unknown.body.error)
  })
})

describe('PATCH /api/customers/:id', () => {
  async function createOne(name: string) {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name }))
      .expect(201)
    return res.body
  }

  it('edits name and contact fields, code and status untouched', async () => {
    const customer = await createOne('Editable Customer')

    const res = await request(app.getHttpServer())
      .patch(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .send({ version: customer.version, name: 'Renamed Customer', city: 'Karachi' })
      .expect(200)

    expect(res.body.name).toBe('Renamed Customer')
    expect(res.body.city).toBe('Karachi')
    expect(res.body.code).toBe(customer.code)
    expect(res.body.status).toBe('ACTIVE')
    expect(res.body.version).toBe(customer.version + 1)
  })

  it('409s on a stale version', async () => {
    const customer = await createOne('Stale Version Customer')

    await request(app.getHttpServer())
      .patch(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .send({ version: customer.version, name: 'First Edit' })
      .expect(200)

    const res = await request(app.getHttpServer())
      .patch(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .send({ version: customer.version, name: 'Second Edit (stale)' })
      .expect(409)
    expect(res.body.error).toBe('version_conflict')
    expect(res.body.details.currentVersion).toBe(customer.version + 1)
  })

  it('writes a customer.updated audit record with only the changed fields', async () => {
    const customer = await createOne('Audit Edit Customer')

    await request(app.getHttpServer())
      .patch(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .send({ version: customer.version, city: 'Islamabad' })
      .expect(200)

    const events = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        listAuditEvents(tx, { entityType: 'customer', entityId: customer.id, limit: 10 }),
      ),
    )
    const updated = events.items.find((e) => e.action === 'CUSTOMER_UPDATED')
    expect(updated).toBeDefined()
    expect(Object.keys(updated?.beforeJson as object)).toEqual(['city'])
    expect((updated?.afterJson as { city: string }).city).toBe('Islamabad')
  })

  it('403s without customer.create (viewer)', async () => {
    const customer = await createOne('RBAC Edit Customer')
    await request(app.getHttpServer())
      .patch(`/api/customers/${customer.id}`)
      .set(asViewer(alpha))
      .send({ version: customer.version, name: 'Should not apply' })
      .expect(403)
  })

  it("404s for another tenant's id", async () => {
    const betaCustomer = (
      await request(app.getHttpServer())
        .post('/api/customers')
        .set(asOwner(beta))
        .set('Idempotency-Key', idemKey())
        .send(createBody({ name: 'Beta Edit Target' }))
        .expect(201)
    ).body

    await request(app.getHttpServer())
      .patch(`/api/customers/${betaCustomer.id}`)
      .set(asOwner(alpha))
      .send({ version: 0, name: 'Should not apply' })
      .expect(404)
  })
})

describe('POST /api/customers/:id/deactivate and /reactivate', () => {
  async function createOne(name: string) {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send(createBody({ name }))
      .expect(201)
    return res.body
  }

  it('deactivates a zero-balance customer and writes an audit record', async () => {
    const customer = await createOne('Deactivate Me')

    const res = await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/deactivate`)
      .set(asOwner(alpha))
      .send({ version: customer.version })
      .expect(200)
    expect(res.body.status).toBe('INACTIVE')
    expect(res.body.version).toBe(customer.version + 1)

    const events = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        listAuditEvents(tx, { entityType: 'customer', entityId: customer.id, limit: 10 }),
      ),
    )
    expect(events.items.some((e) => e.action === 'CUSTOMER_DEACTIVATED')).toBe(true)
  })

  it('is a no-op success deactivating an already-INACTIVE customer', async () => {
    const customer = await createOne('Double Deactivate')
    const first = await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/deactivate`)
      .set(asOwner(alpha))
      .send({ version: customer.version })
      .expect(200)

    const second = await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/deactivate`)
      .set(asOwner(alpha))
      .send({ version: first.body.version })
      .expect(200)
    expect(second.body.status).toBe('INACTIVE')
    expect(second.body.version).toBe(first.body.version)
  })

  it('reactivates and writes an audit record', async () => {
    const customer = await createOne('Reactivate Me')
    const deactivated = await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/deactivate`)
      .set(asOwner(alpha))
      .send({ version: customer.version })
      .expect(200)

    const res = await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/reactivate`)
      .set(asOwner(alpha))
      .send({ version: deactivated.body.version })
      .expect(200)
    expect(res.body.status).toBe('ACTIVE')

    const events = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        listAuditEvents(tx, { entityType: 'customer', entityId: customer.id, limit: 10 }),
      ),
    )
    expect(events.items.some((e) => e.action === 'CUSTOMER_REACTIVATED')).toBe(true)
  })

  it('403s without customer.create (viewer), for both routes', async () => {
    const customer = await createOne('RBAC Status Customer')
    await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/deactivate`)
      .set(asViewer(alpha))
      .send({ version: customer.version })
      .expect(403)
    await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/reactivate`)
      .set(asViewer(alpha))
      .send({ version: customer.version })
      .expect(403)
  })

  it("404s for another tenant's id, for both routes (S5)", async () => {
    const betaCustomer = (
      await request(app.getHttpServer())
        .post('/api/customers')
        .set(asOwner(beta))
        .set('Idempotency-Key', idemKey())
        .send(createBody({ name: 'Beta Status Target' }))
        .expect(201)
    ).body

    await request(app.getHttpServer())
      .post(`/api/customers/${betaCustomer.id}/deactivate`)
      .set(asOwner(alpha))
      .send({ version: 0 })
      .expect(404)
    await request(app.getHttpServer())
      .post(`/api/customers/${betaCustomer.id}/reactivate`)
      .set(asOwner(alpha))
      .send({ version: 0 })
      .expect(404)
  })
})

describe('GET /api/customers/:id/ledger', () => {
  it('returns an empty, zero-balance ledger for a customer with no postings', async () => {
    const customer = (
      await request(app.getHttpServer())
        .post('/api/customers')
        .set(asOwner(alpha))
        .set('Idempotency-Key', idemKey())
        .send(createBody({ name: 'Ledger Customer' }))
        .expect(201)
    ).body

    const res = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}/ledger`)
      .set(asOwner(alpha))
      .expect(200)

    expect(res.body.openingBalance).toBe('0.0000')
    expect(res.body.closingBalance).toBe('0.0000')
    expect(res.body.lines).toEqual([])
    expect(res.body.customer.id).toBe(customer.id)
  })

  it('404s for an unknown id', async () => {
    await request(app.getHttpServer())
      .get('/api/customers/00000000-0000-0000-0000-000000000000/ledger')
      .set(asOwner(alpha))
      .expect(404)
  })

  it("404s for another tenant's id", async () => {
    const betaCustomer = (
      await request(app.getHttpServer())
        .post('/api/customers')
        .set(asOwner(beta))
        .set('Idempotency-Key', idemKey())
        .send(createBody({ name: 'Beta Ledger Target' }))
        .expect(201)
    ).body

    await request(app.getHttpServer())
      .get(`/api/customers/${betaCustomer.id}/ledger`)
      .set(asOwner(alpha))
      .expect(404)
  })

  it('422s a range over 366 days', async () => {
    const customer = (
      await request(app.getHttpServer())
        .post('/api/customers')
        .set(asOwner(alpha))
        .set('Idempotency-Key', idemKey())
        .send(createBody({ name: 'Range Customer' }))
        .expect(201)
    ).body

    const res = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}/ledger`)
      .query({ from: '2020-01-01', to: '2027-01-01' })
      .set(asOwner(alpha))
      .expect(422)
    expect(res.body.error).toBe('ledger_range_too_large')
  })
})
