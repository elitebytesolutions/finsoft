/*
 * Request-side shapes for the invoices API — docs/design/M3/api-contract.md §2, §4.2.
 * Response shapes (`Invoice`, `InvoiceListItem`, `InvoiceCalculation`, …) come from
 * `@finsoft/shared-types` (`packages/shared-types/src/receivables.ts`), the one place
 * apps/web may import a receivables DTO from (ADR-0028 statement 2) — re-exported here so
 * every other file in this directory imports both request and response shapes from one
 * place, matching customers-client.ts's own precedent.
 */
export type {
  Invoice,
  InvoiceAllocation,
  InvoiceCalculation,
  InvoiceCalculationLine,
  InvoiceLine,
  InvoiceListItem,
  InvoiceListPage,
  InvoiceSettlement,
  InvoiceStatus,
} from '@finsoft/shared-types'

/** 4dp decimal string. Never parsed to a JS number in apps/web (CLAUDE.md). */
export type Money = string
/** 6dp decimal string in, 6dp out. */
export type Qty = string
export type Price = string
/** `YYYY-MM-DD`, tenant timezone. */
export type LocalDate = string

export interface InvoiceLineInput {
  description: string
  quantity: Qty
  unitPrice: Price
}

/** I2 — the schema is `.strict()`: no extra keys, including no `code`. */
export interface CreateInvoiceRequest {
  customerId: string
  invoiceDate?: LocalDate
  dueDate?: LocalDate | null
  narration?: string | null
  lines: InvoiceLineInput[]
}

/** I4 — same fields as create, plus `version`; a full replacement of the draft. */
export interface UpdateInvoiceRequest extends CreateInvoiceRequest {
  version: number
}

export interface ListInvoicesQuery {
  customerId?: string
  status?: Array<'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'>
  /** POSTED with outstanding > 0 — requires `customerId`. The allocation picker's source. */
  open?: boolean
  from?: LocalDate
  to?: LocalDate
  q?: string
  limit?: number
  cursor?: string
}
