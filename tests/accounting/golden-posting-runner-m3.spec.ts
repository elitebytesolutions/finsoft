import { closeDatabase } from '@finsoft/database'
import { migrateTestDatabase, prepareTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadScenario, runPostingScenario, type PostingScenario } from './golden-posting-runner.ts'
import { createFakeReceivablesPort } from './fixtures/fake-receivables-port.ts'

/*
 * Proves the RUNNER's OWN interpretation of the M3 posting-scenario/v1
 * verbs and expectation keys (`saveDraft`, `editDraft`, `cancelDraft`,
 * `reverseDocument`, `customer`, `invoiceOutstanding`, `customerLedger`,
 * `documentStatuses`/`documentStatus`, `documentNumbersIssued`,
 * `customerStatus`, `party` on a line, `invariant6.perCustomerResidual`)
 * against a FAKE `ReceivablesPort` (fixtures/fake-receivables-port.ts) —
 * NOT against `modules/receivables`, which does not exist on this branch.
 *
 * NOT THE REAL GOLDEN FILES for the hand-built (`R*`) scenarios below.
 * Running the REAL P04-P12 verbatim against the fake originally hit three
 * things outside this lane's boundary, reported rather than worked around
 * (NON_NEGOTIABLES §4). Two are now resolved, by the Accounting seat's
 * review of 43be499:
 *
 *   1. RESOLVED (ruling 1). `SALE_AMOUNT_MISMATCH`'s `details.line` is a
 *      STRING in the kernel (service-sale.ts:121, `String(index + 1)`);
 *      golden P04/P10 now say `"line": "2"` / `"line": "1"` to match.
 *   2. RESOLVED (ruling 2). P12 is rewritten: a customer with a balance
 *      cannot be deactivated (`CUSTOMER_HAS_BALANCE`, matching
 *      `modules/customers`' own merged rule), settles first, then can be.
 *      Proved against the fake below (`'P12 (real file)'`).
 *   3. STILL TRUE, by design, not a gap: `invariant9Available()` is
 *      correctly, permanently false against this fake — it probes for the
 *      REAL `sales_invoices` / `customer_receipts` Postgres tables, which
 *      no fake can provide. Every golden file's `invariant9`/
 *      `customerLedger` checkpoints are therefore untestable here.
 *
 * So this file exercises the SAME verbs and expectation shapes with small,
 * hand-built (`R*`) scenarios that avoid externality 3, to prove the
 * runner code itself — plus the REAL P12 file, run up to (but not
 * including) its one `invariant9` checkpoint. Neither claims P04-P11 pass
 * in full; that claim can only be made by `posting-scenarios-m3.spec.ts`,
 * gated on the real module and the real migrations.
 */

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
}, 120_000)

afterAll(async () => {
  await closeDatabase()
})

const FIXTURE_BASE = {
  timezone: 'Asia/Karachi',
  periods: { fiscalYear: 2027 },
  tenants: ['M3RUNNER'],
  customers: [{ ref: 'CUST-A', tenant: 'M3RUNNER' }],
} as const

function scenario(id: string, steps: readonly Record<string, unknown>[]): PostingScenario {
  return {
    id,
    executableFrom: 'M3',
    fixture: { ...FIXTURE_BASE, today: '2026-09-27' },
    steps,
  }
}

describe('SALE_POSTED post: success, party on the AR line, a rejection, customerLedger, documentNumbersIssued', () => {
  it('runs against the fake port', async () => {
    const receivables = createFakeReceivablesPort('2026-09-27T12:00:00.000Z')
    const s = scenario('R1', [
      {
        step: 1,
        do: 'post',
        event: 'SALE_POSTED',
        referenceType: 'sales_invoice',
        referenceId: 'INV-A1',
        idempotencyKey: 'r1-x1',
        occurredAt: '2026-09-15',
        payload: {
          settlement: 'CREDIT',
          customer: 'CUST-A',
          lines: [
            {
              kind: 'SERVICE',
              description: 'Work',
              quantity: '1.000000',
              unitPrice: '1000.000000',
              lineNet: '1000.0000',
            },
          ],
          netAmount: '1000.0001', // deliberately wrong, but never touches `line`'s type: rejected on the netAmount-vs-Σlines check.
        },
        expect: { outcome: 'REJECTED', error: 'SALE_AMOUNT_MISMATCH', entriesAfter: 0 },
      },
      {
        step: 2,
        do: 'post',
        event: 'SALE_POSTED',
        referenceType: 'sales_invoice',
        referenceId: 'INV-A1',
        idempotencyKey: 'r1-a1',
        occurredAt: '2026-09-15',
        payload: {
          settlement: 'CREDIT',
          customer: 'CUST-A',
          lines: [
            {
              kind: 'SERVICE',
              description: 'Work',
              quantity: '1.000000',
              unitPrice: '1000.000000',
              lineNet: '1000.0000',
            },
          ],
          netAmount: '1000.0000',
        },
        expect: {
          outcome: 'POSTED',
          documentNumber: 'INV-2027-000001',
          documentStatus: 'POSTED',
          lines: [
            { account: '1200', party: 'CUST-A', debit: '1000.0000', credit: '0.0000' },
            { account: '4200', debit: '0.0000', credit: '1000.0000' },
          ],
          totals: { debit: '1000.0000', credit: '1000.0000' },
          entriesAfter: 1,
        },
      },
      {
        step: 3,
        do: 'assert',
        customerLedger: {
          customer: 'CUST-A',
          from: '2026-07-01',
          to: '2026-09-27',
          openingBalance: '0.0000',
          lines: [
            {
              entryNumber: 'JE-2027-000001',
              document: 'INV-2027-000001',
              date: '2026-09-15',
              debit: '1000.0000',
              credit: '0.0000',
              runningBalance: '1000.0000',
            },
          ],
          closingBalance: '1000.0000',
        },
        documentNumbersIssued: { INV: ['INV-2027-000001'] },
      },
    ])
    await runPostingScenario(s, { receivables })
  }, 30_000)
})

