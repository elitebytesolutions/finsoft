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
   * Takes FOR SHARE on the customer row, then checks the customer exists in
   * the tenant and is ACTIVE. Throws CUSTOMER_NOT_FOUND (unknown id and
   * another tenant's id are the same error) or CUSTOMER_INACTIVE. Called
   * inside the caller's posting transaction; the lock holds until it
   * commits, so a concurrent deactivation waits (modules.md §10).
   */
  requireActiveForPosting(tx: TenantTx, customerId: string): Promise<CustomerForPosting>

  /** No lock, no status filter. For display. Ids not found are absent from the map. */
  getRefs(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, CustomerRef>>
}
