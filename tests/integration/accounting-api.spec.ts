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
import { periodEngine } from '@finsoft/accounting-kernel'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { PermissionGuard } from '../../apps/api/src/common/permission.guard.ts'
import { AccountingModule } from '../../apps/api/src/accounting/accounting.module.ts'
import {
  createAccountingTenant,
  type AccountingTenantFixture,
} from './helpers/accounting-fixture.ts'

/*
 * The accounting HTTP API, over real HTTP against a real PostgreSQL.
 * docs/design/M2/api-contract.md.
 *
 * Same test-only middleware pattern as tests/integration/audit-api.spec.ts
 * and permission-guard.spec.ts: packages/auth's real login flow is outside
 * this lane's ALLOWED paths, so a middleware sets req.auth + TenantContext
 * from test-only headers, standing in for what TenantGuard would have set
 * from a verified JWT. PermissionGuard itself is real, registered exactly
 * as app.module.ts registers it, so every RBAC assertion here is the real
 * guard, not a stand-in for it.
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

function jvBody(
  overrides: Partial<{
    occurredAt: string
    narration: string
    reference: string | null
    lines: unknown[]
  }> = {},
) {
  return {
    occurredAt: '2026-09-05',
    narration: 'Opening capital',
    reference: null,
    lines: [],
    ...overrides,
  }
}

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()

  alpha = await createAccountingTenant('MAPA')
  beta = await createAccountingTenant('MAPB')

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

function bankId(t: AccountingTenantFixture) {
  return t.accountsByCode.get('1120')!.id
}
function capitalId(t: AccountingTenantFixture) {
  return t.accountsByCode.get('3100')!.id
}
function rentId(t: AccountingTenantFixture) {
  return t.accountsByCode.get('6200')!.id
}

describe('POST /api/journals', () => {
  it('posts a balanced two-line voucher and returns it with lines', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-happy-1')
      .send(
        jvBody({
          narration: 'Opening capital',
          lines: [
            { accountId: bankId(alpha), debit: '500000.0000' },
            { accountId: capitalId(alpha), credit: '500000.0000' },
          ],
        }),
      )
      .expect(200)

    expect(res.body.outcome).toBe('POSTED')
    expect(res.body.entryNumber).toMatch(/^JV-2027-\d{6}$/)
    expect(res.body.status).toBe('POSTED')
    expect(res.body.lines).toHaveLength(2)
    const debitLine = res.body.lines.find(
      (l: { accountId: string }) => l.accountId === bankId(alpha),
    )
    expect(debitLine.debit).toBe('500000.0000')
    expect(debitLine.credit).toBe('0.0000')
  })

  it('round-trips a money value exactly, to the fourth decimal', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-money-roundtrip')
      .send(
        jvBody({
          narration: 'Money round-trip',
          lines: [
            { accountId: rentId(alpha), debit: '1234567.8901' },
            { accountId: bankId(alpha), credit: '1234567.8901' },
          ],
        }),
      )
      .expect(200)

    const rentLine = res.body.lines.find(
      (l: { accountId: string }) => l.accountId === rentId(alpha),
    )
    expect(rentLine.debit).toBe('1234567.8901')

    const got = await request(app.getHttpServer())
      .get(`/api/journals/${res.body.id}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(200)
    const gotLine = got.body.lines.find((l: { accountId: string }) => l.accountId === rentId(alpha))
    expect(gotLine.debit).toBe('1234567.8901')
  })

  it('is idempotent: three identical requests produce one entry, one number', async () => {
    const body = jvBody({
      narration: 'Idempotent JV',
      lines: [
        { accountId: bankId(alpha), debit: '1000.0000' },
        { accountId: capitalId(alpha), credit: '1000.0000' },
      ],
    })

    const first = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-idempotent-retry')
      .send(body)
      .expect(200)
    expect(first.body.outcome).toBe('POSTED')

    for (let i = 0; i < 2; i++) {
      const replay = await request(app.getHttpServer())
        .post('/api/journals')
        .set(authHeaders(alpha.tenantId, alpha.ownerId))
        .set('Idempotency-Key', 'jv-idempotent-retry')
        .send(body)
        .expect(200)
      expect(replay.body.outcome).toBe('REPLAYED')
      expect(replay.body.id).toBe(first.body.id)
      expect(replay.body.entryNumber).toBe(first.body.entryNumber)
    }
  })

  it('the same key with different content is refused, not silently posted', async () => {
    const key = 'jv-key-reuse'
    await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', key)
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '10.0000' },
            { accountId: capitalId(alpha), credit: '10.0000' },
          ],
        }),
      )
      .expect(200)

    const res = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', key)
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '20.0000' },
            { accountId: capitalId(alpha), credit: '20.0000' },
          ],
        }),
      )
      .expect(409)
    expect(res.body.error).toBe('idempotency_key_reused')
  })

  it('rejects an unbalanced voucher with the kernel code and both totals', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-unbalanced')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '100.0000' },
            { accountId: capitalId(alpha), credit: '90.0000' },
          ],
        }),
      )
      .expect(400)
    expect(res.body.error).toBe('jv_unbalanced')
    expect(res.body.details.debit).toBe('100.0000')
    expect(res.body.details.credit).toBe('90.0000')
  })

  it('rejects an unknown top-level body key with 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-unknown-key')
      .send({
        ...jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '10.0000' },
            { accountId: capitalId(alpha), credit: '10.0000' },
          ],
        }),
        taxAmount: '0.0000',
      })
      .expect(400)
    expect(res.body.error).toBe('validation_failed')
  })

  it('requires the Idempotency-Key header', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '10.0000' },
            { accountId: capitalId(alpha), credit: '10.0000' },
          ],
        }),
      )
      .expect(400)
    expect(res.body.error).toBe('idempotency_key_required')
  })

  it('403s a caller without voucher.post', async () => {
    await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.viewerId))
      .set('Idempotency-Key', 'jv-viewer-forbidden')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '10.0000' },
            { accountId: capitalId(alpha), credit: '10.0000' },
          ],
        }),
      )
      .expect(403)
  })

  it('401s with no credentials at all', async () => {
    await request(app.getHttpServer())
      .post('/api/journals')
      .set('Idempotency-Key', 'jv-no-auth')
      .send(jvBody({ lines: [] }))
      .expect(401)
  })

  it('rejects a posting dated in a closed period, naming the kernel code', async () => {
    // Close the first period of FY2027 (2026-07) for a THIRD tenant, so this
    // does not disturb the other cases' open-period postings.
    const gamma = await createAccountingTenant('MAPC')
    await runAs({ tenantId: gamma.tenantId, userId: gamma.ownerId }, () =>
      withTenant((tx) => periodEngine.close('2026-07', tx)),
    )

    const res = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(gamma.tenantId, gamma.ownerId))
      .set('Idempotency-Key', 'jv-closed-period')
      .send(
        jvBody({
          occurredAt: '2026-07-15',
          lines: [
            { accountId: bankId(gamma), debit: '10.0000' },
            { accountId: capitalId(gamma), credit: '10.0000' },
          ],
        }),
      )
      .expect(409)
    expect(res.body.error).toBe('period_closed')
  })
})

describe('GET /api/journals', () => {
  it("lists only the caller tenant's entries, newest first, paginated", async () => {
    const res = await request(app.getHttpServer())
      .get('/api/journals')
      .query({ limit: 1 })
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].sourceType).toBe('journal_voucher')
  })

  it("tenant B never sees tenant A's entries", async () => {
    const asAlpha = await request(app.getHttpServer())
      .get('/api/journals')
      .query({ limit: 200 })
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(200)
    const alphaIds = asAlpha.body.items.map((i: { id: string }) => i.id)

    const asBeta = await request(app.getHttpServer())
      .get('/api/journals')
      .query({ limit: 200 })
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .expect(200)
    const betaIds = asBeta.body.items.map((i: { id: string }) => i.id)

    for (const id of alphaIds) expect(betaIds).not.toContain(id)
  })

  it('viewer (voucher.view) can list; a user with no role at all cannot', async () => {
    await request(app.getHttpServer())
      .get('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.viewerId))
      .expect(200)

    await request(app.getHttpServer())
      .get('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.noRoleId))
      .expect(403)
  })
})

describe('GET /api/journals/:id', () => {
  it("returns 404 for an unknown id, a malformed id, and another tenant's real id — identically", async () => {
    const posted = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-for-404-checks')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '5.0000' },
            { accountId: capitalId(alpha), credit: '5.0000' },
          ],
        }),
      )
      .expect(200)

    const unknown = await request(app.getHttpServer())
      .get('/api/journals/00000000-0000-4000-8000-000000000000')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(404)
    expect(unknown.body.error).toBe('entry_not_found')

    const malformed = await request(app.getHttpServer())
      .get('/api/journals/not-a-uuid')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(404)
    expect(malformed.body.error).toBe('entry_not_found')

    const crossTenant = await request(app.getHttpServer())
      .get(`/api/journals/${posted.body.id}`)
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .expect(404)
    expect(crossTenant.body.error).toBe('entry_not_found')
  })
})

describe('POST /api/journals/:id/reverse', () => {
  it('reverses a posted voucher; reversing again is refused', async () => {
    const posted = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-to-reverse')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '250.0000' },
            { accountId: capitalId(alpha), credit: '250.0000' },
          ],
        }),
      )
      .expect(200)

    const reversed = await request(app.getHttpServer())
      .post(`/api/journals/${posted.body.id}/reverse`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'rv-first')
      .send({ reason: 'Posted to the wrong account' })
      .expect(200)
    expect(reversed.body.outcome).toBe('POSTED')
    expect(reversed.body.entryNumber).toMatch(/^RV-2027-\d{6}$/)
    expect(reversed.body.reversalOf).toBe(posted.body.id)
    expect(reversed.body.disclosure).toBeNull()

    const original = await request(app.getHttpServer())
      .get(`/api/journals/${posted.body.id}`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(200)
    expect(original.body.status).toBe('REVERSED')
    expect(original.body.reversedBy).toBe(reversed.body.id)

    const again = await request(app.getHttpServer())
      .post(`/api/journals/${posted.body.id}/reverse`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'rv-second')
      .send({ reason: 'Trying again' })
      .expect(409)
    expect(again.body.error).toBe('already_reversed')
  })

  it('cross-tenant reverse is 404, not 403', async () => {
    const posted = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-cross-tenant-reverse')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '15.0000' },
            { accountId: capitalId(alpha), credit: '15.0000' },
          ],
        }),
      )
      .expect(200)

    const res = await request(app.getHttpServer())
      .post(`/api/journals/${posted.body.id}/reverse`)
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .set('Idempotency-Key', 'rv-cross-tenant')
      .send({ reason: 'Not mine to reverse' })
      .expect(404)
    expect(res.body.error).toBe('entry_not_found')
  })

  it('403s a viewer (voucher.reverse is not granted to Viewer)', async () => {
    const posted = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-viewer-reverse-403')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '15.0000' },
            { accountId: capitalId(alpha), credit: '15.0000' },
          ],
        }),
      )
      .expect(200)

    await request(app.getHttpServer())
      .post(`/api/journals/${posted.body.id}/reverse`)
      .set(authHeaders(alpha.tenantId, alpha.viewerId))
      .set('Idempotency-Key', 'rv-viewer-forbidden')
      .send({ reason: 'Should not be allowed' })
      .expect(403)
  })
})

describe('GET /api/ledgers/:accountId', () => {
  it('returns opening/closing balance and a debit-positive running balance', async () => {
    const delta = await createAccountingTenant('MAPD')
    await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(delta.tenantId, delta.ownerId))
      .set('Idempotency-Key', 'ledger-seed-1')
      .send(
        jvBody({
          occurredAt: '2026-08-01',
          lines: [
            { accountId: bankId(delta), debit: '1000.0000' },
            { accountId: capitalId(delta), credit: '1000.0000' },
          ],
        }),
      )
      .expect(200)
    await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(delta.tenantId, delta.ownerId))
      .set('Idempotency-Key', 'ledger-seed-2')
      .send(
        jvBody({
          occurredAt: '2026-08-02',
          lines: [
            { accountId: rentId(delta), debit: '300.0000' },
            { accountId: bankId(delta), credit: '300.0000' },
          ],
        }),
      )
      .expect(200)

    const res = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(delta)}`)
      .query({ from: '2026-07-01', to: '2026-08-31' })
      .set(authHeaders(delta.tenantId, delta.ownerId))
      .expect(200)

    expect(res.body.code).toBe('1120')
    expect(res.body.openingBalance).toBe('0.0000')
    expect(res.body.closingBalance).toBe('700.0000')
    expect(res.body.lines).toHaveLength(2)
    expect(res.body.lines.at(-1).runningBalance).toBe('700.0000')
  })

  it("404s for an unknown account and another tenant's account", async () => {
    const unknown = await request(app.getHttpServer())
      .get('/api/ledgers/00000000-0000-4000-8000-000000000000')
      .query({ from: '2026-07-01', to: '2026-08-31' })
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(404)
    expect(unknown.body.error).toBe('account_not_found')

    const crossTenant = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(beta)}`)
      .query({ from: '2026-07-01', to: '2026-08-31' })
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(404)
    expect(crossTenant.body.error).toBe('account_not_found')
  })

  it('403s a caller with no role at all', async () => {
    await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(alpha)}`)
      .query({ from: '2026-07-01', to: '2026-08-31' })
      .set(authHeaders(alpha.tenantId, alpha.noRoleId))
      .expect(403)
  })
})

describe('GET /api/reports/trial-balance', () => {
  it('balances exactly after posts and a reversal', async () => {
    const epsilon = await createAccountingTenant('MAPE')

    await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(epsilon.tenantId, epsilon.ownerId))
      .set('Idempotency-Key', 'tb-seed-1')
      .send(
        jvBody({
          occurredAt: '2026-08-01',
          lines: [
            { accountId: bankId(epsilon), debit: '2000.0000' },
            { accountId: capitalId(epsilon), credit: '2000.0000' },
          ],
        }),
      )
      .expect(200)

    const toReverse = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(epsilon.tenantId, epsilon.ownerId))
      .set('Idempotency-Key', 'tb-seed-2')
      .send(
        jvBody({
          occurredAt: '2026-08-02',
          lines: [
            { accountId: rentId(epsilon), debit: '400.0000' },
            { accountId: bankId(epsilon), credit: '400.0000' },
          ],
        }),
      )
      .expect(200)

    await request(app.getHttpServer())
      .post(`/api/journals/${toReverse.body.id}/reverse`)
      .set(authHeaders(epsilon.tenantId, epsilon.ownerId))
      .set('Idempotency-Key', 'tb-reverse-seed-2')
      .send({ reason: 'Correction' })
      .expect(200)

    const res = await request(app.getHttpServer())
      .get('/api/reports/trial-balance')
      .query({ asOf: '2026-08-31' })
      .set(authHeaders(epsilon.tenantId, epsilon.ownerId))
      .expect(200)

    expect(res.body.totalDebit).toBe(res.body.totalCredit)
    expect(res.body.totalDebit).toBe('2000.0000')

    const rent = res.body.lines.find((l: { code: string }) => l.code === '6200')
    expect(rent.debit).toBe('0.0000')
    expect(rent.credit).toBe('0.0000')
  })

  it('viewer (report.financial) can read; a user with no role at all cannot', async () => {
    await request(app.getHttpServer())
      .get('/api/reports/trial-balance')
      .query({ asOf: '2026-09-27' })
      .set(authHeaders(alpha.tenantId, alpha.viewerId))
      .expect(200)

    await request(app.getHttpServer())
      .get('/api/reports/trial-balance')
      .query({ asOf: '2026-09-27' })
      .set(authHeaders(alpha.tenantId, alpha.noRoleId))
      .expect(403)
  })
})

describe('Audit — every mutation writes an append-only record (CLAUDE.md, the brief §3)', () => {
  it('posting writes JOURNAL_ENTRY_POSTED with the full line detail as afterJson', async () => {
    const zeta = await createAccountingTenant('MAPZ')
    const posted = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(zeta.tenantId, zeta.ownerId))
      .set('Idempotency-Key', 'audit-post-1')
      .send(
        jvBody({
          narration: 'Audited posting',
          lines: [
            { accountId: bankId(zeta), debit: '77.0000' },
            { accountId: capitalId(zeta), credit: '77.0000' },
          ],
        }),
      )
      .expect(200)

    const events = await runAs({ tenantId: zeta.tenantId, userId: zeta.ownerId }, () =>
      withTenant((tx) =>
        listAuditEvents(tx, {
          action: 'JOURNAL_ENTRY_POSTED',
          entityId: posted.body.id,
          limit: 10,
        }),
      ),
    )
    expect(events.items).toHaveLength(1)
    const event = events.items[0]!
    expect(event.entityType).toBe('journal_entries')
    expect(event.actorUserId).toBe(zeta.ownerId)
    expect(event.beforeJson).toBeNull()
    const after = event.afterJson as { entryNumber: string; lines: unknown[] }
    expect(after.entryNumber).toBe(posted.body.entryNumber)
    expect(after.lines).toHaveLength(2)
  })

  it('reversing writes JOURNAL_ENTRY_REVERSED with the before/after status transition', async () => {
    const zeta = await createAccountingTenant('MAPZ2')
    const posted = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(zeta.tenantId, zeta.ownerId))
      .set('Idempotency-Key', 'audit-post-2')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(zeta), debit: '33.0000' },
            { accountId: capitalId(zeta), credit: '33.0000' },
          ],
        }),
      )
      .expect(200)

    await request(app.getHttpServer())
      .post(`/api/journals/${posted.body.id}/reverse`)
      .set(authHeaders(zeta.tenantId, zeta.ownerId))
      .set('Idempotency-Key', 'audit-reverse-2')
      .send({ reason: 'Audit check' })
      .expect(200)

    const events = await runAs({ tenantId: zeta.tenantId, userId: zeta.ownerId }, () =>
      withTenant((tx) =>
        listAuditEvents(tx, {
          action: 'JOURNAL_ENTRY_REVERSED',
          entityId: posted.body.id,
          limit: 10,
        }),
      ),
    )
    expect(events.items).toHaveLength(1)
    const event = events.items[0]!
    const before = event.beforeJson as { status: string }
    const after = event.afterJson as { status: string; reason: string }
    expect(before.status).toBe('POSTED')
    expect(after.status).toBe('REVERSED')
    expect(after.reason).toBe('Audit check')
  })
})
