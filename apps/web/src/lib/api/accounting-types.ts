/*
 * Wire types for the M2 accounting API, per `docs/design/M2/api-contract.md`. Hand-copied here
 * rather than imported from `@finsoft/shared-types`: the Council's follow-up PR
 * (`feature/M2-B-accounting-api`) moves these DTOs there, but that PR was only merged LOCALLY
 * into this branch to build and test against — per this lane's brief it is not pushed, so a
 * checkout of this branch alone must not depend on `@finsoft/shared-types` exports that do not
 * exist on `develop` yet. Once that follow-up lands on `develop` for real, merge develop and
 * replace this file's declarations with a re-export from `@finsoft/shared-types`
 * (`packages/shared-types/src/accounting.ts`) instead — see the M2-S delivery report, DECISIONS.
 */

export type JournalEntryStatus = 'POSTED' | 'REVERSED'

/** `GET /api/journals` list item — no lines (contract §8 decision 2: lines are on the detail route). */
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
  /** Accepted but inert in M2 — no posting rule carries a party yet (contract §3). */
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

/** `GET /api/accounts`. coa-standard.md. Read-only in M2 — see the contract doc §5. */
export interface AccountDto {
  id: string
  code: string
  name: string
  type: string
  normalBalance: 'DEBIT' | 'CREDIT'
  kind: 'HEADER' | 'POSTABLE'
  controlKind: 'NONE' | 'AR' | 'AP' | 'INVENTORY'
  role: string | null
  restricted: boolean
  /** Null for a HEADER account. The tree's edges. */
  parentId: string | null
  isActive: boolean
}

export interface AccountsResponseDto {
  accounts: AccountDto[]
}

/** `GET /api/periods`, `POST /api/periods/:id/{close,reopen}`. periods.md. */
export interface FiscalPeriodDto {
  id: string
  fiscalYear: number
  periodIndex: number
  periodStart: string
  periodEnd: string
  label: string
  status: 'OPEN' | 'CLOSED' | 'LOCKED'
}

export interface PeriodsResponseDto {
  periods: FiscalPeriodDto[]
}

export interface ReopenPeriodRequest {
  reason: string
}
