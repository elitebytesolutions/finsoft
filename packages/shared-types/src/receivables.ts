/*
 * Response types for the receivables module (sales invoices, customer
 * receipts). docs/design/M3/api-contract.md §4.2, §4.3. See customer.ts's
 * header: the ONE place apps/web may import these shapes from (ADR-0028
 * statement 2), mapped by modules/receivables/api/mappers.ts. Money is a
 * 4dp decimal STRING, quantity/unit price are 6dp strings, dates are
 * YYYY-MM-DD or ISO-8601 UTC instants — never a runtime Date, so this file
 * has no dependency on @finsoft/validation.
 */

export type LocalDate = string
export type Instant = string

export type InvoiceStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'
export type InvoiceSettlement = 'OPEN' | 'PARTIALLY_PAID' | 'PAID'
export type ReceiptStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'
export type ReceiptMethod = 'CASH' | 'BANK'

export interface InvoiceLine {
  readonly lineNo: number
  readonly kind: 'SERVICE'
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
  readonly lineNet: string
}

export interface InvoiceAllocation {
  readonly receiptId: string
  readonly receiptNumber: string
  readonly receiptDate: LocalDate
  readonly amount: string
  readonly status: 'LIVE' | 'VOIDED'
}

export interface Invoice {
  readonly id: string
  readonly number: string | null
  readonly status: InvoiceStatus
  readonly settlement: InvoiceSettlement | null
  readonly customer: { readonly id: string; readonly code: string; readonly name: string }
  readonly invoiceDate: LocalDate
  readonly dueDate: LocalDate | null
  readonly narration: string | null
  readonly lines: readonly InvoiceLine[]
  readonly netAmount: string
  readonly outstanding: string | null
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

export interface InvoiceCalculationLine {
  readonly lineNo: number
  readonly quantity: string
  readonly unitPrice: string
  readonly lineNet: string
}

export interface InvoiceCalculation {
  readonly lines: readonly InvoiceCalculationLine[]
  readonly netAmount: string
  readonly problems: readonly {
    readonly code: 'SALE_LINE_NON_POSITIVE' | 'SALE_TOO_MANY_LINES'
    readonly lineNo: number | null
  }[]
}

export interface ReceiptOpenInvoice {
  readonly invoiceId: string
  readonly number: string
  readonly invoiceDate: LocalDate
  readonly dueDate: LocalDate | null
  readonly netAmount: string
  readonly outstanding: string
}

export interface ReceiptPreview {
  readonly openInvoices: readonly ReceiptOpenInvoice[]
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: string }[]
  readonly suggested: boolean
  readonly allocatedTotal: string
  readonly unallocated: string
  readonly problems: readonly {
    readonly code: string
    readonly invoiceId: string | null
    readonly details: unknown
  }[]
}

export interface ReceiptProposal {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly amount: string
}

export interface ReceiptAllocation {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly invoiceDate: LocalDate
  readonly amount: string
  readonly status: 'LIVE' | 'VOIDED'
}

export interface Receipt {
  readonly id: string
  readonly number: string | null
  readonly status: ReceiptStatus
  readonly customer: { readonly id: string; readonly code: string; readonly name: string }
  readonly receiptDate: LocalDate
  readonly method: ReceiptMethod | null
  readonly amount: string | null
  readonly reference: string | null
  readonly narration: string | null
  readonly proposals: readonly ReceiptProposal[]
  readonly proposalProblems: ReceiptPreview['problems']
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
