import type { TenantTx } from '@finsoft/database'
import type { CustomerFields, CustomerStatus, Customer } from '../domain/customer.ts'

/*
 * Repository interfaces. ADR-0028 statement 5: "domain/ imports only its own
 * files, @finsoft/validation and @finsoft/shared-types" — a repository
 * method takes a TenantTx, so this file (which DOES import
 * @finsoft/database for that one type) lives in application/, not domain/.
 * `infrastructure/` implements this with a TYPE-ONLY import back
 * (ADR-0028's one sanctioned infrastructure -> application edge).
 */

export interface NewCustomerRow {
  /** The party id `registerParty(tx, 'CUSTOMER')` returned, in the SAME transaction. */
  readonly id: string
  /** From `documentNumbers.next(tx, { series: 'CUST' })` (K7), in the SAME transaction. */
  readonly code: string
  readonly fields: CustomerFields
  readonly createIdempotencyKey: string
  readonly createFingerprint: string
}

export interface CustomerListFilter {
  readonly q: string | null
  readonly status: readonly CustomerStatus[] | null
}

export interface CustomerListCursor {
  readonly code: string
}

export interface CustomerListPage {
  readonly items: readonly Customer[]
  readonly next: CustomerListCursor | null
}

export type CustomerPatch = Partial<CustomerFields> & { readonly status?: CustomerStatus }

export interface CustomersRepository {
  /** Replay lookup for POST /api/customers, before any lock (modules.md §9). */
  findByCreateIdempotencyKey(
    tx: TenantTx,
    key: string,
  ): Promise<{ readonly customer: Customer; readonly fingerprint: string } | null>

  insert(tx: TenantTx, row: NewCustomerRow): Promise<Customer>

  /** Plain read, no lock — GET /:id, and step 0 of a posting precondition. */
  findById(tx: TenantTx, id: string): Promise<Customer | null>

  /** FOR UPDATE (LOCK_REGISTRY 1a, write mode) — update, deactivate, reactivate. */
  lockForUpdate(tx: TenantTx, id: string): Promise<Customer | null>

  /** FOR SHARE (LOCK_REGISTRY 1a, posting mode) — CustomerDirectory.requireActiveForPosting. */
  lockForShare(tx: TenantTx, id: string): Promise<Customer | null>

  update(tx: TenantTx, id: string, patch: CustomerPatch, expectedVersion: number): Promise<Customer>

  list(
    tx: TenantTx,
    filter: CustomerListFilter,
    page: { readonly limit: number; readonly after: CustomerListCursor | null },
  ): Promise<CustomerListPage>

  /** CustomerDirectory.getRefs — no lock, no status filter, absent ids simply missing. */
  findByIds(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, Customer>>

  /**
   * K5 (AR_CONTROL balance, signed, debit-positive) as of today in the
   * tenant's own timezone. Lives on this port rather than being called
   * directly from `application/`: both the tenant id these
   * `@finsoft/reporting` reads need, and "today" itself (rule 13: the
   * server resolves a date, never the client — and here there is no client
   * date at all to validate, only a fact to read), are ambient
   * (TenantContext / the tenant's own settings row). Only infrastructure
   * legitimately reads either — via `BaseRepository`'s own accessor and
   * `findTenantTimezone`, never by importing `TenantContext` itself, which
   * is lint-fenced out of every module layer (ADR-0028 statement 6: tenant
   * and actor come from context, never a parameter).
   */
  currentBalance(
    tx: TenantTx,
    id: string,
  ): Promise<{ readonly balance: string; readonly asOf: string }>

  /**
   * Accounting seat C4 (Council review, 2026-09-29): the DEACTIVATION
   * precondition ("a customer with a non-zero balance cannot be
   * deactivated") checks whether ANY money is owed, ever — including a
   * future-dated invoice that `currentBalance`'s "as of today" bound would
   * silently miss. A customer invoiced for delivery next month still owes
   * that amount today; deactivating them because today's cut-off does not
   * yet see it would be wrong. This is deliberately a SEPARATE method from
   * `currentBalance` rather than an optional date argument on it: the two
   * have different meanings (a point-in-time DISPLAY balance vs. an
   * unbounded EXISTENCE check), and collapsing them into one signature is
   * how the wrong one gets called by a future edit that does not notice the
   * date the caller quietly defaulted to.
   */
  hasAnyBalance(tx: TenantTx, id: string): Promise<boolean>

  /** K5: the AR_CONTROL ledger of this tenant, filtered to one customer. */
  ledger(
    tx: TenantTx,
    id: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<CustomerLedgerResult>
}

export interface CustomerLedgerLineRow {
  readonly occurredAt: string
  readonly entryId: string
  readonly entryNumber: string
  readonly entryStatus: 'POSTED' | 'REVERSED'
  readonly sourceType: string
  readonly sourceId: string
  /** K4: the source document's own number (INV-…/RCT-…). Null for a JV. */
  readonly sourceNumber: string | null
  readonly narration: string
  readonly debit: string
  readonly credit: string
  readonly runningBalance: string
  readonly reversalOf: string | null
  readonly reversedBy: string | null
}

export interface CustomerLedgerResult {
  readonly openingBalance: string
  readonly closingBalance: string
  readonly lines: readonly CustomerLedgerLineRow[]
}
