/*
 * modules/receivables — the composition root. ADR-0028 statement 3: exports
 * use-case factories that build their own repositories internally, plus the
 * api/ contract. apps/api, apps/worker and tests/** are the callers.
 *
 * `customerDirectory` is NOT built here — it comes from `modules/customers`
 * (the published interface's one concrete implementation, modules.md §3)
 * and is injected by apps/api's composition (apps/api/src/app.module.ts),
 * exactly as modules.md §3 describes: "apps/api builds it and passes it
 * into the receivables use-case factories."
 */
import type { CustomerDirectory } from '@finsoft/customers/published'
import { InvoicesRepository } from './infrastructure/invoices.repository.ts'
import { ReceiptsRepository } from './infrastructure/receipts.repository.ts'
import { createCreateInvoiceDraft } from './application/create-invoice-draft.ts'
import { createUpdateInvoiceDraft } from './application/update-invoice-draft.ts'
import { createCancelInvoiceDraft } from './application/cancel-invoice-draft.ts'
import { createCalculateInvoice } from './application/calculate-invoice.ts'
import { createPostInvoice } from './application/post-invoice.ts'
import { createReverseInvoice } from './application/reverse-invoice.ts'
import { createListInvoices } from './application/list-invoices.ts'
import { createGetInvoice } from './application/get-invoice.ts'
import { createPreviewReceipt } from './application/preview-receipt.ts'
import { createCreateReceiptDraft } from './application/create-receipt-draft.ts'
import { createUpdateReceiptDraft } from './application/update-receipt-draft.ts'
import { createCancelReceiptDraft } from './application/cancel-receipt-draft.ts'
import { createPostReceipt } from './application/post-receipt.ts'
import { createReverseReceipt } from './application/reverse-receipt.ts'
import { createListReceipts } from './application/list-receipts.ts'
import { createGetReceipt } from './application/get-receipt.ts'
import { createGetCustomerRef } from './application/get-customer-ref.ts'

export function createReceivablesUseCases(customerDirectory: CustomerDirectory) {
  const invoicesRepo = new InvoicesRepository()
  const receiptsRepo = new ReceiptsRepository()

  return {
    createInvoiceDraft: createCreateInvoiceDraft(invoicesRepo, customerDirectory),
    updateInvoiceDraft: createUpdateInvoiceDraft(invoicesRepo, customerDirectory),
    cancelInvoiceDraft: createCancelInvoiceDraft(invoicesRepo, customerDirectory),
    calculateInvoice: createCalculateInvoice(),
    postInvoice: createPostInvoice(invoicesRepo, customerDirectory),
    reverseInvoice: createReverseInvoice(invoicesRepo, customerDirectory),
    listInvoices: createListInvoices(invoicesRepo, customerDirectory),
    getInvoice: createGetInvoice(invoicesRepo, customerDirectory),

    previewReceipt: createPreviewReceipt(receiptsRepo, invoicesRepo),
    createReceiptDraft: createCreateReceiptDraft(receiptsRepo, invoicesRepo, customerDirectory),
    updateReceiptDraft: createUpdateReceiptDraft(receiptsRepo, invoicesRepo, customerDirectory),
    cancelReceiptDraft: createCancelReceiptDraft(receiptsRepo, invoicesRepo, customerDirectory),
    postReceipt: createPostReceipt(receiptsRepo, invoicesRepo, customerDirectory),
    reverseReceipt: createReverseReceipt(receiptsRepo, invoicesRepo, customerDirectory),
    listReceipts: createListReceipts(receiptsRepo, customerDirectory),
    getReceipt: createGetReceipt(receiptsRepo, invoicesRepo, customerDirectory),

    getCustomerRef: createGetCustomerRef(customerDirectory),
  }
}

export type ReceivablesUseCases = ReturnType<typeof createReceivablesUseCases>

