import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  closeDatabase,
  computeRequestFingerprint,
  findLinesByEntryId,
  listAllAccounts,
  withTenant,
  type TenantTx,
} from '@finsoft/database'
import {
  createTenantFixture,
  migrateTestDatabase,
  prepareTestDatabase,
  runAs,
  type TenantFixture,
} from '@finsoft/database/testing'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import { PostingError, registerParty } from '@finsoft/accounting-kernel'
// Test-only: the clock is deliberately not on the package's public surface.
import { fixedClock } from '../../packages/accounting-kernel/src/clock.ts'
import {
  createPostingEngine,
  runPostingPipeline,
} from '../../packages/accounting-kernel/src/posting-engine.ts'
import {
  buildServiceSaleEntry,
  SALE_SERIES,
  SERVICE_SALE_RULE_ID,
  validateServiceSalePayload,
} from '../../packages/accounting-kernel/src/rules/service-sale.ts'
import {
  buildCustomerReceiptEntry,
  validateCustomerReceiptPayload,
} from '../../packages/accounting-kernel/src/rules/customer-receipt.ts'

/*
 * SALE_POSTED/service@1 and CUSTOMER_PAYMENT_RECEIVED@1: rule logic built in
 * M2, NOT enabled (events.ts IMPLEMENTED_EVENTS). Their goldens (P04, P05,
 * P10) wait for M3's module tables. What M2 CAN prove, and does here:
 *
 *  - the engine refuses both events (RULE_NOT_ENABLED), so nothing reaches
 *    AR control before the customer subledger exists (Invariant 9);
 *  - the per-line rounding boundary and its verification (service-sale §6),
 *    including P04's and P10's hand-computed figures;
 *  - role resolution, account_control on every line, and the ADR-0026 party
 *    pre-check against the REAL register;
 *  - that a kernel-built AR line satisfies migration 012's composite FKs and
 *    CHECKs end to end (via the internal pipeline, test-only).
 */

const clock = fixedClock('2026-09-27T12:00:00.000Z')
let tenant: TenantFixture
let codeById: Map<string, string>

const asOwner = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
  runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () => withTenant(fn))

async function rejectionOf(promise: Promise<unknown> | (() => unknown)): Promise<PostingError> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    if (error instanceof PostingError) return error
    throw error
  }
  throw new Error('expected a PostingError, but the call succeeded')
}

const saleLine = (quantity: string, unitPrice: string, lineNet: string) => ({
  kind: 'SERVICE',
  description: 'Service',
  quantity,
  unitPrice,
  lineNet,
})

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
  tenant = await createTenantFixture('KR')
  const accounts = await asOwner(async (tx) => {
    await seedChartOfAccounts(tx, tenant.tenantId)
    await createFiscalYear(tx, tenant.tenantId, 2027)
    return listAllAccounts(tx, tenant.tenantId)
  })
  codeById = new Map(accounts.map((account) => [account.id, account.code]))
}, 120_000)

afterAll(async () => {
  await closeDatabase()
})

describe('registerParty (ADR-0026)', () => {
  it('registers a party and returns the database-generated id', async () => {
    const id = await asOwner((tx) => registerParty(tx, 'CUSTOMER'))
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses an unknown party type and a context with no user', async () => {
    expect((await rejectionOf(asOwner((tx) => registerParty(tx, 'SUPPLIER' as never)))).code).toBe(
      'PAYLOAD_INVALID',
    )
    const noUser = await rejectionOf(
      runAs({ tenantId: tenant.tenantId, userId: null }, () =>
        withTenant((tx) => registerParty(tx, 'CUSTOMER')),
      ),
    )
    expect(noUser.code).toBe('FORBIDDEN')
  })
})

describe('SALE_POSTED and CUSTOMER_PAYMENT_RECEIVED are not enabled in M2', () => {
  it.each(['SALE_POSTED', 'CUSTOMER_PAYMENT_RECEIVED'] as const)(
    '%s is RULE_NOT_ENABLED',
    async (event) => {
      const engine = createPostingEngine(clock)
      const error = await rejectionOf(
        asOwner((tx) =>
          engine.post(
            {
              event,
              referenceType: event === 'SALE_POSTED' ? 'sales_invoice' : 'customer_receipt',
              referenceId: randomUUID(),
              occurredAt: '2026-09-15',
              idempotencyKey: `kr-${event}`,
              payload: {},
            },
            tx,
          ),
        ),
      )
      expect(error.code).toBe('RULE_NOT_ENABLED')
    },
  )
})

