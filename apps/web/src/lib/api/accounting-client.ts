/*
 * The M2 accounting API — journals, the account ledger and the trial balance. Built against
 * `docs/design/M2/api-contract.md` (M2-B, pushed 2026-09-29), routes marked **Built** only
 * (§0 status summary). Everything here goes through `apiFetch` (`client.ts`) — same-origin
 * `/api` base, the shared 401-refresh-retry and 403 → `/unauthorized` contract, nothing
 * reimplemented.
 *
 * NOT wired here because the contract's own §5/§6 mark them blocked (no permission code, no
 * route mounted): `GET /api/accounts`, `GET /api/periods`, `POST /api/periods/:id/close`,
 * `POST /api/periods/:id/reopen`. Calling any of those would 404 — see the M2-S delivery
 * report, BLOCKED.
 */
import { apiFetch } from './client'
import type {
  JournalListQuery,
  JournalListResponse,
  JournalEntryDetail,
  LedgerQuery,
  LedgerResponse,
  PostJournalRequest,
  PostJournalResponse,
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