// ---------------------------------------------------------------------------
// Command / query / result types — apps/api's controllers need these to
// build a command and to type a use case's return value.
// ---------------------------------------------------------------------------
export type { Actor } from './application/actor.ts'
export type {
  CreateInvoiceDraftCommand,
  CreateInvoiceDraftResult,
} from './application/create-invoice-draft.ts'
export type { UpdateInvoiceDraftCommand } from './application/update-invoice-draft.ts'
export type { CancelInvoiceDraftCommand } from './application/cancel-invoice-draft.ts'
export type { CalculateInvoiceCommand } from './application/calculate-invoice.ts'
export type { PostInvoiceCommand, PostInvoiceResult } from './application/post-invoice.ts'
export type { ReverseInvoiceCommand, ReverseInvoiceResult } from './application/reverse-invoice.ts'
export type {
  InvoiceListItemWithCustomer,
  ListInvoicesQuery,
  ListInvoicesResult,
} from './application/list-invoices.ts'
export type { GetInvoiceResult } from './application/get-invoice.ts'

export type {
  PreviewReceiptCommand,
  ReceiptPreviewOpenInvoice,
  ReceiptPreviewResult,
} from './application/preview-receipt.ts'
export type {
  CreateReceiptDraftCommand,
  CreateReceiptDraftResult,
} from './application/create-receipt-draft.ts'
export type { UpdateReceiptDraftCommand } from './application/update-receipt-draft.ts'
export type { CancelReceiptDraftCommand } from './application/cancel-receipt-draft.ts'
export type { PostReceiptCommand, PostReceiptResult } from './application/post-receipt.ts'
export type { ReverseReceiptCommand, ReverseReceiptResult } from './application/reverse-receipt.ts'
export type {
  ListReceiptsQuery,
  ListReceiptsResult,
  ReceiptListItemWithCustomer,
} from './application/list-receipts.ts'
export type { GetReceiptResult } from './application/get-receipt.ts'

export type {
  InvoiceAllocationView,
  InvoiceListCursor,
  LiveAllocationRef,
  ReceiptAllocationRow,
  ReceiptListCursor,
  ReceiptProposalRow,
} from './application/ports.ts'

// ---------------------------------------------------------------------------
// Domain types a controller needs to READ a result.
// ---------------------------------------------------------------------------
export type {
  ComputedInvoiceLine,
  Invoice,
  InvoiceStatus,
  InvoiceSettlement,
} from './domain/invoice.ts'
export { deriveSettlement } from './domain/invoice.ts'
export type { AllocationInput, Receipt, ReceiptMethod, ReceiptStatus } from './domain/receipt.ts'
export { ReceivablesError, type ReceivablesErrorCode } from './domain/errors.ts'

/*
 * Re-exported so apps/api never imports @finsoft/customers/published
 * directly — `apps-import-module-index-only` (dependency-cruiser) confines
 * apps/** to each module's OWN index.ts. PostInvoice/PostReceipt/
 * CreateInvoiceDraft/etc. can all surface a CustomerDirectoryError, so
 * mapping it is legitimately this module's api/ concern too.
 */
export {
  CustomerDirectoryError,
  type CustomerDirectoryErrorCode,
} from '@finsoft/customers/published'

// ---------------------------------------------------------------------------
// The api/ contract: framework-free zod schemas, response mappers, and the
// error-code -> HTTP-status table.
// ---------------------------------------------------------------------------
export {
  CalculateInvoiceSchema,
  CreateInvoiceSchema,
  CreateReceiptSchema,
  InvoiceVersionOnlySchema,
  ListInvoicesQuerySchema,
  ListReceiptsQuerySchema,
  PreviewReceiptSchema,
  ReasonSchema,
  ReceiptVersionOnlySchema,
  UpdateInvoiceSchema,
  UpdateReceiptSchema,
  type CalculateInvoiceDto,
  type CreateInvoiceDto,
  type CreateReceiptDto,
  type InvoiceVersionOnlyDto,
  type ListInvoicesQueryDto,
  type ListReceiptsQueryDto,
  type PreviewReceiptDto,
  type ReasonDto,
  type ReceiptVersionOnlyDto,
  type UpdateInvoiceDto,
  type UpdateReceiptDto,
} from './api/schemas.ts'
export {
  decodeInvoiceCursor,
  decodeReceiptCursor,
  toInvoiceCalculationDto,
  toInvoiceDto,
  toInvoiceListPageDto,
  toReceiptDto,
  toReceiptListPageDto,
  toReceiptPreviewDto,
} from './api/mappers.ts'
export { receivablesErrorSlug, statusForReceivablesErrorCode } from './api/errors.ts'
