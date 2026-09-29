import { withTenant } from '@finsoft/database'
import type { CustomerDirectory, CustomerRef } from '@finsoft/customers/published'
import { ReceivablesError } from '../domain/errors.ts'
import type { InvoiceStatus } from '../domain/invoice.ts'
import type { InvoiceListCursor, InvoiceListItemRow, InvoicesRepository } from './ports.ts'

export interface ListInvoicesQuery {
  readonly customerId: string | null
  readonly status: readonly InvoiceStatus[] | null
  readonly open: boolean
  readonly from: string | null
  readonly to: string | null
  readonly q: string | null
  readonly limit: number
  readonly cursor: InvoiceListCursor | null
}

export interface InvoiceListItemWithCustomer {
  readonly item: InvoiceListItemRow
  readonly customer: CustomerRef
}

export interface ListInvoicesResult {
  readonly items: readonly InvoiceListItemWithCustomer[]
  readonly next: InvoiceListCursor | null
}

export function createListInvoices(repo: InvoicesRepository, customerDirectory: CustomerDirectory) {
  return async function listInvoices(query: ListInvoicesQuery): Promise<ListInvoicesResult> {
    // api-contract.md §4.2: open=true requires customerId — it is the
    // allocation picker's source, never a tenant-wide scan.
    if (query.open && !query.customerId) {
      throw new ReceivablesError('VALIDATION_FAILED', 'open=true requires customerId.', {
        path: 'customerId',
      })
    }
    return withTenant(async (tx) => {
      const page = await repo.list(
        tx,
        {
          customerId: query.customerId,
          status: query.status,
          openOnly: query.open,
          from: query.from,
          to: query.to,
          q: query.q,
        },
        { limit: query.limit, after: query.cursor },
      )
      const refs = await customerDirectory.getRefs(tx, [
        ...new Set(page.items.map((i) => i.invoice.customerId)),
      ])
      return {
        items: page.items.map((item) => ({
          item,
          customer: refs.get(item.invoice.customerId) ?? {
            id: item.invoice.customerId,
            code: '',
            name: '',
            status: 'ACTIVE' as const,
          },
        })),
        next: page.next,
      }
    })
  }
}
