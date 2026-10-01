/*
 * Which posting golden scenarios run, through which runner, and why any
 * that are still pending cannot yet.
 *
 * README §6: a scenario's `executableFrom` says when it can run. This is a
 * ratchet, like pending-baseline.json: golden-posting-registry.spec.ts fails
 * if a golden file is in none of the lists below, if an M2 entry's own
 * `executableFrom` says otherwise, or if a pending step range disagrees with
 * the file's `stepsExecutableFrom`. Moving an entry is a deliberate act in
 * the PR that makes it pass for real.
 *
 * M3-Q STATUS (2026-10-01, M3-P @2a02731+ merged): every M3 posting golden
 * scenario now executes. `golden-posting-runner.ts` gained the module-routed
 * path ADR-0028 statement 10 asks for (`saveDraft`/`editDraft`/`cancelDraft`/
 * `customer` verbs, a `post`/`reverse` path that drives `sales_invoice`/
 * `customer_receipt` sources through `modules/receivables`'s own `index.ts`,
 * and a `level: "kernel"` escape for the handful of kernel-only rejections
 * the module's own command shape cannot reproduce), and `modules/receivables`
 * exists and posts both SALE_POSTED and CUSTOMER_PAYMENT_RECEIVED for real.
 * M3-Q's own `PENDING` was empty — not a weakening of this ratchet, the
 * thing it was tracking (closed, per TD-015, docs/TECH_DEBT.md) — but P13
 * (M2-C, chart-of-accounts create/edit, merged separately) is outside M3-Q's
 * scope and stays genuinely pending: see its own entry below.
 *
 * P04-P06, P08's invoice steps (6-9), P09, P10, P11 and P12 run through
 * `posting-scenarios-m3.spec.ts`, against the REAL module (`EXECUTED_IN_M3`
 * below) — not `posting-scenarios.spec.ts`'s M2-only runner, which cannot
 * drive a document source at all. P08's JV steps (1-5) still run in M2's own
 * file too (`EXECUTED_IN_M2`); `golden-posting-registry.spec.ts` checks both
 * halves against the SAME file's `stepsExecutableFrom`, exactly as it always
 * has for a dual-subset scenario.
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

/**
 * `posting-scenarios-m3.spec.ts`, against the real `modules/receivables`
 * (`ReceivablesPort`, `receivables-real-port.ts`) — never a fake, never a
 * throwaway merge. `runPostingScenario`'s `'ALL'` milestone (golden-posting-
 * runner.ts) runs P08 as all ten of its own steps in one session, so its
 * `entriesAfter` counts (which assume the three JV entries from steps 1-3)
 * reconcile; every other entry here runs its whole file (`executableFrom:
 * "M3"`, no `stepsExecutableFrom` subset).
 */
export const EXECUTED_IN_M3: readonly ExecutedScenario[] = [
  { file: 'posting-p04-service-invoice.json', title: 'P04 — service invoice' },
  { file: 'posting-p05-customer-receipt.json', title: 'P05 — partial customer receipt' },
  { file: 'posting-p06-reversal.json', title: 'P06 — reversal' },
  { file: 'posting-p08-idempotent-retry.json', title: 'P08 steps 6-10 — invoice idempotency' },
  { file: 'posting-p09-mvp-journey.json', title: 'P09 — the MVP journey' },
  { file: 'posting-p10-service-line-rounding.json', title: 'P10 — service-line rounding' },
  { file: 'posting-p11-receipt-draft-lifecycle.json', title: 'P11 — receipt draft lifecycle' },
  { file: 'posting-p12-inactive-customer.json', title: 'P12 — inactive customer' },
]

/*
 * P13 (M2-C, coa-standard.md §8) is NOT an M3-Q scenario and is untouched by
 * that lane's work — it stays its own, single-entry PENDING list rather than
 * joining the now-empty M3 one.
 */
export const PENDING: readonly PendingScenario[] = [
  {
    file: 'posting-p13-coa-create-and-rename.json',
    steps: 'all',
    reason:
      'M2-C: migration 018 (accounts UPDATE grant, protected-row and code/parent immutability ' +
      'triggers) and the kernel account create/edit functions (chartOfAccounts.create/update, ' +
      "coa-standard.md §8) now exist. What remains is the runner learning the 'account' step " +
      "verb (create/rename) — not built by this lane; posting-p13's own status field records the " +
      'same remaining gap',
  },
]
