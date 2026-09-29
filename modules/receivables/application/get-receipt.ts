import { withTenant, type TenantTx } from '@finsoft/database'
import type { CustomerDirectory, CustomerRef } from '@finsoft/customers/published'
import type { Receipt } from '../domain/receipt.ts'
import { previewAllocationProblems, type AllocatableInvoice } from '../domain/receipt.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type {
  ReceiptAllocationRow,
  ReceiptProposalRow,
  ReceiptsRepository,
  InvoicesRepository,
} from './ports.ts'

export interface GetReceiptResult {
  readonly receipt: Receipt
  readonly customer: CustomerRef
  readonly proposals: readonly ReceiptProposalRow[]
  readonly proposalProblems: readonly { code: string; invoiceId: string | null; details: unknown }[]
  readonly allocations: readonly ReceiptAllocationRow[]
}

/**
 * R1 (Architecture seat, Council review of efb7e3f) — the receipt-side twin
 * of `loadInvoiceReadModel` (get-invoice.ts): assembled from an ALREADY
 * LOCKED/LOADED `receipt` row inside the CALLER's own transaction. Every
 * mutating use case (CreateReceiptDraft, UpdateReceiptDraft,
 * CancelReceiptDraft, PostReceipt, ReverseReceipt) calls this at its own
 * return point instead of the controller opening a second `withTenant`
 * after the mutation committed.
 */
export async function loadReceiptReadModel(
  tx: TenantTx,
  receipt: Receipt,
  repo: ReceiptsRepository,
  invoicesRepo: InvoicesRepository,
  customerDirectory: CustomerDirectory,
): Promise<GetReceiptResult> {
  const refs = await customerDirectory.getRefs(tx, [receipt.customerId])
  const customer: CustomerRef = refs.get(receipt.customerId) ?? {
    id: receipt.customerId,
    code: '',
    name: '',
    status: 'ACTIVE' as const,
  }

  if (receipt.status !== 'DRAFT') {
    const allocations = await repo.allocationsOf(tx, receipt.id)
    return { receipt, customer, proposals: [], proposalProblems: [], allocations }
  }

  const proposals = await repo.currentProposals(tx, receipt.id)
  let proposalProblems: GetReceiptResult['proposalProblems'] = []
  if (proposals.length > 0) {
    const invoiceIds = proposals.map((p) => p.invoiceId)
    // Advisory only, computed at read, no lock (api-contract.md §4.3).
    const page = await invoicesRepo.list(
      tx,
      {
        customerId: receipt.customerId,
        status: null,
        openOnly: false,
        from: null,
        to: null,
        q: null,
      },
      { limit: 200, after: null },
    )
    const outstanding = await invoicesRepo.outstandingOf(tx, invoiceIds)
    const byId = new Map<string, AllocatableInvoice>()
    for (const item of page.items) {
      byId.set(item.invoice.id, {
        id: item.invoice.id,
        number: item.invoice.number ?? '',
        customerId: item.invoice.customerId,
        status: item.invoice.status,
        invoiceDate: item.invoice.invoiceDate,
        outstanding: outstanding.get(item.invoice.id) ?? item.invoice.netAmount,
      })
    }
    proposalProblems = previewAllocationProblems(
      receipt.customerId,
      receipt.receiptDate,
      proposals.map((p) => ({ invoiceId: p.invoiceId, amount: p.amount })),
      byId,
    ).map((p) => ({ code: p.code, invoiceId: p.invoiceId, details: p.details }))
  }

  return { receipt, customer, proposals, proposalProblems, allocations: [] }
}

export function createGetReceipt(
  repo: ReceiptsRepository,
  invoicesRepo: InvoicesRepository,
  customerDirectory: CustomerDirectory,
) {
  return async function getReceipt(id: string): Promise<GetReceiptResult> {
    return withTenant(async (tx) => {
      const receipt = await repo.findById(tx, id)
      if (!receipt) {
        throw new ReceivablesError('RECEIPT_NOT_FOUND', `receipt ${id} was not found.`, {
          receiptId: id,
        })
      }
      return loadReceiptReadModel(tx, receipt, repo, invoicesRepo, customerDirectory)
    })
  }
}
