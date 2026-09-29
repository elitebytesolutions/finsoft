import type { TenantTx } from '@finsoft/database'
import type { ComputedInvoiceLine, Invoice, InvoiceStatus } from '../domain/invoice.ts'
import type { AllocatableInvoice, AllocationInput, Receipt, ReceiptStatus } from '../domain/receipt.ts'

/*
 * Repository interfaces. ADR-0028 statement 5: a repository method takes a
 * `TenantTx`, so this file (which imports `@finsoft/database` for that one
 * type) lives in `application/`, not `domain/`. `infrastructure/` implements
 * these with a TYPE-ONLY import back (ADR-0028's one sanctioned
 * infrastructure -> application edge).
 *
 * One module owns all five tables (modules.md §2), so `InvoicesRepository`
 * and `ReceiptsRepository` between them cover `sales_invoices`,
 * `sales_invoice_lines`, `customer_receipts`,
 * `customer_receipt_draft_allocations` and `customer_receipt_allocations` —
 * never another module's table (modules.md §11).
 */

export interface NewInvoiceDraft {
  readonly customerId: string
  readonly invoiceDate: string
  readonly dueDate: string | null
  readonly narration: string | null
  readonly lines: readonly ComputedInvoiceLine[]
  readonly netAmount: string
  readonly createIdempotencyKey: string
  readonly createFingerprint: string
}

export interface InvoiceDraftPatch {
  readonly customerId: string
  readonly invoiceDate: string
  readonly dueDate: string | null
  readonly narration: string | null
  readonly lines: readonly ComputedInvoiceLine[]
  readonly netAmount: string
}

export interface InvoiceListFilter {
  readonly customerId: string | null
  readonly status: readonly InvoiceStatus[] | null
  readonly openOnly: boolean
  readonly from: string | null
  readonly to: string | null
  readonly q: string | null
}

export interface InvoiceListCursor {
  readonly invoiceDate: string
  readonly id: string
}

export interface InvoiceListItemRow {
  readonly invoice: Invoice
  readonly outstanding: string | null
}

export interface InvoiceListPage {
  readonly items: readonly InvoiceListItemRow[]
  readonly next: InvoiceListCursor | null
}

export interface LiveAllocationRef {
  readonly receiptId: string
  readonly receiptNumber: string
}

export interface InvoiceAllocationView {
  readonly receiptId: string
  readonly receiptNumber: string
  readonly receiptDate: string
  readonly amount: string
  readonly status: 'LIVE' | 'VOIDED'
}

export interface InvoicesRepository {
  /** Today, in the TENANT's own timezone (K6) — a draft date DEFAULT only, never an authoritative check (the kernel's own clock is that). */
  today(tx: TenantTx): Promise<string>

  findByCreateIdempotencyKey(
    tx: TenantTx,
    key: string,
  ): Promise<{ readonly invoice: Invoice; readonly fingerprint: string } | null>

  /** Header + first lines revision, in one call (modules.md §7's revision protocol). */
  createDraft(tx: TenantTx, draft: NewInvoiceDraft): Promise<Invoice>

  findById(tx: TenantTx, id: string): Promise<Invoice | null>
  /** Plain read, no lock — PostInvoice/ReverseInvoice step 0. */
  customerIdOf(tx: TenantTx, id: string): Promise<string | null>

  /** FOR UPDATE (LOCK_REGISTRY 1c). */
  lockForUpdate(tx: TenantTx, id: string): Promise<Invoice | null>

