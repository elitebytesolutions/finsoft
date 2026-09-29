/*
 * Wire types for the M2 accounting API, per `docs/design/M2/api-contract.md` (M2-B, pushed
 * 2026-09-29). Only the routes that contract marks **Built** have a client function in
 * `accounting-client.ts` — journals (list/get/post/reverse), the account ledger, and the trial
 * balance. `GET /api/accounts` and every `/api/periods` route are specified in the contract but
 * have **no route mounted yet** (§5, §6 — blocked on a permission-catalogue decision this lane
 * cannot make); their types are not declared here to avoid tempting a caller into wiring against
 * an endpoint that will 404. See the M2-S delivery report, BLOCKED.
 *
 * Every amount is a decimal STRING, exactly as it crosses the wire (ADR-0011/0014) — never
 * converted to a number here or anywhere downstream. Feed it straight to `MoneyCell`/
 * `DebitCreditCell`, or to `@finsoft/validation`'s `Money.from` if it must be computed on
 * (`accounting/voucher-totals.ts` is the one place that happens, and only for the not-yet-posted
 * form's own totals).
 */

export type JournalEntryStatus = 'POSTED' | 'REVERSED'

/** `GET /api/journals` list item — no lines (§8 decision 2: lines are on the detail route). */
export interface JournalEntrySummary {
  id: string
  entryNumber: string
  postingRule: string
  event: string
  occurredAt: string
  status: JournalEntryStatus
  narration: string
  reference: string | null
  sourceType: string
  sourceId: string
  reversalOf: string | null
  reversedBy: string | null
  reversalReason: string | null
}

export interface JournalEntryLine {
  lineNumber: number
  accountId: string
  debit: string
  credit: string
  partyId: string | null
  memo: string | null
}

/** `GET /api/journals/:id` and the response of `POST /api/journals`. */
export interface JournalEntryDetail extends JournalEntrySummary {
  lines: JournalEntryLine[]
}

/** `POST /api/journals` response — `outcome` distinguishes a first post from an idempotent replay. */
export interface PostJournalResponse extends JournalEntryDetail {
  outcome: 'POSTED' | 'REPLAYED'
}

export interface PostJournalLineInput {
  accountId: string
  /** Exactly one of `debit`/`credit` per line — the other key is omitted, not `"0.0000"`. */
  debit?: string
  credit?: string
  memo?: string
}

export interface PostJournalRequest {
  /** `YYYY-MM-DD`, tenant-timezone business date. */
  occurredAt: string
  narration: string
  reference?: string | null
  lines: PostJournalLineInput[]
}

export interface ReverseJournalRequest {
  reason: string
}

/** `disclosure` is present only when the reversal was dated today because E's period had closed. */
export interface ReverseJournalResponse extends JournalEntryDetail {
  disclosure: { originalPeriod: string; originalPeriodStatus: string } | null
}

export interface JournalListQuery {
  status?: JournalEntryStatus
  from?: string
  to?: string
  limit?: number
  cursor?: string
}

export interface JournalListResponse {
  items: JournalEntrySummary[]
  nextCursor: string | null
}

export interface LedgerLine {
  lineId: string
  entryId: string
  entryNumber: string
  entryStatus: JournalEntryStatus
  occurredAt: string
  narration: string
  sourceType: string
  sourceId: string
  reversalOf: string | null
  reversedBy: string | null
  /** Signed, debit-positive — a credit balance is a negative string (ledger-and-trial-balance.md §2). */
  debit: string
  credit: string
  runningBalance: string
}

export interface LedgerResponse {
  accountId: string
  code: string
  name: string
  type: string
  openingBalance: string
  closingBalance: string
  lines: LedgerLine[]
  nextCursor: string | null
}

export interface LedgerQuery {
  /** Both required by the contract — there is no "whole history" call. */
  from: string
  to: string
  limit?: number
  cursor?: string
  /** Accepted but inert in M2 — no posting rule carries a party yet (contract §8 decision 5). */
  partyId?: string
}

export interface TrialBalanceLine {
  accountId: string
  code: string
  name: string
  type: string
  debit: string
  credit: string
}

export interface TrialBalanceResponse {
  asOf: string
  lines: TrialBalanceLine[]
  totalDebit: string
  totalCredit: string
}