describe('SALE_POSTED/service@1 — shape and the one rounding boundary', () => {
  const customerId = randomUUID()

  it("P04's invoice: 1 x 7500.000000 + 3 x 833.333333 (= 2499.999999 -> 2500.0000) = 10000.0000", () => {
    const payload = validateServiceSalePayload({
      settlement: 'CREDIT',
      customerId,
      lines: [
        saleLine('1.000000', '7500.000000', '7500.0000'),
        saleLine('3.000000', '833.333333', '2500.0000'),
      ],
      netAmount: '10000.0000',
    })
    expect(payload.netAmount).toBe('10000.0000')
  })

  it("P10's true tie: 2.5 x 1234.567700 = 3086.41925 -> 3086.4193 half-up; half-even's 3086.4192 is refused", async () => {
    const good = validateServiceSalePayload({
      settlement: 'CREDIT',
      customerId,
      lines: [saleLine('2.500000', '1234.567700', '3086.4193')],
      netAmount: '3086.4193',
    })
    expect(good.netAmount).toBe('3086.4193')
    const halfEven = await rejectionOf(() =>
      validateServiceSalePayload({
        settlement: 'CREDIT',
        customerId,
        lines: [saleLine('2.500000', '1234.567700', '3086.4192')],
        netAmount: '3086.4192',
      }),
    )
    expect(halfEven.code).toBe('SALE_AMOUNT_MISMATCH')
    expect(halfEven.details).toMatchObject({ submitted: '3086.4192', expected: '3086.4193' })
  })

  it.each([
    ['a tax key', { taxAmount: '0.0000' }, 'PAYLOAD_INVALID'],
    ['a discount key', { discount: '0.0000' }, 'PAYLOAD_INVALID'],
    ['CASH settlement', { settlement: 'CASH' }, 'SALE_SETTLEMENT_NOT_ENABLED'],
    ['a netAmount that is not Σ lineNet', { netAmount: '10000.0001' }, 'SALE_AMOUNT_MISMATCH'],
  ])('refuses %s', async (_label, override, code) => {
    const error = await rejectionOf(() =>
      validateServiceSalePayload({
        settlement: 'CREDIT',
        customerId,
        lines: [saleLine('1.000000', '10000.000000', '10000.0000')],
        netAmount: '10000.0000',
        ...override,
      }),
    )
    expect(error.code).toBe(code)
  })

  it('refuses a STOCK line and a non-positive quantity', async () => {
    const stock = await rejectionOf(() =>
      validateServiceSalePayload({
        settlement: 'CREDIT',
        customerId,
        lines: [{ ...saleLine('1.000000', '1.000000', '1.0000'), kind: 'STOCK' }],
        netAmount: '1.0000',
      }),
    )
    expect(stock.code).toBe('SALE_LINE_KIND_NOT_ENABLED')
    const zero = await rejectionOf(() =>
      validateServiceSalePayload({
        settlement: 'CREDIT',
        customerId,
        lines: [saleLine('0.000000', '1.000000', '1.0000')],
        netAmount: '1.0000',
      }),
    )
    expect(zero.code).toBe('SALE_LINE_NON_POSITIVE')
  })
})

