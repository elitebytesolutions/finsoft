import { closeDatabase } from '@finsoft/database'
import { migrateTestDatabase, prepareTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { runPostingScenario, type PostingScenario } from './golden-posting-runner.ts'
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
 * NOT THE REAL GOLDEN FILES. Running P04-P12 verbatim against the fake hit
 * three things outside this lane's boundary to fix, reported in the M3-Q
 * report rather than worked around here (NON_NEGOTIABLES §4):
 *
 *   1. `SALE_AMOUNT_MISMATCH`'s `details.line` is a STRING in the kernel
 *      (packages/accounting-kernel/src/rules/service-sale.ts:121,
 *      `line: String(index + 1)`) but a NUMBER in every golden file that
 *      names it (P04, P10). Both are already merged (M2-A); neither is
 *      this lane's to change.
 *   2. P12 posts a 10,000.0000 invoice to CUST-A (step 1) and then expects
 *      deactivating CUST-A to SUCCEED (step 2) — but `modules/customers`'
 *      OWN, documented rule (api-contract.md §3 `CUSTOMER_HAS_BALANCE`,
 *      `modules/customers/domain/customer.ts` `assertDeactivatable`,
 *      already merged, M3-C) refuses deactivation while ANY balance is
 *      owed. The golden scenario and the merged module contradict each
 *      other.
 *   3. `invariant9Available()` is correctly, permanently false against
 *      this fake — it probes for the REAL `sales_invoices` /
 *      `customer_receipts` Postgres tables, which no fake can provide.
 *      Every golden file's `invariant9`/`customerLedger` checkpoints are
 *      therefore untestable here BY DESIGN, not by a gap in the runner.
 *
 * So this file exercises the SAME verbs and expectation shapes with small,
 * hand-built scenarios that avoid those three externalities, to prove the
 * runner code itself — not to claim P04-P12 pass. That claim can only be
 * made by `posting-scenarios-m3.spec.ts`, gated on the real module and the
 * real migrations.
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