  /**
   * FOR UPDATE, ascending id, ONE STATEMENT PER ROW (LOCK_REGISTRY 1c —
   * "the migration-008 lesson: ORDER BY … FOR UPDATE does not fix
   * acquisition order"). Shared by PostReceipt and ReverseReceipt.
   */
  lockManyForAllocation(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, Invoice>>

  /** The current revision's lines (post-time re-validation, and for display). */
  currentLines(tx: TenantTx, id: string): Promise<readonly ComputedInvoiceLine[]>

  /** Replaces the header + inserts a new lines revision (UpdateInvoiceDraft). */
  updateDraft(
    tx: TenantTx,
    id: string,
    patch: InvoiceDraftPatch,
    expectedVersion: number,
  ): Promise<Invoice>

  markCancelled(tx: TenantTx, id: string, cancelledBy: string, expectedVersion: number): Promise<Invoice>

  markPosted(
    tx: TenantTx,
    id: string,
    fields: {
      readonly number: string
      readonly postedBy: string
      readonly postIdempotencyKey: string
      readonly postFingerprint: string
    },
    expectedVersion: number,
  ): Promise<Invoice>

  markReversed(
    tx: TenantTx,
    id: string,
    fields: {
      readonly reversedBy: string
      readonly reason: string
      readonly reverseIdempotencyKey: string
      readonly reverseFingerprint: string
    },
    expectedVersion: number,
  ): Promise<Invoice>

  /** Under the invoice's own lock — reversal.md/service-sale.md §8, PO-Q1 Option A. */
  liveAllocationsTo(tx: TenantTx, id: string): Promise<readonly LiveAllocationRef[]>

  /** invoice.net_amount − Σ amount of LIVE allocations, computed in SQL (modules.md §6). */
  outstandingOf(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, string>>

  /** Every allocation (LIVE and VOIDED) ever made to this invoice, for the detail view. */
  allocationsOf(tx: TenantTx, id: string): Promise<readonly InvoiceAllocationView[]>

  list(
    tx: TenantTx,
    filter: InvoiceListFilter,
    page: { readonly limit: number; readonly after: InvoiceListCursor | null },
  ): Promise<InvoiceListPage>
}

export interface NewReceiptDraft {
  readonly customerId: string
  readonly receiptDate: string
  readonly method: 'CASH' | 'BANK' | null
  readonly amount: string | null
  readonly reference: string | null
  readonly narration: string | null
  readonly allocations: readonly AllocationInput[]
  readonly createIdempotencyKey: string
  readonly createFingerprint: string
}

export interface ReceiptDraftPatch {
  readonly customerId: string
  readonly receiptDate: string
  readonly method: 'CASH' | 'BANK' | null
  readonly amount: string | null
  readonly reference: string | null
  readonly narration: string | null
  /** null when the patch did not touch allocations — no new proposal revision is written. */
  readonly allocations: readonly AllocationInput[] | null
}

export interface ReceiptListFilter {
  readonly customerId: string | null
  readonly status: readonly ReceiptStatus[] | null
  readonly method: 'CASH' | 'BANK' | null
  readonly from: string | null
  readonly to: string | null
  readonly q: string | null
}

export interface ReceiptListCursor {
  readonly receiptDate: string
  readonly id: string
}

export interface ReceiptListPage {
  readonly items: readonly Receipt[]
  readonly next: ReceiptListCursor | null
}

export interface ReceiptProposalRow {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly amount: string
}

export interface ReceiptAllocationRow {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly invoiceDate: string
  readonly amount: string
  readonly status: 'LIVE' | 'VOIDED'
}

export interface ReceiptsRepository {
  today(tx: TenantTx): Promise<string>

  findByCreateIdempotencyKey(
    tx: TenantTx,
    key: string,
  ): Promise<{ readonly receipt: Receipt; readonly fingerprint: string } | null>

  createDraft(tx: TenantTx, draft: NewReceiptDraft): Promise<Receipt>

  findById(tx: TenantTx, id: string): Promise<Receipt | null>
  customerIdOf(tx: TenantTx, id: string): Promise<string | null>

  /** FOR UPDATE (LOCK_REGISTRY 1b). */
  lockForUpdate(tx: TenantTx, id: string): Promise<Receipt | null>

  /** The current revision's proposals (DRAFT display; never counted toward outstanding). */
  currentProposals(tx: TenantTx, id: string): Promise<readonly ReceiptProposalRow[]>

  updateDraft(
    tx: TenantTx,
    id: string,
    patch: ReceiptDraftPatch,
    expectedVersion: number,
  ): Promise<Receipt>

  markCancelled(tx: TenantTx, id: string, cancelledBy: string, expectedVersion: number): Promise<Receipt>

  markPosted(
    tx: TenantTx,
    id: string,
    fields: {
      readonly number: string
      readonly postedBy: string
      readonly postIdempotencyKey: string
      readonly postFingerprint: string
    },
    expectedVersion: number,
  ): Promise<Receipt>

  /** Inserts the LIVE allocation rows — only ever called from PostReceipt, in the same statement batch as markPosted's transaction. */
  insertAllocations(
    tx: TenantTx,
    receiptId: string,
    allocations: readonly AllocationInput[],
    createdBy: string,
  ): Promise<void>

  markReversed(
    tx: TenantTx,
    id: string,
    fields: {
      readonly reversedBy: string
      readonly reason: string
      readonly reverseIdempotencyKey: string
      readonly reverseFingerprint: string
    },
    expectedVersion: number,
  ): Promise<Receipt>

  /** LIVE -> VOIDED for every allocation of this receipt (ReverseReceipt only). */
  voidAllocations(tx: TenantTx, receiptId: string, voidedBy: string): Promise<void>

  allocationsOf(tx: TenantTx, receiptId: string): Promise<readonly ReceiptAllocationRow[]>

  /** The invoice ids this receipt has LIVE or VOIDED allocations to (ReverseReceipt step 2). */
  allocatedInvoiceIds(tx: TenantTx, receiptId: string): Promise<readonly string[]>

  list(
    tx: TenantTx,
    filter: ReceiptListFilter,
    page: { readonly limit: number; readonly after: ReceiptListCursor | null },
  ): Promise<ReceiptListPage>
}

export type { AllocatableInvoice }