describe('role resolution, account_control and the party pre-check, against the real schema', () => {
  it('builds Dr AR_CONTROL [CUSTOMER] / Cr SERVICE_REVENUE with account_control copied from each account', async () => {
    const customerId = await asOwner((tx) => registerParty(tx, 'CUSTOMER'))
    const payload = validateServiceSalePayload({
      settlement: 'CREDIT',
      customerId,
      lines: [saleLine('1.000000', '10000.000000', '10000.0000')],
      netAmount: '10000.0000',
    })
    const built = await asOwner((tx) => buildServiceSaleEntry(tx, tenant.tenantId, payload))
    expect(
      built.lines.map((l) => [
        codeById.get(l.accountId),
        l.accountControl,
        l.debit,
        l.credit,
        l.partyType,
        l.partyId,
      ]),
    ).toEqual([
      ['1200', 'AR', '10000.0000', '0.0000', 'CUSTOMER', customerId],
      ['4200', 'NONE', '0.0000', '10000.0000', null, null],
    ])
  })

  it('PARTY_NOT_FOUND for an unregistered id; PARTY_TYPE_MISMATCH for a VENDOR', async () => {
    const vendorId = await asOwner((tx) => registerParty(tx, 'VENDOR'))
    const payloadFor = (id: string) =>
      validateServiceSalePayload({
        settlement: 'CREDIT',
        customerId: id,
        lines: [saleLine('1.000000', '1.000000', '1.0000')],
        netAmount: '1.0000',
      })
    const missing = await rejectionOf(
      asOwner((tx) => buildServiceSaleEntry(tx, tenant.tenantId, payloadFor(randomUUID()))),
    )
    expect(missing.code).toBe('PARTY_NOT_FOUND')
    const mismatch = await rejectionOf(
      asOwner((tx) => buildServiceSaleEntry(tx, tenant.tenantId, payloadFor(vendorId))),
    )
    expect(mismatch.code).toBe('PARTY_TYPE_MISMATCH')
  })

  it("another tenant's party is PARTY_NOT_FOUND — existence elsewhere is never revealed", async () => {
    const other = await createTenantFixture('KR2')
    const foreign = await runAs({ tenantId: other.tenantId, userId: other.ownerId }, () =>
      withTenant((tx) => registerParty(tx, 'CUSTOMER')),
    )
    const payload = validateServiceSalePayload({
      settlement: 'CREDIT',
      customerId: foreign,
      lines: [saleLine('1.000000', '1.000000', '1.0000')],
      netAmount: '1.0000',
    })
    expect(
      (await rejectionOf(asOwner((tx) => buildServiceSaleEntry(tx, tenant.tenantId, payload))))
        .code,
    ).toBe('PARTY_NOT_FOUND')
  })

  it('receipt: Dr BANK_DEFAULT / Cr AR_CONTROL [CUSTOMER], two lines whatever the allocations', async () => {
    const customerId = await asOwner((tx) => registerParty(tx, 'CUSTOMER'))
    const payload = validateCustomerReceiptPayload({
      customerId,
      method: 'BANK',
      amount: '6000.0000',
      allocations: [
        { invoiceId: randomUUID(), amount: '4000.0000' },
        { invoiceId: randomUUID(), amount: '2000.0000' },
      ],
    })
    const built = await asOwner((tx) => buildCustomerReceiptEntry(tx, tenant.tenantId, payload))
    expect(
      built.lines.map((l) => [
        codeById.get(l.accountId),
        l.accountControl,
        l.debit,
        l.credit,
        l.partyType,
      ]),
    ).toEqual([
      ['1120', 'NONE', '6000.0000', '0.0000', null],
      ['1200', 'AR', '0.0000', '6000.0000', 'CUSTOMER'],
    ])
  })

  it('a kernel-built AR line satisfies migration 012 end to end (composite FKs, party CHECKs)', async () => {
    // Internal pipeline, test-only: proves the schema accepts what the rule
    // builds. Not a path any caller has — SALE_POSTED is RULE_NOT_ENABLED.
    const customerId = await asOwner((tx) => registerParty(tx, 'CUSTOMER'))
    const payload = validateServiceSalePayload({
      settlement: 'CREDIT',
      customerId,
      lines: [saleLine('3.000000', '833.333333', '2500.0000')],
      netAmount: '2500.0000',
    })
    const referenceId = randomUUID()
    const result = await asOwner((tx) =>
      runPostingPipeline({
        tx,
        clock,
        tenantId: tenant.tenantId,
        actorUserId: tenant.ownerId,
        event: 'SALE_POSTED',
        referenceType: 'sales_invoice',
        referenceId,
        occurredAt: '2026-09-15',
        idempotencyKey: 'kr-sale-e2e',
        fingerprint: computeRequestFingerprint({
          event: 'SALE_POSTED',
          referenceType: 'sales_invoice',
          referenceId,
          occurredAt: '2026-09-15',
          actorUserId: tenant.ownerId,
          payload,
        }),
        reversalOf: null,
        reversalReason: null,
        build: async () => ({
          postingRule: SERVICE_SALE_RULE_ID,
          series: SALE_SERIES,
          ...(await buildServiceSaleEntry(tx, tenant.tenantId, payload)),
        }),
      }),
    )
    expect(result.outcome).toBe('POSTED')
    expect(result.documentNumber).toBe('JE-2027-000001')
    const stored = await asOwner((tx) => findLinesByEntryId(tx, tenant.tenantId, result.entry.id))
    expect(
      stored.map((l) => [l.accountControl, l.partyType, l.partyId, l.debit, l.credit]),
    ).toEqual([
      ['AR', 'CUSTOMER', customerId, '2500.0000', '0.0000'],
      ['NONE', null, null, '0.0000', '2500.0000'],
    ])
  })
})
