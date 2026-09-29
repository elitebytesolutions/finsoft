import { withTenant } from '@finsoft/database'
import type { Customer } from '../domain/customer.ts'
import type { CustomerListCursor, CustomerListFilter, CustomersRepository } from './ports.ts'

/*
 * ListCustomers. C1, api-contract.md §4.1: `q` (prefix of code, substring
 * of name/phone), `status`, cursor-paginated, ordered by code ascending.
 */

export interface ListCustomersQuery {
  readonly q: string | null
  readonly status: readonly ('ACTIVE' | 'INACTIVE')[] | null
  readonly limit: number
  readonly cursor: CustomerListCursor | null
}

export interface CustomerListItemResult {
  readonly customer: Customer
  readonly balance: string
  readonly balanceAsOf: string
}

export interface ListCustomersResult {
  readonly items: readonly CustomerListItemResult[]
  readonly nextCursor: CustomerListCursor | null
}

export function createListCustomers(repo: CustomersRepository) {
  return async function listCustomers(query: ListCustomersQuery): Promise<ListCustomersResult> {
    const filter: CustomerListFilter = { q: query.q, status: query.status }

    return withTenant(async (tx) => {
      const page = await repo.list(tx, filter, { limit: query.limit, after: query.cursor })

      // MVP volumes (page cap 200) — the balance query itself is a single
      // indexed range scan per customer (ADR-0026 Compliance 8's
      // journal_lines_tenant_party_account_idx), not a full-table scan.
      const items: CustomerListItemResult[] = []
      for (const customer of page.items) {
        const { balance, asOf } = await repo.currentBalance(tx, customer.id)
        items.push({ customer, balance, balanceAsOf: asOf })
      }

      return { items, nextCursor: page.next }
    })
  }
}
