import type {
  Invoice as InvoiceDto,
  InvoiceCalculation as InvoiceCalculationDto,
  InvoiceListPage as InvoiceListPageDto,
  Receipt as ReceiptDto,
  ReceiptListPage as ReceiptListPageDto,
  ReceiptPreview as ReceiptPreviewDto,
} from '@finsoft/shared-types'
import type { CustomerRef } from '@finsoft/customers/published'
import { deriveSettlement, type ComputedInvoiceLine, type Invoice } from '../domain/invoice.ts'
import type { Receipt } from '../domain/receipt.ts'
import type { InvoicePreview } from '../domain/invoice.ts'
import type {
  InvoiceAllocationView,
  InvoiceListItemRow,
  LiveAllocationRef,
  ReceiptAllocationRow,
  ReceiptProposalRow,
} from '../application/ports.ts'
import type { ReceiptPreviewResult } from '../application/preview-receipt.ts'

/*
 * Response mappers. docs/design/M3/api-contract.md §4.2, §4.3. Framework-free
 * — no NestJS type here, only plain objects shaped to packages/shared-types
 * (ADR-0028 statement 4).
 *
 * KNOWN GAP (reported, not silently shipped): `journalEntry` is populated
 * correctly on a POST/REVERSE response (the caller passes it through from
 * `postingEngine.post`/`reverseForSource`'s own result — post-invoice.ts,
 * reverse-invoice.ts, post-receipt.ts, reverse-receipt.ts). On a plain GET
 * (I3/R4) of an ALREADY-posted document, this module has no read capability
 * to resolve "the entry for this source" (modules.md §7: the pointer is
 * deliberately never stored on the document, and no K1-K7 capability
 * exposes a by-source entry read to a module) — `journalEntry` is `null`
 * there. See this lane's delivery report, OBSERVED.
 */

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function decodeInvoiceCursor(cursor: string | undefined): { invoiceDate: string; id: string } | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'invoiceDate' in parsed &&
      'id' in parsed &&
      typeof (parsed as { invoiceDate: unknown }).invoiceDate === 'string' &&
      typeof (parsed as { id: unknown }).id === 'string'
    ) {
      return parsed as { invoiceDate: string; id: string }
    }
    return null
  } catch {
    return null
  }
}

export function decodeReceiptCursor(cursor: string | undefined): { receiptDate: string; id: string } | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'receiptDate' in parsed &&
      'id' in parsed &&
      typeof (parsed as { receiptDate: unknown }).receiptDate === 'string' &&
      typeof (parsed as { id: unknown }).id === 'string'
    ) {
      return parsed as { receiptDate: string; id: string }
    }
    return null
  } catch {
    return null
  }
}

function customerSummary(customer: CustomerRef): { id: string; code: string; name: string } {
  return { id: customer.id, code: customer.code, name: customer.name }
}

export function toInvoiceDto(
  invoice: Invoice,
  customer: CustomerRef,
  lines: readonly ComputedInvoiceLine[],
  outstanding: string | null,
  allocations: readonly InvoiceAllocationView[],
  reversalBlockedBy: readonly LiveAllocationRef[],
  journalEntry: { readonly id: string; readonly number: string } | null,
): InvoiceDto {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    settlement:
      invoice.status === 'POSTED' && outstanding !== null
        ? deriveSettlement(invoice.netAmount, outstanding)
        : null,
    customer: customerSummary(customer),
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    narration: invoice.narration,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      kind: 'SERVICE' as const,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineNet: l.lineNet,
    })),
    netAmount: invoice.netAmount,
    outstanding,
    allocations: allocations.map((a) => ({
      receiptId: a.receiptId,
      receiptNumber: a.receiptNumber,
      receiptDate: a.receiptDate,
      amount: a.amount,
      status: a.status,
    })),
    journalEntry,
    reversal:
      invoice.status === 'REVERSED'
        ? {
            entryId: journalEntry?.id ?? '',
            entryNumber: journalEntry?.number ?? '',
            occurredAt: invoice.reversedAt?.slice(0, 10) ?? invoice.invoiceDate,
            reason: invoice.reversalReason ?? '',
            reversedAt: invoice.reversedAt ?? '',
            reversedBy: invoice.reversedBy ?? '',
          }
        : null,
    reversalBlockedBy: reversalBlockedBy.map((r) => ({ id: r.receiptId, number: r.receiptNumber })),
    posted: invoice.postedAt && invoice.postedBy ? { at: invoice.postedAt, by: invoice.postedBy } : null,
    version: invoice.version,
    createdAt: invoice.createdAt,
    createdBy: invoice.createdBy,
    updatedAt: invoice.updatedAt,
    updatedBy: invoice.updatedBy,
  }
}

