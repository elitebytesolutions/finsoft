/*
 * Response types for the customers module. docs/design/M3/api-contract.md §4.1.
 *
 * These are the ONE place apps/web (once M4 wires the screens) may import a
 * customer shape from (ARCHITECTURE §2 / ADR-0028 statement 2: a module's
 * response types live in packages/shared-types, mapped by the module's api/
 * layer — never re-exported from modules/*\/domain, which apps/web can never
 * reach). Money is a 4dp decimal STRING (ADR-0011/ADR-0014); dates are
 * YYYY-MM-DD business dates or ISO-8601 UTC instants, never a Date object,
 * so this file has no dependency on @finsoft/validation or any runtime.
 */

export type LocalDate = string
export type Instant = string

export interface Customer {
  readonly id: string
  /** CUST-000001 …, system-generated at create from the tenant's CUST series; immutable. */
  readonly code: string
  readonly name: string
  readonly phone: string | null
  readonly email: string | null
  readonly address: string | null
  readonly city: string | null
  readonly ntn: string | null
  readonly creditDays: number
  readonly status: 'ACTIVE' | 'INACTIVE'
  /** Signed, debit-positive: the AR_CONTROL ledger balance for this party (K5). */
  readonly balance: string
  readonly balanceAsOf: LocalDate
  readonly version: number
  readonly createdAt: Instant
  readonly createdBy: string
  readonly updatedAt: Instant
  readonly updatedBy: string
}

export type CustomerListItem = Pick<
  Customer,
  'id' | 'code' | 'name' | 'phone' | 'city' | 'status' | 'balance' | 'balanceAsOf'
>

export interface CustomerListPage {
  readonly items: readonly CustomerListItem[]
  readonly nextCursor: string | null
}

export interface CustomerLedgerLine {
  readonly occurredAt: LocalDate
  readonly entryId: string
  /** JE-… or RV-…. */
  readonly entryNumber: string
  readonly sourceType: 'sales_invoice' | 'customer_receipt' | 'journal_voucher' | null
  readonly sourceId: string | null
  /**
   * INV-… / RCT-… (K4) — null for a journal voucher (whose `reference` is
   * free text the user typed, not a document number) and for any other
   * `sourceType` not on a document-type allow-list
   * (`packages/database`'s `REFERENCE_IS_A_DOCUMENT_NUMBER_FOR`).
   */
  readonly sourceNumber: string | null
  readonly narration: string
  readonly debit: string
  readonly credit: string
  /** Signed, in ledger order. */
  readonly runningBalance: string
  readonly reversedBy: { readonly entryId: string; readonly entryNumber: string } | null
  readonly reverses: {
    readonly entryId: string
    readonly entryNumber: string
    /** Null when the reversed entry's reason was not resolvable from this read (see api/mappers.ts). */
    readonly reason: string | null
  } | null
}

export interface CustomerLedger {
  readonly customer: { readonly id: string; readonly code: string; readonly name: string }
  readonly from: LocalDate
  readonly to: LocalDate
  /** Signed; Σ(debit − credit) of lines before `from`. */
  readonly openingBalance: string
  readonly lines: readonly CustomerLedgerLine[]
  readonly totals: { readonly debit: string; readonly credit: string }
  /** = openingBalance + Σ(debit − credit). */
  readonly closingBalance: string
}
