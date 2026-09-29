import { withTenant, type TenantTx } from '@finsoft/database'
import { Money } from '@finsoft/validation'
import type { CustomerDirectory, CustomerRef } from '@finsoft/customers/published'
import type { ComputedInvoiceLine, Invoice } from '../domain/invoice.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { InvoiceAllocationView, InvoicesRepository, LiveAllocationRef } from './ports.ts'

export interface GetInvoiceResult {
  readonly invoice: Invoice
  readonly customer: CustomerRef
  readonly lines: readonly ComputedInvoiceLine[]
  readonly outstanding: string | null
  readonly allocations: readonly InvoiceAllocationView[]
  readonly reversalBlockedBy: readonly LiveAllocationRef[]
}

/**
 * R1 (Architecture seat, Council review of efb7e3f): the read model a
 * controller needs to build its response DTO, assembled from an ALREADY
 * LOCKED/LOADED `invoice` row inside the CALLER's own transaction — never a
 * new `withTenant`. Every mutating use case (CreateInvoiceDraft,
 * UpdateInvoiceDraft, CancelInvoiceDraft, PostInvoice, ReverseInvoice) calls
 * this at its own return point so "one request, one transaction" (ADR-0028
 * statement 4, "thin controller") holds all the way through — a controller
 * that separately re-fetched the invoice after mutating it was a second,
 * unguarded transaction observing a state no lock protects it against.
 * `getInvoice` (below) is the only caller that does not already hold the row;
 * it opens the one `withTenant` this function needs.
 */
export async function loadInvoiceReadModel(
  tx: TenantTx,
  invoice: Invoice,
  repo: InvoicesRepository,
  customerDirectory: CustomerDirectory,
): Promise<GetInvoiceResult> {
  const refs = await customerDirectory.getRefs(tx, [invoice.customerId])
  const customer = refs.get(invoice.customerId) ?? {
    id: invoice.customerId,
    code: '',
    name: '',
    status: 'ACTIVE' as const,
  }
  const lines = await repo.currentLines(tx, invoice.id)
  const allocations = await repo.allocationsOf(tx, invoice.id)

  let outstanding: string | null = null
  let reversalBlockedBy: readonly LiveAllocationRef[] = []
  if (invoice.status === 'POSTED') {
    const map = await repo.outstandingOf(tx, [invoice.id])
    outstanding = map.get(invoice.id) ?? invoice.netAmount
    reversalBlockedBy = await repo.liveAllocationsTo(tx, invoice.id)
  } else if (invoice.status === 'REVERSED') {
    // api-contract.md §4.2: "0.0000" when REVERSED — reversal is only
    // ever permitted once no LIVE allocation remains (PO-Q1 Option A).
    outstanding = Money.serialize(Money.zero(), 4)
  }

  return { invoice, customer, lines, outstanding, allocations, reversalBlockedBy }
}

export function createGetInvoice(repo: InvoicesRepository, customerDirectory: CustomerDirectory) {
  return async function getInvoice(id: string): Promise<GetInvoiceResult> {
    return withTenant(async (tx) => {
      const invoice = await repo.findById(tx, id)
      if (!invoice) {
        throw new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${id} was not found.`, {
          invoiceId: id,
        })
      }
      return loadInvoiceReadModel(tx, invoice, repo, customerDirectory)
    })
  }
}