describe('CUSTOMER_PAYMENT_RECEIVED: allocation rejection (module-level, not the kernel), post, reverseDocument, documentStatus as an object', () => {
  it('runs against the fake port', async () => {
    const receivables = createFakeReceivablesPort('2026-09-27T12:00:00.000Z')
    const s = scenario('R2', [
      {
        step: 1,
        do: 'post',
        event: 'SALE_POSTED',
        referenceType: 'sales_invoice',
        referenceId: 'INV-A1',
        idempotencyKey: 'r2-inv',
        occurredAt: '2026-09-15',
        payload: {
          settlement: 'CREDIT',
          customer: 'CUST-A',
          lines: [
            {
              kind: 'SERVICE',
              description: 'Work',
              quantity: '1.000000',
              unitPrice: '1000.000000',
              lineNet: '1000.0000',
            },
          ],
          netAmount: '1000.0000',
        },
        expect: { outcome: 'POSTED', documentNumber: 'INV-2027-000001' },
      },
      {
        step: 2,
        do: 'post',
        event: 'CUSTOMER_PAYMENT_RECEIVED',
        referenceType: 'customer_receipt',
        referenceId: 'RCT-X1',
        idempotencyKey: 'r2-x1',
        occurredAt: '2026-09-20',
        payload: {
          customer: 'CUST-A',
          method: 'BANK',
          amount: '1000.0001',
          allocations: [{ invoice: 'INV-A1', amount: '1000.0001' }],
        },
        expect: {
          outcome: 'REJECTED',
          error: 'ALLOCATION_EXCEEDS_OUTSTANDING',
          errorDetail: { invoice: 'INV-A1', outstanding: '1000.0000', requested: '1000.0001' },
          entriesAfter: 1,
        },
      },
      {
        step: 3,
        do: 'post',
        event: 'CUSTOMER_PAYMENT_RECEIVED',
        referenceType: 'customer_receipt',
        referenceId: 'RCT-A1',
        idempotencyKey: 'r2-rct',
        occurredAt: '2026-09-20',
        payload: {
          customer: 'CUST-A',
          method: 'BANK',
          amount: '1000.0000',
          allocations: [{ invoice: 'INV-A1', amount: '1000.0000' }],
        },
        expect: {
          outcome: 'POSTED',
          documentNumber: 'RCT-2027-000001',
          documentStatus: 'POSTED',
          lines: [
            { account: '1120', debit: '1000.0000', credit: '0.0000' },
            { account: '1200', party: 'CUST-A', debit: '0.0000', credit: '1000.0000' },
          ],
          totals: { debit: '1000.0000', credit: '1000.0000' },
          entriesAfter: 2,
        },
      },
      {
        step: 4,
        do: 'assert',
        invoiceOutstanding: { 'INV-A1': '0.0000' },
      },
      {
        step: 5,
        do: 'reverseDocument',
        document: 'RCT-A1',
        idempotencyKey: 'r2-rev-rct',
        reason: 'Test reversal',
        expect: {
          outcome: 'POSTED',
          reversalOf: 'JE-2027-000002',
          lines: [
            { account: '1200', party: 'CUST-A', debit: '1000.0000', credit: '0.0000' },
            { account: '1120', debit: '0.0000', credit: '1000.0000' },
          ],
          totals: { debit: '1000.0000', credit: '1000.0000' },
          // Object form, as P06/P09's golden files write it (verbatim).
          documentStatus: { 'RCT-A1': 'REVERSED' },
          entriesAfter: 3,
        },
      },
      {
        step: 6,
        do: 'assert',
        invoiceOutstanding: { 'INV-A1': '1000.0000' },
        invariant6: {
          perAccountResidual: { '1120': '0.0000', '1200': '0.0000' },
          perCustomerResidual: { 'CUST-A': '0.0000' },
        },
      },
    ])
    await runPostingScenario(s, { receivables })
  }, 30_000)
})

