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

  it('rejects an unknown query key with 400', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/journals')
      .query({ bogus: 'x' })
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(400)
    expect(res.body.error).toBe('validation_failed')
  })

  it('rejects a forged cursor with 400, never 500', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/journals')
      .query({ cursor: 'not-valid-base64url-json-at-all!!' })
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(400)
    expect(res.body.error).toBe('invalid_cursor')

    // Well-formed base64url JSON, but the wrong shape (id is not a uuid).
    const forged = Buffer.from(
      JSON.stringify({ occurredAt: '2026-09-01', createdAt: 'not-a-timestamp', id: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url')
    await request(app.getHttpServer())
      .get('/api/journals')
      .query({ cursor: forged })
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(400)
  })

  it('walks the whole register in small pages with no skips or duplicates', async () => {
    const zeta = await createAccountingTenant('MAPZW')
    const total = 7
    for (let i = 0; i < total; i++) {
      await request(app.getHttpServer())
        .post('/api/journals')
        .set(authHeaders(zeta.tenantId, zeta.ownerId))
        .set('Idempotency-Key', `register-walk-${i}`)
        .send(
          jvBody({
            occurredAt: '2026-08-01',
            lines: [
              { accountId: bankId(zeta), debit: `${i + 1}.0000` },
              { accountId: capitalId(zeta), credit: `${i + 1}.0000` },
            ],
          }),
        )
        .expect(200)
    }

    const seen: string[] = []
    let cursor: string | null | undefined
    do {
      const res = await request(app.getHttpServer())
        .get('/api/journals')
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .set(authHeaders(zeta.tenantId, zeta.ownerId))
        .expect(200)
      for (const item of res.body.items) seen.push(item.id)
      cursor = res.body.nextCursor
    } while (cursor)

    expect(seen).toHaveLength(total)
    expect(new Set(seen).size).toBe(total)
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

  it('403s a caller with no role at all', async () => {
    const posted = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-for-detail-403')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '5.0000' },
            { accountId: capitalId(alpha), credit: '5.0000' },
          ],
        }),
      )
      .expect(200)

    await request(app.getHttpServer())
      .get(`/api/journals/${posted.body.id}`)
      .set(authHeaders(alpha.tenantId, alpha.noRoleId))
      .expect(403)
  })
})

