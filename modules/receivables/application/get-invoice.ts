import { withTenant } from '@finsoft/database'
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

export function createGetInvoice(repo: InvoicesRepository, customerDirectory: CustomerDirectory) {
  return async function getInvoice(id: string): Promise<GetInvoiceResult> {
    return withTenant(async (tx) => {
      const invoice = await repo.findById(tx, id)
      if (!invoice) {
        throw new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${id} was not found.`, {
          invoiceId: id,
        })
      }
      const refs = await customerDirectory.getRefs(tx, [invoice.customerId])
      const customer = refs.get(invoice.customerId) ?? {
        id: invoice.customerId,
        code: '',
        name: '',
        status: 'ACTIVE' as const,
      }
      const lines = await repo.currentLines(tx, id)
      const allocations = await repo.allocationsOf(tx, id)

      let outstanding: string | null = null
      let reversalBlockedBy: readonly LiveAllocationRef[] = []
      if (invoice.status === 'POSTED') {
        const map = await repo.outstandingOf(tx, [id])
        outstanding = map.get(id) ?? invoice.netAmount
        reversalBlockedBy = await repo.liveAllocationsTo(tx, id)
      } else if (invoice.status === 'REVERSED') {
        // api-contract.md §4.2: "0.0000" when REVERSED — reversal is only
        // ever permitted once no LIVE allocation remains (PO-Q1 Option A).
        outstanding = Money.serialize(Money.zero(), 4)
      }

      return { invoice, customer, lines, outstanding, allocations, reversalBlockedBy }
    })
  }
}
