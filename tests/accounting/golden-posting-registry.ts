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
 *
 * M3-P STATUS (this lane): P04, P05, P06 and P10 stay PENDING here, NOT
 * because the kernel rules are unimplemented — packages/accounting-kernel/
 * src/events.ts's IMPLEMENTED_EVENTS now includes SALE_POSTED and
 * CUSTOMER_PAYMENT_RECEIVED as of this same PR, and modules/receivables
 * posts both for real — but because `golden-posting-runner.ts` (outside
 * M3-P's ALLOWED paths; owned by the parallel M3-Q lane per
 * docs/design/M3/README.md §3) is not yet able to run them:
 * `executableSteps` throws for anything but `executableFrom: "M2"`, and its
 * `post`/`reverse` verbs call `engine.post`/`reversal.reverse` directly with
 * `referenceType` hardcoded to `'journal_voucher'` — there is no `saveDraft`/
 * `editDraft`/`cancelDraft`/`customer` verb support, and no path that drives
 * a scenario through a module's `index.ts` (ADR-0028 statement 10: "tests/
 * accounting: golden scenarios and Invariant 9, driven THROUGH THE MODULE'S
 * index.ts, not the kernel"). Flipping these four to EXECUTED_IN_M2 today
 * would make posting-scenarios.spec.ts throw immediately, not pass. See this
 * lane's delivery report (BLOCKED) — coordinate the runner update with M3-Q
 * before re-attempting this flip.
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
const M3_RUNNER = 'requires the M3-Q golden-posting-runner.ts update (module-routed execution) — see header'

export const PENDING: readonly PendingScenario[] = [
  { file: 'posting-p04-service-invoice.json', steps: 'all', reason: M3_RUNNER },
  { file: 'posting-p05-customer-receipt.json', steps: 'all', reason: M3_RUNNER },
  { file: 'posting-p06-reversal.json', steps: 'all', reason: M3_RUNNER },
  {
    file: 'posting-p08-idempotent-retry.json',
    steps: [6, 7, 8, 9, 10],
    reason: 'needs sales_invoice module (M3) and the M3-Q runner update',
  },
  { file: 'posting-p09-mvp-journey.json', steps: 'all', reason: M3_TABLES },
  { file: 'posting-p10-service-line-rounding.json', steps: 'all', reason: M3_RUNNER },
  { file: 'posting-p11-receipt-draft-lifecycle.json', steps: 'all', reason: M3_TABLES },
  { file: 'posting-p12-inactive-customer.json', steps: 'all', reason: M3_TABLES },
]
