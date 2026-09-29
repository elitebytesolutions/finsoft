/*
 * The M3-P invoices API — docs/design/M3/api-contract.md §2 "Invoices", §4.2. Built strictly
 * to the published contract, against NO running endpoint on this branch
 * (`feature/M3-P-receivables` is not merged into `develop` as of this lane — see this lane's
 * report). Every call goes through `apiFetch` (`client.ts`), same as every other client in
 * this directory — same-origin `/api` base, the shared 401-refresh-retry and 403 contract.
 *
 * NOT WIRED TO ANY SCREEN YET. `/sales/voucher`, `/sales/:id` and `/sales` stay on mock data
 * and the prototype banner (`shell.tsx`'s `API_BACKED_ROUTES` does not list them) until M3-P
 * merges — this lane's brief, §"Invoice and Receipt screens". Switching a screen on is meant
 * to be a small, mechanical change once that lands: adapt real `Invoice`/`InvoiceListItem`
 * into whatever shape the ported mock screen already reads (the same pattern
 * `apps/web/src/lib/adapters/customers.ts` used for customers), add the route to
 * `API_BACKED_ROUTES`, done.
 */
import { apiFetch } from './client'
import type {
  CreateInvoiceRequest,
  Invoice,
  InvoiceCalculation,
  InvoiceLineInput,
  InvoiceListPage,
  ListInvoicesQuery,
  UpdateInvoiceRequest,
} from './invoices-types'

function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** I1 `GET /api/invoices`. Permission: `customer.view`. */
export function listInvoices(query: ListInvoicesQuery = {}): Promise<InvoiceListPage> {
  const qs = toQueryString({
    customerId: query.customerId,
    open: query.open,
    from: query.from,
    to: query.to,
    q: query.q,
    limit: query.limit,
    cursor: query.cursor,
  })
  const statusParams = (query.status ?? []).map((s) => `status=${encodeURIComponent(s)}`)
  const joiner = qs ? '&' : '?'
  return apiFetch<InvoiceListPage>(
    `/api/invoices${qs}${statusParams.length ? joiner + statusParams.join('&') : ''}`,
  )
}

/** I2 `POST /api/invoices` — creates a DRAFT. Permission: `invoice.create`. Idempotency-Key required. */
export function createInvoice(body: CreateInvoiceRequest, idempotencyKey: string): Promise<Invoice> {
  return apiFetch<Invoice>('/api/invoices', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}

/** I3 `GET /api/invoices/:id`. Permission: `customer.view`. */
export function getInvoice(id: string): Promise<Invoice> {
  return apiFetch<Invoice>(`/api/invoices/${encodeURIComponent(id)}`)
}

/** I4 `PUT /api/invoices/:id` — full replacement of a DRAFT. Permission: `invoice.create`. */
export function updateInvoice(id: string, body: UpdateInvoiceRequest): Promise<Invoice> {
  return apiFetch<Invoice>(`/api/invoices/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/** I5 `POST /api/invoices/:id/cancel` — DRAFT only. Permission: `invoice.create`. */
export function cancelInvoice(id: string, body: { version: number }): Promise<Invoice> {
  return apiFetch<Invoice>(`/api/invoices/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * I6 `POST /api/invoices/calculate` — stateless, writes nothing. Permission: `invoice.create`.
 * The only sanctioned way to show a line net or a total while the user types (rule 19: no
 * money arithmetic in the browser) — this runs the same domain function posting runs.
 */
export function calculateInvoice(lines: InvoiceLineInput[]): Promise<InvoiceCalculation> {
  return apiFetch<InvoiceCalculation>('/api/invoices/calculate', {
    method: 'POST',
    body: JSON.stringify({ lines }),
  })
}

/** I7 `POST /api/invoices/:id/post`. Permission: `invoice.post`. Idempotency-Key required. */
export function postInvoice(
  id: string,
  body: { version: number },
  idempotencyKey: string,
): Promise<Invoice> {
  return apiFetch<Invoice>(`/api/invoices/${encodeURIComponent(id)}/post`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}

/**
 * I8 `POST /api/invoices/:id/reverse`. Permission: `invoice.post` + `voucher.reverse`
 * (privileged). Idempotency-Key required. `reversalBlockedBy` on the read `Invoice` is
 * advisory; this still enforces it under the lock.
 */
export function reverseInvoice(
  id: string,
  body: { reason: string },
  idempotencyKey: string,
): Promise<Invoice> {
  return apiFetch<Invoice>(`/api/invoices/${encodeURIComponent(id)}/reverse`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}
