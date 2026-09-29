/*
 * Wire types for the M3-P invoices surface — docs/design/M3/api-contract.md §2 "Invoices",
 * §4.2. `modules/receivables` and its `packages/shared-types` DTOs do not exist on this
 * branch (`feature/M3-P-receivables` is not merged into `develop` as of this lane) — these
 * are declared locally, from the contract document itself, following the same precedent
 * `types.ts` set for the pre-shared-types auth surface. Promote to `@finsoft/shared-types`
 * once M3-P lands and publishes the real DTOs; this file's shapes should then be deleted in
 * favour of the real ones, not kept as a second source of truth.
 */
/** 4dp decimal string. Never parsed to a JS number in apps/web (CLAUDE.md). */
export type Money = string
/** 6dp decimal string in, 6dp out. */
export type Qty = string
export type Price = string
/** `YYYY-MM-DD`, tenant timezone. */
export type LocalDate = string
/** ISO-8601 UTC. */
export type Instant = string

export interface InvoiceLine {
  readonly lineNo: number
  readonly kind: 'SERVICE'
  readonly description: string
  readonly quantity: Qty
  readonly unitPrice: Price
  readonly lineNet: Money
}

export interface InvoiceAllocation {
  readonly receiptId: string
  readonly receiptNumber: string
  readonly receiptDate: LocalDate
  readonly amount: Money
  readonly status: 'LIVE' | 'VOIDED'
}

export interface Invoice {
  readonly id: string
  /** Null while DRAFT / CANCELLED. */
  readonly number: string | null
  readonly status: 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'
  /** Derived; POSTED only. */
  readonly settlement: 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | null
  readonly customer: { readonly id: string; readonly code: string; readonly name: string }
  readonly invoiceDate: LocalDate
  readonly dueDate: LocalDate | null
  readonly narration: string | null
  readonly lines: readonly InvoiceLine[]
  readonly netAmount: Money
  /** Null for DRAFT/CANCELLED; "0.0000" when REVERSED. */
  readonly outstanding: Money | null
  readonly allocations: readonly InvoiceAllocation[]
  readonly journalEntry: { readonly id: string; readonly number: string } | null
  readonly reversal: {
    readonly entryId: string
    readonly entryNumber: string
    readonly occurredAt: LocalDate
    readonly reason: string
    readonly reversedAt: Instant
    readonly reversedBy: string
  } | null
  /** Receipts with LIVE allocations against this invoice — advisory (I8 still enforces it). */
  readonly reversalBlockedBy: readonly { readonly id: string; readonly number: string }[]
  readonly posted: { readonly at: Instant; readonly by: string } | null
  readonly version: number
  readonly createdAt: Instant
  readonly createdBy: string
  readonly updatedAt: Instant
  readonly updatedBy: string
}

export type InvoiceListItem = Pick<
  Invoice,
  'id' | 'number' | 'status' | 'settlement' | 'customer' | 'invoiceDate' | 'dueDate' | 'netAmount' | 'outstanding'
>

export interface InvoiceListPage {
  readonly items: readonly InvoiceListItem[]
  readonly nextCursor: string | null
}

export interface InvoiceLineInput {
  description: string
  quantity: Qty
  unitPrice: Price
}

export interface CreateInvoiceRequest {
  customerId: string
  invoiceDate?: LocalDate
  dueDate?: LocalDate | null
  narration?: string | null
  lines: InvoiceLineInput[]
}

/** I4: same fields as create, plus `version` — a full replacement of the draft. */
export interface UpdateInvoiceRequest extends CreateInvoiceRequest {
  version: number
}

export interface InvoiceCalculationLine {
  readonly lineNo: number
  readonly quantity: Qty
  readonly unitPrice: Price
  readonly lineNet: Money
}

export interface InvoiceCalculation {
  readonly lines: readonly InvoiceCalculationLine[]
  readonly netAmount: Money
  readonly problems: readonly {
    readonly code: 'SALE_LINE_NON_POSITIVE' | 'SALE_TOO_MANY_LINES'
    readonly lineNo: number | null
  }[]
}

export interface ListInvoicesQuery {
  customerId?: string
  status?: Array<Invoice['status']>
  /** POSTED with outstanding > 0 — requires `customerId`. The allocation picker's source. */
  open?: boolean
  from?: LocalDate
  to?: LocalDate
  q?: string
  limit?: number
  cursor?: string
}
