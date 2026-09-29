/*
 * Wire types for the M2 accounting API. Response shapes come from `@finsoft/shared-types`
 * (`packages/shared-types/src/accounting.ts`) — the DTOs `apps/api` actually returns — rather
 * than a second, hand-copied set that can drift from what the API sends. Only request-side
 * shapes (query params, POST bodies), which shared-types does not carry, are declared here.
 *
 * Per `docs/design/M2/api-contract.md` (M2-B). The follow-up PR (accounts/periods, the Council
 * fix list) merged to `develop` via PR #38 — this file now imports from `@finsoft/shared-types`
 * directly instead of the hand-copied definitions an earlier commit on this branch carried while
 * that PR was local-only.
 */
export type {
  AccountDto,
  AccountLedgerLineDto as LedgerLine,
  AccountLedgerResponseDto as LedgerResponse,
  AccountsResponseDto,
  FiscalPeriodDto,
  JournalEntryDto as JournalEntrySummary,
  JournalEntryWithLinesDto as JournalEntryDetail,
  JournalLineDto as JournalEntryLine,
  JournalListResponseDto as JournalListResponse,
  PeriodsResponseDto,
  PostJournalVoucherResponseDto as PostJournalResponse,
  ReverseJournalEntryResponseDto as ReverseJournalResponse,
  TrialBalanceLineDto as TrialBalanceLine,
  TrialBalanceResponseDto as TrialBalanceResponse,
} from '@finsoft/shared-types'

export type JournalEntryStatus = 'POSTED' | 'REVERSED'

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

export interface JournalListQuery {
  status?: JournalEntryStatus
  from?: string
  to?: string
  limit?: number
  cursor?: string
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

export interface ReopenPeriodRequest {
  reason: string
}