describe('POST /api/journals — cross-tenant references inside the body', () => {
  it("a line naming another tenant's account is ACCOUNT_NOT_FOUND, not a leak of its existence", async () => {
    const res = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-cross-tenant-account')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(beta), debit: '10.0000' },
            { accountId: capitalId(alpha), credit: '10.0000' },
          ],
        }),
      )
      .expect(400)
    expect(res.body.error).toBe('account_not_found')
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

  it('rejects an unknown body key with 400', async () => {
    const posted = await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'jv-reverse-unknown-key')
      .send(
        jvBody({
          lines: [
            { accountId: bankId(alpha), debit: '9.0000' },
            { accountId: capitalId(alpha), credit: '9.0000' },
          ],
        }),
      )
      .expect(200)

    const res = await request(app.getHttpServer())
      .post(`/api/journals/${posted.body.id}/reverse`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .set('Idempotency-Key', 'rv-unknown-key')
      .send({ reason: 'A reason', notAField: true })
      .expect(400)
    expect(res.body.error).toBe('validation_failed')
  })

  /*
   * REVERSAL_VIA_SOURCE_REQUIRED (409) is mapped in posting-error.mapper.ts
   * and specified in the contract (§7), but is NOT exercised here by HTTP.
   * Proving it needs a document-sourced entry, which in M2 (no module posts
   * sales_invoice/customer_receipt yet) can only be created by inserting
   * journal_entries/journal_lines directly — and eslint.config.mjs's
   * ADR-0005 Compliance rule confines that literal pattern to exactly
   * tests/accounting/posting-invariants.ts (the one named exemption,
   * covering this identical case at the kernel level already). This lane's
   * ALLOWED paths do not include eslint.config.mjs or tests/accounting/**,
   * so this HTTP-level case is not addable without widening either — raised
   * as OBSERVED in the final report rather than worked around by weakening
   * or routing past the lint fence.
   */
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

  it('rejects an unknown query key with 400', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(alpha)}`)
      .query({ from: '2026-07-01', to: '2026-08-31', bogus: 'x' })
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(400)
    expect(res.body.error).toBe('validation_failed')
  })

  it('a non-zero opening balance: a line dated before `from` carries forward', async () => {
    const theta = await createAccountingTenant('MAPTHETA')
    await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(theta.tenantId, theta.ownerId))
      .set('Idempotency-Key', 'opening-balance-seed')
      .send(
        jvBody({
          occurredAt: '2026-07-10',
          lines: [
            { accountId: bankId(theta), debit: '4000.0000' },
            { accountId: capitalId(theta), credit: '4000.0000' },
          ],
        }),
      )
      .expect(200)
    await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(theta.tenantId, theta.ownerId))
      .set('Idempotency-Key', 'opening-balance-in-range')
      .send(
        jvBody({
          occurredAt: '2026-08-05',
          lines: [
            { accountId: rentId(theta), debit: '150.0000' },
            { accountId: bankId(theta), credit: '150.0000' },
          ],
        }),
      )
      .expect(200)

    const res = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(theta)}`)
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .set(authHeaders(theta.tenantId, theta.ownerId))
      .expect(200)

    expect(res.body.openingBalance).toBe('4000.0000')
    expect(res.body.closingBalance).toBe('3850.0000')
    expect(res.body.lines).toHaveLength(1)
    expect(res.body.lines[0].runningBalance).toBe('3850.0000')
  })

  it('two pages together equal one full page, running balances included', async () => {
    const iota = await createAccountingTenant('MAPIOTA')
    const amounts = ['10.0000', '20.0000', '30.0000', '40.0000']
    for (const [i, amount] of amounts.entries()) {
      await request(app.getHttpServer())
        .post('/api/journals')
        .set(authHeaders(iota.tenantId, iota.ownerId))
        .set('Idempotency-Key', `ledger-page-seed-${i}`)
        .send(
          jvBody({
            occurredAt: '2026-08-01',
            lines: [
              { accountId: bankId(iota), debit: amount },
              { accountId: capitalId(iota), credit: amount },
            ],
          }),
        )
        .expect(200)
    }

    const full = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(iota)}`)
      .query({ from: '2026-08-01', to: '2026-08-31', limit: 10 })
      .set(authHeaders(iota.tenantId, iota.ownerId))
      .expect(200)
    expect(full.body.lines).toHaveLength(4)
    expect(full.body.nextCursor).toBeNull()

    const page1 = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(iota)}`)
      .query({ from: '2026-08-01', to: '2026-08-31', limit: 2 })
      .set(authHeaders(iota.tenantId, iota.ownerId))
      .expect(200)
    expect(page1.body.lines).toHaveLength(2)
    expect(page1.body.nextCursor).not.toBeNull()

    const page2 = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(iota)}`)
      .query({ from: '2026-08-01', to: '2026-08-31', limit: 2, cursor: page1.body.nextCursor })
      .set(authHeaders(iota.tenantId, iota.ownerId))
      .expect(200)
    expect(page2.body.lines).toHaveLength(2)
    expect(page2.body.nextCursor).toBeNull()

    const combined = [...page1.body.lines, ...page2.body.lines]
    expect(combined).toEqual(full.body.lines)
    expect(page2.body.closingBalance).toBe(full.body.closingBalance)
  })

  it('a non-zero opening balance survives multiple resumed pages exactly (regression, Accounting seat re-review)', async () => {
    /*
     * Pins the defect the Accounting seat's re-review of f3c4f48 found:
     * accountLedgerBalanceThrough's own lower bound is `from`, not account
     * inception, so a resumed page's carry-forward is opening + through —
     * NOT through alone. With opening balance zero (the previous version
     * of this describe block's only multi-page case), the missing addend
     * is zero and the bug is invisible. This tenant seeds a line dated
     * BEFORE `from` specifically so the opening balance is non-zero, and
     * walks the ledger one row at a time (limit: 1) so every one of four
     * pages must recompute the carry-forward, not just the second.
     */
    const sigma = await createAccountingTenant('MAPSIGMA')
    await request(app.getHttpServer())
      .post('/api/journals')
      .set(authHeaders(sigma.tenantId, sigma.ownerId))
      .set('Idempotency-Key', 'sigma-opening-balance')
      .send(
        jvBody({
          occurredAt: '2026-07-10',
          lines: [
            { accountId: bankId(sigma), debit: '5000.0000' },
            { accountId: capitalId(sigma), credit: '5000.0000' },
          ],
        }),
      )
      .expect(200)

    const amounts = ['10.0000', '20.0000', '30.0000', '40.0000']
    for (const [i, amount] of amounts.entries()) {
      await request(app.getHttpServer())
        .post('/api/journals')
        .set(authHeaders(sigma.tenantId, sigma.ownerId))
        .set('Idempotency-Key', `sigma-page-seed-${i}`)
        .send(
          jvBody({
            occurredAt: '2026-08-01',
            lines: [
              { accountId: bankId(sigma), debit: amount },
              { accountId: capitalId(sigma), credit: amount },
            ],
          }),
        )
        .expect(200)
    }

    const full = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(sigma)}`)
      .query({ from: '2026-08-01', to: '2026-08-31', limit: 10 })
      .set(authHeaders(sigma.tenantId, sigma.ownerId))
      .expect(200)
    expect(full.body.openingBalance).toBe('5000.0000')
    expect(full.body.lines).toHaveLength(4)

    const walked: unknown[] = []
    let cursor: string | null | undefined
    let lastClosing: string
    do {
      const page = await request(app.getHttpServer())
        .get(`/api/ledgers/${bankId(sigma)}`)
        .query({ from: '2026-08-01', to: '2026-08-31', limit: 1, ...(cursor ? { cursor } : {}) })
        .set(authHeaders(sigma.tenantId, sigma.ownerId))
        .expect(200)
      for (const line of page.body.lines) walked.push(line)
      cursor = page.body.nextCursor
      lastClosing = page.body.closingBalance
    } while (cursor)

    expect(walked).toEqual(full.body.lines)
    expect(lastClosing).toBe(full.body.closingBalance)
    expect(lastClosing).toBe('5100.0000')
  })

  it('rejects a tampered cursor with 400, never 500', async () => {
    const kappa = await createAccountingTenant('MAPKAPPA')
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/api/journals')
        .set(authHeaders(kappa.tenantId, kappa.ownerId))
        .set('Idempotency-Key', `tamper-seed-${i}`)
        .send(
          jvBody({
            occurredAt: '2026-08-01',
            lines: [
              { accountId: bankId(kappa), debit: '5.0000' },
              { accountId: capitalId(kappa), credit: '5.0000' },
            ],
          }),
        )
        .expect(200)
    }

    const page1 = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(kappa)}`)
      .query({ from: '2026-08-01', to: '2026-08-31', limit: 1 })
      .set(authHeaders(kappa.tenantId, kappa.ownerId))
      .expect(200)
    const validCursor: string = page1.body.nextCursor
    expect(validCursor).not.toBeNull()

    const tampered = `${validCursor.slice(0, -2)}${validCursor.slice(-2) === 'AA' ? 'BB' : 'AA'}`
    const res = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(kappa)}`)
      .query({ from: '2026-08-01', to: '2026-08-31', limit: 1, cursor: tampered })
      .set(authHeaders(kappa.tenantId, kappa.ownerId))
      .expect(400)
    expect(res.body.error).toBe('invalid_cursor')
  })

  it('rejects a cursor issued for a different account with 400', async () => {
    const lambda = await createAccountingTenant('MAPLAMBDA')
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/api/journals')
        .set(authHeaders(lambda.tenantId, lambda.ownerId))
        .set('Idempotency-Key', `cross-account-seed-${i}`)
        .send(
          jvBody({
            occurredAt: '2026-08-01',
            lines: [
              { accountId: bankId(lambda), debit: '5.0000' },
              { accountId: capitalId(lambda), credit: '5.0000' },
            ],
          }),
        )
        .expect(200)
    }

    const page1 = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId(lambda)}`)
      .query({ from: '2026-08-01', to: '2026-08-31', limit: 1 })
      .set(authHeaders(lambda.tenantId, lambda.ownerId))
      .expect(200)
    const cursorFromBank: string = page1.body.nextCursor
    expect(cursorFromBank).not.toBeNull()

    const res = await request(app.getHttpServer())
      .get(`/api/ledgers/${capitalId(lambda)}`)
      .query({ from: '2026-08-01', to: '2026-08-31', limit: 1, cursor: cursorFromBank })
      .set(authHeaders(lambda.tenantId, lambda.ownerId))
      .expect(400)
    expect(res.body.error).toBe('invalid_cursor')
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

  it('rejects an unknown query key with 400', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/reports/trial-balance')
      .query({ asOf: '2026-09-27', bogus: 'x' })
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(400)
    expect(res.body.error).toBe('validation_failed')
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

describe('GET /api/accounts', () => {
  it('returns the full chart, tree-buildable via parentId', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(200)

    expect(res.body.accounts.length).toBeGreaterThan(0)
    const bank = res.body.accounts.find((a: { code: string }) => a.code === '1120')
    expect(bank.kind).toBe('POSTABLE')
    expect(bank.parentId).not.toBeNull()
    const assetsHeader = res.body.accounts.find((a: { code: string }) => a.code === '1000')
    expect(assetsHeader.kind).toBe('HEADER')
    expect(assetsHeader.parentId).toBeNull()
  })

  it('owner, accountant and viewer can all read; a user with no role at all cannot', async () => {
    for (const userId of [alpha.ownerId, alpha.accountantId, alpha.viewerId]) {
      await request(app.getHttpServer())
        .get('/api/accounts')
        .set(authHeaders(alpha.tenantId, userId))
        .expect(200)
    }
    await request(app.getHttpServer())
      .get('/api/accounts')
      .set(authHeaders(alpha.tenantId, alpha.noRoleId))
      .expect(403)
  })

  it("tenant B never sees tenant A's accounts", async () => {
    const res = await request(app.getHttpServer())
      .get('/api/accounts')
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .expect(200)
    const betaAccountIds = new Set(res.body.accounts.map((a: { id: string }) => a.id))
    expect(betaAccountIds.has(bankId(alpha))).toBe(false)
  })
})

describe('GET /api/periods', () => {
  it("returns the tenant's twelve FY2027 periods, chronological, all OPEN", async () => {
    const mu = await createAccountingTenant('MAPMU')
    const res = await request(app.getHttpServer())
      .get('/api/periods')
      .set(authHeaders(mu.tenantId, mu.ownerId))
      .expect(200)

    expect(res.body.periods).toHaveLength(12)
    expect(res.body.periods[0].label).toBe('2026-07')
    expect(res.body.periods[0].status).toBe('OPEN')
    expect(res.body.periods.at(-1).label).toBe('2027-06')
  })

  it('owner, accountant and viewer can all read; a user with no role at all cannot', async () => {
    for (const userId of [alpha.ownerId, alpha.accountantId, alpha.viewerId]) {
      await request(app.getHttpServer())
        .get('/api/periods')
        .set(authHeaders(alpha.tenantId, userId))
        .expect(200)
    }
    await request(app.getHttpServer())
      .get('/api/periods')
      .set(authHeaders(alpha.tenantId, alpha.noRoleId))
      .expect(403)
  })
})

describe('POST /api/periods/:id/close', () => {
  it('owner closes the first period; a second, later close is out of order (409)', async () => {
    const nu = await createAccountingTenant('MAPNU')
    const periods = await request(app.getHttpServer())
      .get('/api/periods')
      .set(authHeaders(nu.tenantId, nu.ownerId))
      .expect(200)
    const july = periods.body.periods.find((p: { label: string }) => p.label === '2026-07')
    const september = periods.body.periods.find((p: { label: string }) => p.label === '2026-09')

    const outOfOrder = await request(app.getHttpServer())
      .post(`/api/periods/${september.id}/close`)
      .set(authHeaders(nu.tenantId, nu.ownerId))
      .expect(409)
    expect(outOfOrder.body.error).toBe('period_close_out_of_order')

    const closed = await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/close`)
      .set(authHeaders(nu.tenantId, nu.ownerId))
      .expect(200)
    expect(closed.body.status).toBe('CLOSED')
  })

  it('accountant (period.close) can close; viewer and no-role cannot', async () => {
    const xi = await createAccountingTenant('MAPXI')
    const periods = await request(app.getHttpServer())
      .get('/api/periods')
      .set(authHeaders(xi.tenantId, xi.ownerId))
      .expect(200)
    const july = periods.body.periods.find((p: { label: string }) => p.label === '2026-07')

    await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/close`)
      .set(authHeaders(xi.tenantId, xi.viewerId))
      .expect(403)
    await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/close`)
      .set(authHeaders(xi.tenantId, xi.noRoleId))
      .expect(403)

    const closed = await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/close`)
      .set(authHeaders(xi.tenantId, xi.accountantId))
      .expect(200)
    expect(closed.body.status).toBe('CLOSED')
  })

  it("404s for an unknown id and another tenant's real id", async () => {
    const unknown = await request(app.getHttpServer())
      .post('/api/periods/00000000-0000-4000-8000-000000000000/close')
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(404)
    expect(unknown.body.error).toBe('period_not_found')

    const periods = await request(app.getHttpServer())
      .get('/api/periods')
      .set(authHeaders(beta.tenantId, beta.ownerId))
      .expect(200)
    const betaJuly = periods.body.periods.find((p: { label: string }) => p.label === '2026-07')

    const crossTenant = await request(app.getHttpServer())
      .post(`/api/periods/${betaJuly.id}/close`)
      .set(authHeaders(alpha.tenantId, alpha.ownerId))
      .expect(404)
    expect(crossTenant.body.error).toBe('period_not_found')
  })
})

describe('POST /api/periods/:id/reopen', () => {
  it('owner reopens the latest closed period; reopening a non-latest closed period is out of order (409)', async () => {
    const omicron = await createAccountingTenant('MAPOMI')
    const periods = await request(app.getHttpServer())
      .get('/api/periods')
      .set(authHeaders(omicron.tenantId, omicron.ownerId))
      .expect(200)
    const july = periods.body.periods.find((p: { label: string }) => p.label === '2026-07')
    const august = periods.body.periods.find((p: { label: string }) => p.label === '2026-08')

    await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/close`)
      .set(authHeaders(omicron.tenantId, omicron.ownerId))
      .expect(200)
    await request(app.getHttpServer())
      .post(`/api/periods/${august.id}/close`)
      .set(authHeaders(omicron.tenantId, omicron.ownerId))
      .expect(200)

    const outOfOrder = await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/reopen`)
      .set(authHeaders(omicron.tenantId, omicron.ownerId))
      .send({ reason: 'Trying to reopen the wrong one' })
      .expect(409)
    expect(outOfOrder.body.error).toBe('period_reopen_out_of_order')

    const reopened = await request(app.getHttpServer())
      .post(`/api/periods/${august.id}/reopen`)
      .set(authHeaders(omicron.tenantId, omicron.ownerId))
      .send({ reason: 'Correcting a close-process error' })
      .expect(200)
    expect(reopened.body.status).toBe('OPEN')
  })

  it('requires a non-empty reason', async () => {
    const pi = await createAccountingTenant('MAPPI')
    const periods = await request(app.getHttpServer())
      .get('/api/periods')
      .set(authHeaders(pi.tenantId, pi.ownerId))
      .expect(200)
    const july = periods.body.periods.find((p: { label: string }) => p.label === '2026-07')
    await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/close`)
      .set(authHeaders(pi.tenantId, pi.ownerId))
      .expect(200)

    const res = await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/reopen`)
      .set(authHeaders(pi.tenantId, pi.ownerId))
      .send({ reason: '' })
      .expect(400)
    expect(res.body.error).toBe('validation_failed')
  })

  it('Owner only: accountant and viewer are 403 even though accountant holds period.close', async () => {
    const rho = await createAccountingTenant('MAPRHO')
    const periods = await request(app.getHttpServer())
      .get('/api/periods')
      .set(authHeaders(rho.tenantId, rho.ownerId))
      .expect(200)
    const july = periods.body.periods.find((p: { label: string }) => p.label === '2026-07')
    await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/close`)
      .set(authHeaders(rho.tenantId, rho.ownerId))
      .expect(200)

    await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/reopen`)
      .set(authHeaders(rho.tenantId, rho.accountantId))
      .send({ reason: 'Should be refused' })
      .expect(403)
    await request(app.getHttpServer())
      .post(`/api/periods/${july.id}/reopen`)
      .set(authHeaders(rho.tenantId, rho.viewerId))
      .send({ reason: 'Should be refused' })
      .expect(403)
  })
})
