/*
 * Request-side shapes for the receipts API — docs/design/M3/api-contract.md §2, §4.3.
 * Response shapes come from `@finsoft/shared-types`, re-exported here for the same reason
 * invoices-types.ts gives.
 */
export type {
  Receipt,
  ReceiptAllocation,
  ReceiptListItem,
  ReceiptListPage,
  ReceiptMethod,
  ReceiptOpenInvoice,
  ReceiptPreview,
  ReceiptProposal,
  ReceiptStatus,
} from '@finsoft/shared-types'
import type { LocalDate, Money } from './invoices-types'

export type { LocalDate, Money } from './invoices-types'

export interface AllocationInput {
  invoiceId: string
  amount: Money
}

/** R3 (create draft). */
export interface CreateReceiptRequest {
  customerId: string
  receiptDate?: LocalDate
  method?: 'CASH' | 'BANK' | null
  amount?: Money | null
  reference?: string | null
  narration?: string | null
  allocations?: AllocationInput[]
}

/** R5 (patch a draft) — `version` plus any field above; `allocations`, if present, replaces
 * every proposal. */
export interface UpdateReceiptRequest {
  version: number
  customerId?: string
  receiptDate?: LocalDate
  method?: 'CASH' | 'BANK' | null
  amount?: Money | null
  reference?: string | null
  narration?: string | null
  allocations?: AllocationInput[]
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
  status?: Array<'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'>
  method?: 'CASH' | 'BANK'
  from?: LocalDate
  to?: LocalDate
  q?: string
  limit?: number
  cursor?: string
}
