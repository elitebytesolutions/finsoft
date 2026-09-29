/*
 * The M3-P receipts API — docs/design/M3/api-contract.md §2 "Receipts", §4.3. Same status as
 * invoices-client.ts: built strictly to the published contract, against NO running endpoint
 * on this branch, NOT wired to any screen (`/payments` stays mock + prototype banner until
 * M3-P merges — see this lane's report).
 */
import { apiFetch } from './client'
import type {
  CreateReceiptRequest,
  ListReceiptsQuery,
  PreviewReceiptRequest,
  Receipt,
  ReceiptListPage,
  ReceiptPreview,
  UpdateReceiptRequest,
  VersionOnlyRequest,
} from './receipts-types'

function toQueryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** R1 `GET /api/receipts` — drafts included unless filtered out. Permission: `customer.view`. */
export function listReceipts(query: ListReceiptsQuery = {}): Promise<ReceiptListPage> {
  const qs = toQueryString({
    customerId: query.customerId,
    method: query.method,
    from: query.from,
    to: query.to,
    q: query.q,
    limit: query.limit,
    cursor: query.cursor,
  })
  const statusParams = (query.status ?? []).map((s) => `status=${encodeURIComponent(s)}`)
  const joiner = qs ? '&' : '?'
  return apiFetch<ReceiptListPage>(
    `/api/receipts${qs}${statusParams.length ? joiner + statusParams.join('&') : ''}`,
  )
}

/**
 * R2 `POST /api/receipts/preview` — stateless, writes nothing, takes no lock. Permission:
 * `payment.receive`. The only sanctioned source for "allocated"/"unallocated" and the
 * oldest-first suggestion (rule 19). Neither this nor I6 is authoritative — posting
 * re-validates everything under locks.
 */
export function previewReceipt(body: PreviewReceiptRequest): Promise<ReceiptPreview> {
  return apiFetch<ReceiptPreview>('/api/receipts/preview', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** R3 `POST /api/receipts` — creates a DRAFT, posts nothing, assigns no number. Permission:
 * `payment.receive`. Idempotency-Key required. */
export function createReceipt(body: CreateReceiptRequest, idempotencyKey: string): Promise<Receipt> {
  return apiFetch<Receipt>('/api/receipts', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}

/** R4 `GET /api/receipts/:id` — proposals for a draft, allocations once posted. Permission: `customer.view`. */
export function getReceipt(id: string): Promise<Receipt> {
  return apiFetch<Receipt>(`/api/receipts/${encodeURIComponent(id)}`)
}

/** R5 `PATCH /api/receipts/:id` — DRAFT only. Permission: `payment.receive`. */
export function updateReceipt(id: string, body: UpdateReceiptRequest): Promise<Receipt> {
  return apiFetch<Receipt>(`/api/receipts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * R6 `POST /api/receipts/:id/post` — assigns the number, applies allocations. Permission:
 * `payment.receive`. Idempotency-Key required.
 */
export function postReceipt(
  id: string,
  body: VersionOnlyRequest,
  idempotencyKey: string,
): Promise<Receipt> {
  return apiFetch<Receipt>(`/api/receipts/${encodeURIComponent(id)}/post`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}

/** R7 `POST /api/receipts/:id/cancel` — DRAFT only. Permission: `payment.receive`. */
export function cancelReceipt(id: string, body: VersionOnlyRequest): Promise<Receipt> {
  return apiFetch<Receipt>(`/api/receipts/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * R8 `POST /api/receipts/:id/reverse`. Permission: `payment.receive` + `voucher.reverse`
 * (privileged). Idempotency-Key required. Voids this receipt's allocations and restores the
 * invoices' outstanding.
 */
export function reverseReceipt(
  id: string,
  body: { reason: string },
  idempotencyKey: string,
): Promise<Receipt> {
  return apiFetch<Receipt>(`/api/receipts/${encodeURIComponent(id)}/reverse`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}
