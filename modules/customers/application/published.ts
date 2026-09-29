/*
 * modules/customers/application/published.ts — the ONLY cross-module import
 * target (ADR-0028 statement 3, depcruise `cross-module-via-published-only`).
 * docs/design/M3/modules.md §3, fixed there before M3-P codes against it.
 *
 * Plain DTO types and typed error classes only — no domain entity, no
 * repository, nothing from infrastructure. A change inside
 * modules/customers/domain can never break modules/receivables, because
 * receivables never sees it.
 */
import type { TenantTx } from '@finsoft/database'

export interface CustomerRef {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly status: 'ACTIVE' | 'INACTIVE'
}

export interface CustomerForPosting extends CustomerRef {
  readonly creditDays: number
}

export type CustomerDirectoryErrorCode = 'CUSTOMER_NOT_FOUND' | 'CUSTOMER_INACTIVE'

export class CustomerDirectoryError extends Error {
  readonly code: CustomerDirectoryErrorCode

  constructor(code: CustomerDirectoryErrorCode, message: string) {
    super(message)
    this.name = 'CustomerDirectoryError'
    this.code = code
  }
}

export interface CustomerDirectory {
  /**
   * INVOICING only (I2/I4/I7). Takes FOR SHARE on the customer row, then
   * checks the customer exists in the tenant and is ACTIVE. Throws
   * CUSTOMER_NOT_FOUND (unknown id and another tenant's id are the same
   * error) or CUSTOMER_INACTIVE. Called inside the caller's posting
   * transaction; the lock holds until it commits, so a concurrent
   * deactivation waits (modules.md §10).
   */
  requireActiveForPosting(tx: TenantTx, customerId: string): Promise<CustomerForPosting>

  /**
   * PAYMENT only (R3/R5/R6 — `PostReceipt`). Accounting seat ruling R-2
   * (Council review, 2026-09-29): an inactive customer can still be paid,
   * only not invoiced — this resolves the service-sale.md §11 /
   * customer-receipt.md §3 row 8 contradiction modules.md §12 recorded as
   * open. Same lock (FOR SHARE, LOCK_REGISTRY 1a) and the same
   * CUSTOMER_NOT_FOUND behaviour as `requireActiveForPosting`, but
   * DELIBERATELY status-agnostic: it never throws CUSTOMER_INACTIVE. A
   * receipt against an inactive customer is exactly the case this method
   * exists to allow.
   */
  requireForPayment(tx: TenantTx, customerId: string): Promise<CustomerRef>

  /** No lock, no status filter. For display. Ids not found are absent from the map. */
  getRefs(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, CustomerRef>>
}
