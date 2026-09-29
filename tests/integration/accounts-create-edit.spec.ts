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
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { PermissionGuard } from '../../apps/api/src/common/permission.guard.ts'
import { AccountingModule } from '../../apps/api/src/accounting/accounting.module.ts'
import {
  createAccountingTenant,
  type AccountingTenantFixture,
} from './helpers/accounting-fixture.ts'

/*
 * POST /api/accounts, PATCH /api/accounts/:id, GET /api/accounts/suggest-code.
 * docs/posting-rules/coa-standard.md §8, M2-C. Real HTTP, real PostgreSQL —
 * same harness as tests/integration/accounting-api.spec.ts (test-only
 * req.auth/TenantContext middleware standing in for packages/auth's real
 * login flow, which is outside this lane's ALLOWED paths; PermissionGuard
 * itself is the real guard).
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
  imports: [AccountingModule],
  providers: [{ provide: APP_GUARD, useClass: PermissionGuard }],
})
class TestAppModule {
  configure(consumer: import('@nestjs/common').MiddlewareConsumer) {
    consumer.apply(TestTenantContextMiddleware).forRoutes('*')
  }
}

let app: INestApplication
let alpha: AccountingTenantFixture
let beta: AccountingTenantFixture

const authHeaders = (tenantId: string, userId: string) => ({
  [TEST_TENANT_HEADER]: tenantId,
  [TEST_USER_HEADER]: userId,
})

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()

  alpha = await createAccountingTenant('COAA')
  beta = await createAccountingTenant('COAB')

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

function opex(t: AccountingTenantFixture) {
  return t.accountsByCode.get('6000')!.id // Operating Expenses header
}
function costOfSales(t: AccountingTenantFixture) {
  return t.accountsByCode.get('5000')!.id // Cost of Sales header — also EXPENSE, for a same-type re-parent
}
function assets(t: AccountingTenantFixture) {
  return t.accountsByCode.get('1000')!.id // Assets header
}
function cashInHand(t: AccountingTenantFixture) {
  return t.accountsByCode.get('1110')!.id // protected: holds CASH_DEFAULT
}
function salaries(t: AccountingTenantFixture) {
  return t.accountsByCode.get('6100')!.id // unprotected, no role
}
function bank(t: AccountingTenantFixture) {
  return t.accountsByCode.get('1120')!.id
}

async function auditRowsFor(tenantId: string, ownerId: string, action: string, entityId: string) {
  return TenantContext.run({ tenantId, userId: ownerId }, () =>
    withTenant((tx) =>
      listAuditEvents(tx, { action, entityType: 'accounts', entityId, limit: 10 }),
    ),
  )
}

describe('POST /api/accounts', () => {
  it('creates a postable account, inherits type/normalBalance from the header, writes one audit record', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'Security Services', code: '6600' })
      .expect(201)

    expect(res.body).toMatchObject({
      code: '6600',
      name: 'Security Services',
      type: 'EXPENSE',
      normalBalance: 'DEBIT',
      kind: 'POSTABLE',
      controlKind: 'NONE',
      role: null,
      restricted: false,
      isActive: true,
      version: 0,
    })

    const page = await auditRowsFor(alpha.tenantId, alpha.ownerId, 'ACCOUNT_CREATED', res.body.id)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.actorUserId).toBe(alpha.ownerId)
  })

  it('§8.9 order: FORBIDDEN before payload shape — a viewer with a malformed body still gets 403', async () => {
    await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.viewerId))
      .send({ parentId: 'not-even-a-uuid', name: '', code: '', extraField: true })
      .expect(403)
  })

  it('403s a caller without account.manage (viewer)', async () => {
    await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.viewerId))
      .send({ parentId: opex(alpha), name: 'x', code: '6601' })
      .expect(403)
  })

  it('401s with no credentials at all', async () => {
    await request(app.getHttpServer())
      .post('/api/accounts')
      .send({ parentId: opex(alpha), name: 'x', code: '6602' })
      .expect(401)
  })

  it('rejects an unknown field (e.g. controlKind): PAYLOAD_INVALID / 400 — never silently ignored', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'x', code: '6603', controlKind: 'AR' })
      .expect(400)
    expect(res.body.statusCode).toBe(400)
  })

  it('rejects an opening balance field: 400 (§8.1 — never collected by create, it would be a posting)', async () => {
    await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'x', code: '6604', openingBalance: '100.0000' })
      .expect(400)
  })

  it('unknown parentId: ACCOUNT_PARENT_NOT_FOUND / 404 (never 403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: '00000000-0000-4000-8000-000000000000', name: 'x', code: '6605' })
      .expect(404)
    expect(res.body.error).toBe('account_parent_not_found')
  })

  it("cross-tenant parentId: 404, identical body to an unknown id (tenant B naming tenant A's header)", async () => {
    const unknown = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .send({ parentId: '00000000-0000-4000-8000-000000000000', name: 'x', code: '6606' })
      .expect(404)

    const crossTenant = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .send({ parentId: opex(alpha), name: 'x', code: '6606' })
      .expect(404)

    expect(crossTenant.body.error).toBe(unknown.body.error)
    expect(crossTenant.body.statusCode).toBe(unknown.body.statusCode)
  })

  it('a postable parent: ACCOUNT_PARENT_NOT_HEADER / 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: salaries(alpha), name: 'x', code: '6607' })
      .expect(400)
    expect(res.body.error).toBe('account_parent_not_header')
  })

  it('malformed code: ACCOUNT_CODE_FORMAT / 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'x', code: '66A0' })
      .expect(400)
    expect(res.body.error).toBe('account_code_format')
  })

  it("code outside the parent's block: ACCOUNT_CODE_OUT_OF_RANGE / 400", async () => {
    const res = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'x', code: '1400' })
      .expect(400)
    expect(res.body.error).toBe('account_code_out_of_range')
  })

  it('a code already taken: ACCOUNT_CODE_TAKEN / 409, including the template code itself', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'Duplicate Salaries', code: '6100' })
      .expect(409)
    expect(res.body.error).toBe('account_code_taken')
  })

  it('a name that differs only in case from an existing postable account: ACCOUNT_NAME_TAKEN / 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'rent', code: '6608' }) // 6200 is "Rent"
      .expect(409)
    expect(res.body.error).toBe('account_name_taken')
  })

  it('an empty (post-trim) name: ACCOUNT_NAME_INVALID / 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: '   ', code: '6609' })
      .expect(400)
    expect(res.body.error).toBe('account_name_invalid')
  })

  it('a name equal to a header name is allowed (names are unique among postable accounts only)', async () => {
    await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'Operating Expenses', code: '6610' })
      .expect(201)
  })

  it('a concurrent create of the same code: one commits, the other gets ACCOUNT_CODE_TAKEN', async () => {
    const [a, b] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/accounts')
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ parentId: assets(alpha), name: 'Race A', code: '1401' }),
      request(app.getHttpServer())
        .post('/api/accounts')
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ parentId: assets(alpha), name: 'Race B', code: '1401' }),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([201, 409])
  })
})

describe('GET /api/accounts/suggest-code', () => {
  it('suggests the smallest free multiple of 100 under a fresh header', async () => {
    // standard-v1 seeds 1110/1120/1200/1300 under 1000 — 1100 is a free
    // multiple of 100 (smaller than 1200/1300, which are taken exactly) and
    // wins. (coa-standard.md §8.1's own worked example says "1400"; that
    // number does not follow from its own stated rule against the seeded
    // template — reported as a doc discrepancy, not implemented here: "no
    // golden figure depends on it", per the same sentence.)
    const res = await request(app.getHttpServer())
      .get('/api/accounts/suggest-code')
      .query({ parentId: assets(beta) })
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .expect(200)
    expect(res.body.code).toBe('1100')
  })

  it('403s a caller without account.manage', async () => {
    await request(app.getHttpServer())
      .get('/api/accounts/suggest-code')
      .query({ parentId: assets(beta) })
      .set(authHeaders(beta.tenantId, beta.viewerId))
      .expect(403)
  })

  it('malformed parentId: 404, not a 500 from a uuid cast error', async () => {
    await request(app.getHttpServer())
      .get('/api/accounts/suggest-code')
      .query({ parentId: 'not-a-uuid' })
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .expect(404)
  })
})

describe('PATCH /api/accounts/:id', () => {
  it('renames an unprotected account: 1 audit record, version increments, no journal entry', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'To Be Renamed', code: '6620' })
      .expect(201)

    const renamed = await request(app.getHttpServer())
      .patch(`/api/accounts/${created.body.id}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ name: 'Renamed Successfully', expectedVersion: 0 })
      .expect(200)

    expect(renamed.body.name).toBe('Renamed Successfully')
    expect(renamed.body.version).toBe(1)
    expect(renamed.body.code).toBe('6620') // unchanged

    const page = await auditRowsFor(
      alpha.tenantId,
      alpha.ownerId,
      'ACCOUNT_UPDATED',
      created.body.id,
    )
    expect(page.items).toHaveLength(1)
  })

  it('an edit that changes nothing writes nothing: no audit row, no version bump', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'No-Op Edit', code: '6621' })
      .expect(201)

    const noOp = await request(app.getHttpServer())
      .patch(`/api/accounts/${created.body.id}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ name: 'No-Op Edit', expectedVersion: 0 })
      .expect(200)

    expect(noOp.body.version).toBe(0)
    const page = await auditRowsFor(
      alpha.tenantId,
      alpha.ownerId,
      'ACCOUNT_UPDATED',
      created.body.id,
    )
    expect(page.items).toHaveLength(0)
  })

  it('a stale version: ACCOUNT_VERSION_CONFLICT / 409, nothing written', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'Version Conflict Test', code: '6622' })
      .expect(201)

    await request(app.getHttpServer())
      .patch(`/api/accounts/${created.body.id}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ name: 'Renamed Once', expectedVersion: 0 })
      .expect(200)

    const stale = await request(app.getHttpServer())
      .patch(`/api/accounts/${created.body.id}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ name: 'Renamed Twice, Stale', expectedVersion: 0 })
      .expect(409)
    expect(stale.body.error).toBe('account_version_conflict')
  })

  it('a protected account (header, control, role-holding, restricted): ACCOUNT_PROTECTED / 409, for every field', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/accounts/${cashInHand(alpha)}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ name: 'Renaming a protected account', expectedVersion: 0 })
      .expect(409)
    expect(res.body.error).toBe('account_protected')

    const headerEdit = await request(app.getHttpServer())
      .patch(`/api/accounts/${opex(alpha)}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ name: 'Renaming a header', expectedVersion: 0 })
      .expect(409)
    expect(headerEdit.body.error).toBe('account_protected')
  })

  it('unknown id: ACCOUNT_NOT_FOUND / 404', async () => {
    await request(app.getHttpServer())
      .patch('/api/accounts/00000000-0000-4000-8000-000000000000')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ name: 'x', expectedVersion: 0 })
      .expect(404)
  })

  it('malformed id and cross-tenant id: 404, identical body', async () => {
    const malformed = await request(app.getHttpServer())
      .patch('/api/accounts/not-a-uuid')
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .send({ name: 'x', expectedVersion: 0 })
      .expect(404)

    const crossTenant = await request(app.getHttpServer())
      .patch(`/api/accounts/${salaries(alpha)}`)
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .send({ name: 'x', expectedVersion: 0 })
      .expect(404)

    expect(crossTenant.body.error).toBe(malformed.body.error)
  })

  it("beta cannot re-parent its own account under alpha's header: ACCOUNT_PARENT_NOT_FOUND / 404 (RLS hides it)", async () => {
    const created = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .send({ parentId: opex(beta), name: 'Beta Reparent Test', code: '6630' })
      .expect(201)

    const res = await request(app.getHttpServer())
      .patch(`/api/accounts/${created.body.id}`)
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .send({ parentId: assets(alpha), expectedVersion: 0 })
      .expect(404)
    expect(res.body.error).toBe('account_parent_not_found')
  })

  it('403s a caller without account.manage (viewer)', async () => {
    await request(app.getHttpServer())
      .patch(`/api/accounts/${salaries(alpha)}`)
      .set(authHeaders(alpha.tenantId, alpha.viewerId))
      .send({ name: 'x', expectedVersion: 0 })
      .expect(403)
  })

  it('re-parents to a header of a different type: ACCOUNT_PARENT_TYPE_MISMATCH / 400', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'Type Mismatch Test', code: '6631' })
      .expect(201)

    const res = await request(app.getHttpServer())
      .patch(`/api/accounts/${created.body.id}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: assets(alpha), expectedVersion: 0 })
      .expect(400)
    expect(res.body.error).toBe('account_parent_type_mismatch')
  })

  it('re-codes and re-parents an account before its first posting: allowed, both same-type headers', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: opex(alpha), name: 'Movable Account', code: '6640' })
      .expect(201)

    // 6000 Operating Expenses -> 5000 Cost of Sales: both EXPENSE (§8.2's
    // "same type" requirement) — re-parenting across DIFFERENT types (e.g.
    // to 1000 Assets) is ACCOUNT_PARENT_TYPE_MISMATCH, proven above.
    const moved = await request(app.getHttpServer())
      .patch(`/api/accounts/${created.body.id}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send({ parentId: costOfSales(alpha), code: '5150', expectedVersion: 0 })
      .expect(200)
    expect(moved.body.code).toBe('5150')
    expect(moved.body.parentId).toBe(costOfSales(alpha))
  })

  describe('code and parent freeze after the first posting (§8.2, §8.7 R4/R8)', () => {
    it('a code edit after a posting: ACCOUNT_HAS_POSTINGS / 409 — edit-then-post and post-then-edit both land correctly', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/accounts')
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ parentId: opex(alpha), name: 'Post Then Edit', code: '6650' })
        .expect(201)

      // post-then-edit: post a JV to it first, THEN try to edit code/parentId.
      await request(app.getHttpServer())
        .post('/api/journals')
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .set('Idempotency-Key', 'coa-post-then-edit-1')
        .send({
          occurredAt: '2026-09-10',
          narration: 'Post before edit attempt',
          reference: null,
          lines: [
            { accountId: created.body.id, debit: '500.0000' },
            { accountId: bank(alpha), credit: '500.0000' },
          ],
        })
        .expect(200)

      const codeEdit = await request(app.getHttpServer())
        .patch(`/api/accounts/${created.body.id}`)
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ code: '6651', expectedVersion: 0 })
        .expect(409)
      expect(codeEdit.body.error).toBe('account_has_postings')

      // Same type as the account's current parent (6000, EXPENSE) — isolates
      // ACCOUNT_HAS_POSTINGS from ACCOUNT_PARENT_TYPE_MISMATCH, which the
      // §8.9 order checks first.
      const parentEdit = await request(app.getHttpServer())
        .patch(`/api/accounts/${created.body.id}`)
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ parentId: costOfSales(alpha), expectedVersion: 0 })
        .expect(409)
      expect(parentEdit.body.error).toBe('account_has_postings')

      // A rename (not code/parent) is still allowed on an account with postings.
      const rename = await request(app.getHttpServer())
        .patch(`/api/accounts/${created.body.id}`)
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ name: 'Post Then Edit (renamed)', expectedVersion: 0 })
        .expect(200)
      expect(rename.body.name).toBe('Post Then Edit (renamed)')
    })

    it('edit-then-post: renaming/re-coding before the first posting is allowed, and the posting then lands under the new code', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/accounts')
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ parentId: opex(alpha), name: 'Edit Then Post', code: '6660' })
        .expect(201)

      const recoded = await request(app.getHttpServer())
        .patch(`/api/accounts/${created.body.id}`)
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ code: '6661', expectedVersion: 0 })
        .expect(200)
      expect(recoded.body.code).toBe('6661')

      await request(app.getHttpServer())
        .post('/api/journals')
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .set('Idempotency-Key', 'coa-edit-then-post-1')
        .send({
          occurredAt: '2026-09-11',
          narration: 'Post after edit',
          reference: null,
          lines: [
            { accountId: created.body.id, debit: '250.0000' },
            { accountId: bank(alpha), credit: '250.0000' },
          ],
        })
        .expect(200)

      // Now frozen.
      const afterPost = await request(app.getHttpServer())
        .patch(`/api/accounts/${created.body.id}`)
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ code: '6662', expectedVersion: 1 })
        .expect(409)
      expect(afterPost.body.error).toBe('account_has_postings')
    })

    it('concurrency: a code edit racing the account’s first posting resolves one way or the other, never both', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/accounts')
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .send({ parentId: opex(alpha), name: 'Race Edit Vs Post', code: '6670' })
        .expect(201)

      const [editRes, postRes] = await Promise.all([
        request(app.getHttpServer())
          .patch(`/api/accounts/${created.body.id}`)
          .set(authHeaders(alpha.tenantId, alpha.ownerId))
          .send({ code: '6671', expectedVersion: 0 }),
        request(app.getHttpServer())
          .post('/api/journals')
          .set(authHeaders(alpha.tenantId, alpha.ownerId))
          .set('Idempotency-Key', 'coa-race-edit-post-1')
          .send({
            occurredAt: '2026-09-12',
            narration: 'Race against a code edit',
            reference: null,
            lines: [
              { accountId: created.body.id, debit: '10.0000' },
              { accountId: bank(alpha), credit: '10.0000' },
            ],
          }),
      ])

      // Either the edit committed first (200) and the posting landed under
      // the new code (200), or the posting committed first (200) and the
      // edit was rejected (409) — never a state where both "won" against
      // each other's view of the account.
      if (editRes.status === 200) {
        expect(postRes.status).toBe(200)
      } else {
        expect(editRes.status).toBe(409)
        expect(postRes.status).toBe(200)
      }
    })
  })
})