export function toInvoiceListPageDto(
  items: readonly { readonly item: InvoiceListItemRow; readonly customer: CustomerRef }[],
  nextCursor: { invoiceDate: string; id: string } | null,
): InvoiceListPageDto {
  return {
    items: items.map(({ item, customer }) => ({
      id: item.invoice.id,
      number: item.invoice.number,
      status: item.invoice.status,
      settlement:
        item.invoice.status === 'POSTED' && item.outstanding !== null
          ? deriveSettlement(item.invoice.netAmount, item.outstanding)
          : null,
      customer: customerSummary(customer),
      invoiceDate: item.invoice.invoiceDate,
      dueDate: item.invoice.dueDate,
      netAmount: item.invoice.netAmount,
      outstanding: item.outstanding,
    })),
    nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
  }
}

export function toInvoiceCalculationDto(preview: InvoicePreview): InvoiceCalculationDto {
  return {
    lines: preview.lines.map((l) => ({
      lineNo: l.lineNo,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineNet: l.lineNet,
    })),
    netAmount: preview.netAmount,
    problems: preview.problems,
  }
}

export function toReceiptDto(
  receipt: Receipt,
  customer: CustomerRef,
  proposals: readonly ReceiptProposalRow[],
  proposalProblems: readonly { code: string; invoiceId: string | null; details: unknown }[],
  allocations: readonly ReceiptAllocationRow[],
  journalEntry: { readonly id: string; readonly number: string } | null,
): ReceiptDto {
  return {
    id: receipt.id,
    number: receipt.number,
    status: receipt.status,
    customer: customerSummary(customer),
    receiptDate: receipt.receiptDate,
    method: receipt.method,
    amount: receipt.amount,
    reference: receipt.reference,
    narration: receipt.narration,
    proposals: proposals.map((p) => ({
      invoiceId: p.invoiceId,
      invoiceNumber: p.invoiceNumber,
      amount: p.amount,
    })),
    proposalProblems,
    allocations: allocations.map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoiceNumber,
      invoiceDate: a.invoiceDate,
      amount: a.amount,
      status: a.status,
    })),
    journalEntry,
    reversal:
      receipt.status === 'REVERSED'
        ? {
            entryId: journalEntry?.id ?? '',
            entryNumber: journalEntry?.number ?? '',
            occurredAt: receipt.reversedAt?.slice(0, 10) ?? receipt.receiptDate,
            reason: receipt.reversalReason ?? '',
            reversedAt: receipt.reversedAt ?? '',
            reversedBy: receipt.reversedBy ?? '',
          }
        : null,
    posted: receipt.postedAt && receipt.postedBy ? { at: receipt.postedAt, by: receipt.postedBy } : null,
    version: receipt.version,
    createdAt: receipt.createdAt,
    createdBy: receipt.createdBy,
    updatedAt: receipt.updatedAt,
    updatedBy: receipt.updatedBy,
  }
}

export function toReceiptListPageDto(
  items: readonly { readonly receipt: Receipt; readonly customer: CustomerRef }[],
  nextCursor: { receiptDate: string; id: string } | null,
): ReceiptListPageDto {
  return {
    items: items.map(({ receipt, customer }) => ({
      id: receipt.id,
      number: receipt.number,
      status: receipt.status,
      customer: customerSummary(customer),
      receiptDate: receipt.receiptDate,
      method: receipt.method,
      amount: receipt.amount,
    })),
    nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
  }
}

export function toReceiptPreviewDto(result: ReceiptPreviewResult): ReceiptPreviewDto {
  return {
    openInvoices: result.openInvoices,
    allocations: result.allocations,
    suggested: result.suggested,
    allocatedTotal: result.allocatedTotal,
    unallocated: result.unallocated,
    problems: result.problems,
  }
}
