/*
 * Which posting golden scenarios M2 executes, and why the rest cannot yet.
 *
 * README §6: a scenario's `executableFrom` says when it can run. M2 has the
 * journal, the calendar, numbering, the party register and the kernel — but
 * no customers, sales_invoices or customer_receipts module tables, so every
 * scenario that posts SALE_POSTED or CUSTOMER_PAYMENT_RECEIVED waits for M3.
 *
 * This is a ratchet, like pending-baseline.json: golden-posting-registry.spec.ts
 * fails if a golden file is in neither list, if a pending file's own
 * `executableFrom` says M2, or if a pending step range disagrees with the
 * file's `stepsExecutableFrom`. Moving an entry from PENDING to EXECUTED is a
 * deliberate act in the PR that makes it pass.
 */

export interface ExecutedScenario {
  readonly file: string
  readonly title: string
}

export interface PendingScenario {
  readonly file: string
  /** Steps still pending; `'all'` when none of the file can run yet. */
  readonly steps: 'all' | readonly number[]
  readonly reason: string
}

export const EXECUTED_IN_M2: readonly ExecutedScenario[] = [
  { file: 'posting-p01-jv-simple.json', title: 'P01 — manual journal voucher, two lines' },
  {
    file: 'posting-p02-jv-multi-line.json',
    title: 'P02 — four-line voucher, fractional amounts, ledger',
  },
  {
    file: 'posting-p03-jv-rejections.json',
    title: 'P03 — every JV rejection, then JV-2027-000001',
  },
  {
    file: 'posting-p07-closed-period.json',
    title: 'P07 — closed/locked periods, reversal into today',
  },
  { file: 'posting-p08-idempotent-retry.json', title: 'P08 steps 1-5 — JV idempotency' },
]

const M3_TABLES = 'requires customers/sales_invoice/customer_receipt module tables (M3)'

export const PENDING: readonly PendingScenario[] = [
  { file: 'posting-p04-service-invoice.json', steps: 'all', reason: M3_TABLES },
  { file: 'posting-p05-customer-receipt.json', steps: 'all', reason: M3_TABLES },
  { file: 'posting-p06-reversal.json', steps: 'all', reason: M3_TABLES },
  {
    file: 'posting-p08-idempotent-retry.json',
    steps: [6, 7, 8, 9, 10],
    reason: 'needs sales_invoice module (M3)',
  },
  { file: 'posting-p09-mvp-journey.json', steps: 'all', reason: M3_TABLES },
  { file: 'posting-p10-service-line-rounding.json', steps: 'all', reason: M3_TABLES },
  { file: 'posting-p11-receipt-draft-lifecycle.json', steps: 'all', reason: M3_TABLES },
  { file: 'posting-p12-inactive-customer.json', steps: 'all', reason: M3_TABLES },
  {
    file: 'posting-p13-coa-create-and-rename.json',
    steps: 'all',
    reason:
      'requires migration 018 (accounts UPDATE grant, protected-row and code/parent immutability triggers) and the kernel account create/edit functions (M2-C, coa-standard.md §8)',
  },
]
