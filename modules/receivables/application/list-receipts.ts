import { withTenant } from '@finsoft/database'
import type { CustomerDirectory, CustomerRef } from '@finsoft/customers/published'
import type { Receipt, ReceiptMethod, ReceiptStatus } from '../domain/receipt.ts'
import type { ReceiptListCursor, ReceiptsRepository } from './ports.ts'

export interface ListReceiptsQuery {
  readonly customerId: string | null
  readonly status: readonly ReceiptStatus[] | null
  readonly method: ReceiptMethod | null
  readonly from: string | null
  readonly to: string | null
  readonly q: string | null
  readonly limit: number
  readonly cursor: ReceiptListCursor | null
}

export interface ReceiptListItemWithCustomer {
  readonly receipt: Receipt
  readonly customer: CustomerRef
}

export interface ListReceiptsResult {
  readonly items: readonly ReceiptListItemWithCustomer[]
  readonly next: ReceiptListCursor | null
}

export function createListReceipts(repo: ReceiptsRepository, customerDirectory: CustomerDirectory) {
  return async function listReceipts(query: ListReceiptsQuery): Promise<ListReceiptsResult> {
    return withTenant(async (tx) => {
      const page = await repo.list(
        tx,
        {
          customerId: query.customerId,
          status: query.status,
          method: query.method,
          from: query.from,
          to: query.to,
          q: query.q,
        },
        { limit: query.limit, after: query.cursor },
      )
      const refs = await customerDirectory.getRefs(
        tx,
        [...new Set(page.items.map((r) => r.customerId))],
      )
      return {
        items: page.items.map((receipt) => ({
          receipt,
          customer: refs.get(receipt.customerId) ?? {
            id: receipt.customerId,
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
