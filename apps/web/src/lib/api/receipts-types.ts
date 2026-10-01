/*
 * Wire types for the M3-P receipts surface — docs/design/M3/api-contract.md §2 "Receipts",
 * §4.3. Same status as invoices-types.ts: declared locally because `feature/M3-P-receivables`
 * is not merged into `develop` on this branch. Promote to `@finsoft/shared-types` once it is.
 */
import type { Instant, LocalDate, Money } from './invoices-types'

export type ReceiptMethod = 'CASH' | 'BANK'
export type ReceiptStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'

export interface ReceiptAllocation {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly invoiceDate: LocalDate
  readonly amount: Money
  readonly status: 'LIVE' | 'VOIDED'
}

export interface ReceiptProposal {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly amount: Money
}

export interface ReceiptProblem {
  readonly code: string
  readonly invoiceId: string | null
  readonly details: Record<string, unknown> | null
}

export interface Receipt {
  readonly id: string
  readonly number: string | null
  readonly status: ReceiptStatus
  readonly customer: { readonly id: string; readonly code: string; readonly name: string }
  readonly receiptDate: LocalDate
  readonly method: ReceiptMethod | null
  readonly amount: Money | null
  readonly reference: string | null
  readonly narration: string | null
  /** DRAFT only. */
  readonly proposals: readonly ReceiptProposal[]
  /** DRAFT only — advisory, computed at read, no lock. */
  readonly proposalProblems: readonly ReceiptProblem[]
  /** [] until POSTED. */
  readonly allocations: readonly ReceiptAllocation[]
  readonly journalEntry: { readonly id: string; readonly number: string } | null
  readonly reversal: {
    readonly entryId: string
    readonly entryNumber: string
    readonly occurredAt: LocalDate
    readonly reason: string
    readonly reversedAt: Instant
    readonly reversedBy: string
  } | null
  readonly posted: { readonly at: Instant; readonly by: string } | null
  readonly version: number
  readonly createdAt: Instant
  readonly createdBy: string
  readonly updatedAt: Instant
  readonly updatedBy: string
}

export type ReceiptListItem = Pick<
  Receipt,
  'id' | 'number' | 'status' | 'customer' | 'receiptDate' | 'method' | 'amount'
>

export interface ReceiptListPage {
  readonly items: readonly ReceiptListItem[]
  readonly nextCursor: string | null
}

export interface OpenInvoiceRow {
  readonly invoiceId: string
  readonly number: string
  readonly invoiceDate: LocalDate
  readonly dueDate: LocalDate | null
  readonly netAmount: Money
  readonly outstanding: Money
}

export interface ReceiptPreview {
  readonly openInvoices: readonly OpenInvoiceRow[]
  /** As submitted, or the server's suggestion. */
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: Money }[]
  /** True when the request had no allocations — the server filled its own suggestion. */
  readonly suggested: boolean
  readonly allocatedTotal: Money
  /** amount − allocatedTotal; must be 0.0000 to post. */
  readonly unallocated: Money
  readonly problems: readonly ReceiptProblem[]
}

export interface AllocationInput {
  invoiceId: string
  amount: Money
}

/** R3 (create draft). */
export interface CreateReceiptRequest {
  customerId: string
  receiptDate?: LocalDate
  method?: ReceiptMethod | null
  amount?: Money | null
  reference?: string | null
  narration?: string | null
  allocations?: AllocationInput[]
}

/** R5 (patch a draft) — `version` plus any field above; `allocations`, if present, replaces
 * every proposal. */
export interface UpdateReceiptRequest extends Partial<CreateReceiptRequest> {
  version: number
}

/** R2 — a stateless preview, from a not-yet-saved form or an existing draft. */
export interface PreviewReceiptRequest {
  customerId?: string
  receiptId?: string
  receiptDate?: LocalDate
  amount?: Money
  allocations?: AllocationInput[]
}

export interface VersionOnlyRequest {
  version: number
}

export interface ReasonRequest {
  reason: string
}

export interface ListReceiptsQuery {
  customerId?: string
  status?: ReceiptStatus[]
  method?: ReceiptMethod
  from?: LocalDate
  to?: LocalDate
  q?: string
  limit?: number
  cursor?: string
}
