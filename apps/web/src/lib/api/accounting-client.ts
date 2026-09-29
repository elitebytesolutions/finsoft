/*
 * The M2 accounting API — journals, the account ledger, the trial balance, the chart of
 * accounts (read-only) and fiscal periods (view/close/reopen — no lock route in M2, Council
 * ruling). Built against `docs/design/M2/api-contract.md` on `feature/M2-B-accounting-api`
 * (merged locally into this branch only, per the M2-S brief — not pushed, not yet on
 * `develop`). Everything here goes through `apiFetch` (`client.ts`) — same-origin `/api`
 * base, the shared 401-refresh-retry and 403 → `/unauthorized` contract, nothing
 * reimplemented.
 *
 * `POST /api/accounts` and `POST /api/periods/:id/lock` are NOT wired here because they do
 * not exist — the contract's own §5/§6: account creation conflicts with the APPROVED
 * `coa-standard.md` §5 (chart is read-only in M2, a scope ruling, not a permission gap), and
 * there is no `period.lock` permission or route by the Council's explicit ruling ("build
 * view, close and reopen only"). Calling either would 404.
 */
import { apiFetch } from './client'
import type {
  AccountsResponseDto,
  FiscalPeriodDto,
  JournalListQuery,
  JournalListResponse,
  JournalEntryDetail,
  LedgerQuery,
  LedgerResponse,
  PeriodsResponseDto,
  PostJournalRequest,
  PostJournalResponse,
  ReopenPeriodRequest,
  ReverseJournalRequest,
  ReverseJournalResponse,
  TrialBalanceResponse,
} from './accounting-types'

function toQueryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** `GET /api/journals` — the voucher register. Permission: `voucher.view`. */
export function listJournals(query: JournalListQuery = {}): Promise<JournalListResponse> {
  const qs = toQueryString({
    status: query.status,
    from: query.from,
    to: query.to,
    limit: query.limit,
    cursor: query.cursor,
  })
  return apiFetch<JournalListResponse>(`/api/journals${qs}`)
}

/**
 * `GET /api/journals/:id` — voucher detail, with lines. Permission: `voucher.view`.
 * `404 entry_not_found` for an unknown id, a malformed id, or another tenant's real id —
 * identical in every case (reversal.md §3 row 1); the caller renders the shared Not-found state.
 */
export function getJournal(id: string): Promise<JournalEntryDetail> {
  return apiFetch<JournalEntryDetail>(`/api/journals/${encodeURIComponent(id)}`)
}

/**
 * `POST /api/journals` — post a journal voucher. Permission: `voucher.post`.
 *
 * `idempotencyKey` is required and must be the SAME key across every retry of one logical
 * submission (`useIdempotencyKey` — `idempotency-key.ts`) — three identical requests produce one
 * posting, `outcome: 'REPLAYED'` on the retries. A rejection throws `ApiError` with
 * `.serverCode` set to the lower-cased `PostingErrorCode` (`jv_unbalanced`, `period_closed`, …
 * — contract §7) and `.serverDetails` carrying whatever facts that code names.
 */
export function postJournal(
  body: PostJournalRequest,
  idempotencyKey: string,
): Promise<PostJournalResponse> {
  return apiFetch<PostJournalResponse>('/api/journals', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}

/**
 * `POST /api/journals/:id/reverse` — reverse a posted voucher. Permission: `voucher.reverse`
 * (privileged). Same idempotency contract as `postJournal`. `404 entry_not_found` if `id` is
 * unknown or foreign — never a 403, existence is not disclosed.
 */
export function reverseJournal(
  id: string,
  body: ReverseJournalRequest,
  idempotencyKey: string,
): Promise<ReverseJournalResponse> {
  return apiFetch<ReverseJournalResponse>(`/api/journals/${encodeURIComponent(id)}/reverse`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}

/**
 * `GET /api/ledgers/:accountId` — one account's statement with a running balance. Permission:
 * `report.financial`. `from`/`to` are both required by the contract; there is no "whole history"
 * call. `404 account_not_found` for an unknown or foreign account id.
 */
export function getLedger(accountId: string, query: LedgerQuery): Promise<LedgerResponse> {
  const qs = toQueryString({
    from: query.from,
    to: query.to,
    limit: query.limit,
    cursor: query.cursor,
    partyId: query.partyId,
  })
  return apiFetch<LedgerResponse>(`/api/ledgers/${encodeURIComponent(accountId)}${qs}`)
}

/**
 * `GET /api/reports/trial-balance` — as-of trial balance. Permission: `report.financial`.
 * The server asserts `totalDebit === totalCredit` before responding (Invariant 2); this client
 * never re-derives or "corrects" the totals it receives.
 */
export function getTrialBalance(asOf: string): Promise<TrialBalanceResponse> {
  return apiFetch<TrialBalanceResponse>(`/api/reports/trial-balance${toQueryString({ asOf })}`)
}

/**
 * `GET /api/accounts` — the full chart, headers and postable accounts, ordered by code.
 * Permission: `account.view`. Read-only: there is no create/edit/deactivate endpoint in M2
 * (`coa-standard.md` §5) — build the tree client-side from `parentId`.
 */
export function listAccounts(): Promise<AccountsResponseDto> {
  return apiFetch<AccountsResponseDto>('/api/accounts')
}

/** `GET /api/periods` — every fiscal period of the caller's tenant. Permission: `period.view`. */
export function listPeriods(): Promise<PeriodsResponseDto> {
  return apiFetch<PeriodsResponseDto>('/api/periods')
}

/**
 * `POST /api/periods/:id/close` — no body. Permission: `period.close` (Owner, Accountant).
 * Only when every earlier period is `CLOSED`/`LOCKED` — `409 period_close_out_of_order`
 * otherwise. Produces no journal entry (periods.md §7).
 */
export function closePeriod(id: string): Promise<FiscalPeriodDto> {
  return apiFetch<FiscalPeriodDto>(`/api/periods/${encodeURIComponent(id)}/close`, {
    method: 'POST',
  })
}

/**
 * `POST /api/periods/:id/reopen` — Permission: `period.reopen` (**Owner only** — `period.close`
 * does not imply it). Only the tenant's latest `CLOSED` period may be reopened —
 * `409 period_reopen_out_of_order` otherwise, `409 PERIOD_LOCKED` for a locked one. `reason` is
 * required.
 */
export function reopenPeriod(id: string, body: ReopenPeriodRequest): Promise<FiscalPeriodDto> {
  return apiFetch<FiscalPeriodDto>(`/api/periods/${encodeURIComponent(id)}/reopen`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