describe('receipt draft lifecycle: saveDraft, editDraft, cancelDraft — no GL, allocation or numbering effect', () => {
  it('runs against the fake port', async () => {
    const receivables = createFakeReceivablesPort('2026-09-27T12:00:00.000Z')
    const s = scenario('R3', [
      {
        step: 1,
        do: 'post',
        event: 'SALE_POSTED',
        referenceType: 'sales_invoice',
        referenceId: 'INV-A1',
        idempotencyKey: 'r3-inv',
        occurredAt: '2026-09-15',
        payload: {
          settlement: 'CREDIT',
          customer: 'CUST-A',
          lines: [
            {
              kind: 'SERVICE',
              description: 'Work',
              quantity: '1.000000',
              unitPrice: '1000.000000',
              lineNet: '1000.0000',
            },
          ],
          netAmount: '1000.0000',
        },
        expect: { outcome: 'POSTED', documentNumber: 'INV-2027-000001', entriesAfter: 1 },
      },
      {
        step: 2,
        do: 'saveDraft',
        documentType: 'customer_receipt',
        document: 'RCT-D1',
        fields: {
          customer: 'CUST-A',
          method: 'BANK',
          receiptDate: '2026-09-20',
          amount: '1000.0000',
          allocations: [{ invoice: 'INV-A1', amount: '1000.0000' }],
        },
        expect: {
          documentStatus: 'DRAFT',
          documentNumber: null,
          allocations: [{ invoice: 'INV-A1', amount: '1000.0000', status: 'PROPOSED' }],
          journalEntriesWritten: 0,
          entriesAfter: 1,
        },
      },
      {
        step: 3,
        do: 'editDraft',
        documentType: 'customer_receipt',
        document: 'RCT-D1',
        fields: { receiptDate: '2026-09-21' },
        expect: {
          documentStatus: 'DRAFT',
          documentNumber: null,
          journalEntriesWritten: 0,
          entriesAfter: 1,
        },
      },
      {
        step: 4,
        do: 'cancelDraft',
        documentType: 'customer_receipt',
        document: 'RCT-D1',
        reason: 'Entered in error',
        expect: {
          outcome: 'TRANSITIONED',
          documentStatus: 'CANCELLED',
          documentNumber: null,
          journalEntriesWritten: 0,
          entriesAfter: 1,
        },
      },
      {
        step: 5,
        do: 'assert',
        documentNumbersIssued: { RCT: [] },
        journalEntryCount: 1,
      },
    ])
    await runPostingScenario(s, { receivables })
  }, 30_000)
})

describe('customer verb: deactivate/reactivate a zero-balance customer through the REAL modules/customers', () => {
  it('runs against the fake port (the receivables port is not needed for this verb)', async () => {
    const s = scenario('R4', [
      {
        step: 1,
        do: 'customer',
        customer: 'CUST-A',
        action: 'deactivate',
        expect: {
          outcome: 'TRANSITIONED',
          customerStatus: 'INACTIVE',
          journalEntriesWritten: 0,
          entriesAfter: 0,
        },
      },
      {
        step: 2,
        do: 'assert',
        customerStatus: { 'CUST-A': 'INACTIVE' },
      },
      {
        step: 3,
        do: 'customer',
        customer: 'CUST-A',
        action: 'reactivate',
        expect: {
          outcome: 'TRANSITIONED',
          customerStatus: 'ACTIVE',
          journalEntriesWritten: 0,
          entriesAfter: 0,
        },
      },
    ])
    // No receivables port passed — proves the `customer` verb needs none.
    await runPostingScenario(s)
  }, 30_000)
})

describe('P12 (real file, rewritten per Accounting seat ruling 2) against the fake port', () => {
  it('runs every step through the real file, up to (not including) its one invariant9 checkpoint', async () => {
    const scenario = loadScenario('posting-p12-inactive-customer.json')
    const receivables = createFakeReceivablesPort(`${scenario.fixture.today}T12:00:00.000Z`)

    /*
     * Step 13 (the file's final assert) names `invariant9`, which this
     * FAKE port cannot satisfy — M3-P merged (@2a02731), so
     * `invariant9Available()` is now genuinely true (real tables, real
     * IMPLEMENTED_EVENTS), and `checkInvariant9` runs for real rather than
     * reporting "unavailable". But this fake port posts SALE_POSTED /
     * CUSTOMER_PAYMENT_RECEIVED straight through the kernel
     * (`fake-receivables-port.ts`'s own design) without ever writing a
     * `sales_invoices`/`customer_receipts` row — the GL side of
     * invariant9 has real postings, the subledger side has none, so the
     * per-customer comparison now fails on a genuine (gl, sub) mismatch,
     * not on unavailability. Steps 1-12 are the whole of ruling 2's
     * rewrite (the balance-blocked deactivation, the settlement, the
     * successful deactivation, the CUSTOMER_INACTIVE invoice rejection,
     * the reversal of a receipt from an inactive customer, the receipt an
     * inactive customer can still make, reactivation, and the real
     * invoice post) — every one of them runs for real here. A failure
     * with a DIFFERENT message than the expected invariant9-mismatch one
     * means an EARLIER step broke, and this test fails loudly on that,
     * not silently on step 13.
     */
    const error = await runPostingScenario(scenario, { receivables }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error, 'expected the scenario to fail exactly at step 13 (invariant9)').not.toBeNull()
    expect(String(error)).toMatch(/P12 step 13: invariant9/)
  }, 30_000)
})
