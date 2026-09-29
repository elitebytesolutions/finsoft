/*
 * The M3-C customers API — docs/design/M3/api-contract.md §2 "Customers", §4.1.
 * Built against `feature/M3-C-customers`, already merged into `develop` (the base this
 * worktree was created from — e3414ce). Everything here goes through `apiFetch`
 * (`client.ts`) — same-origin `/api` base, the shared 401-refresh-retry and 403 contract,
 * nothing reimplemented.
 *
 * Response shapes come from `@finsoft/shared-types` (the DTOs `apps/api` actually
 * returns), matching `accounting-types.ts`'s own precedent. Request-side shapes (query
 * params, POST/PATCH bodies), which shared-types does not carry, are declared here.
 */
import { apiFetch } from './client'
import type { Customer, CustomerLedger, CustomerListPage } from '@finsoft/shared-types'

export type { Customer, CustomerLedger, CustomerListItem, CustomerListPage } from '@finsoft/shared-types'

export interface ListCustomersQuery {
  q?: string
  status?: 'ACTIVE' | 'INACTIVE'
  limit?: number
  cursor?: string
}

export interface CreateCustomerRequest {
  name: string
  phone?: string | null
  email?: string | null
  address?: string | null
  city?: string | null
  ntn?: string | null
  /** 0–365, default 0. */
  creditDays?: number
}

export interface UpdateCustomerRequest {
  version: number
  name?: string
  phone?: string | null
  email?: string | null
  address?: string | null
  city?: string | null
  ntn?: string | null
  creditDays?: number
}

export interface VersionOnlyRequest {
  version: number
}

export interface CustomerLedgerQuery {
  /** `YYYY-MM-DD`. Both default server-side when omitted (contract §4.1). */
  from?: string
  to?: string
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** C1 `GET /api/customers` — cursor-paginated, code ascending. Permission: `customer.view`. */
export function listCustomers(query: ListCustomersQuery = {}): Promise<CustomerListPage> {
  const qs = toQueryString({
    q: query.q,
    status: query.status,
    limit: query.limit,
    cursor: query.cursor,
  })
  return apiFetch<CustomerListPage>(`/api/customers${qs}`)
}

/**
 * C2 `POST /api/customers` — system-generated code (`CUST-000001`…), no `code` field on the
 * request (sending one is `400 VALIDATION_FAILED` — the schema is strict). Permission:
 * `customer.create`. Idempotency-Key required.
 */
export function createCustomer(
  body: CreateCustomerRequest,
  idempotencyKey: string,
): Promise<Customer> {
  return apiFetch<Customer>('/api/customers', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}

/** C3 `GET /api/customers/:id`. Permission: `customer.view`. */
export function getCustomer(id: string): Promise<Customer> {
  return apiFetch<Customer>(`/api/customers/${encodeURIComponent(id)}`)
}

/**
 * C4 `PATCH /api/customers/:id` — `code` and `status` are not editable here. Permission:
 * `customer.create` (README §10 debt: the MVP catalogue has no `customer.update`).
 */
export function updateCustomer(id: string, body: UpdateCustomerRequest): Promise<Customer> {
  return apiFetch<Customer>(`/api/customers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * C5 `POST /api/customers/:id/deactivate` — refused with `409 CUSTOMER_HAS_BALANCE` while the
 * AR balance is non-zero (`details.balance`). Permission: `customer.create`.
 */
export function deactivateCustomer(id: string, body: VersionOnlyRequest): Promise<Customer> {
  return apiFetch<Customer>(`/api/customers/${encodeURIComponent(id)}/deactivate`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** C6 `POST /api/customers/:id/reactivate`. Permission: `customer.create`. */
export function reactivateCustomer(id: string, body: VersionOnlyRequest): Promise<Customer> {
  return apiFetch<Customer>(`/api/customers/${encodeURIComponent(id)}/reactivate`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * C7 `GET /api/customers/:id/ledger` — the AR_CONTROL ledger (K5), filtered to this
 * customer, with an opening and closing balance the server computes. Permission:
 * `customer.view`. `422 LEDGER_RANGE_TOO_LARGE` (`details.maxDays: 366`) over a year.
 */
export function getCustomerLedger(id: string, query: CustomerLedgerQuery = {}): Promise<CustomerLedger> {
  const qs = toQueryString({ from: query.from, to: query.to })
  return apiFetch<CustomerLedger>(`/api/customers/${encodeURIComponent(id)}/ledger${qs}`)
}
