import type { TenantTx } from '@finsoft/database'
import type { CustomersRepository } from './ports.ts'
import {
  CustomerDirectoryError,
  type CustomerDirectory,
  type CustomerForPosting,
  type CustomerRef,
} from './published.ts'

/*
 * The implementation of the published CustomerDirectory interface. Built by
 * index.ts (the composition root) with the module's own repository and
 * handed to M3-P's use-case factories. modules.md §3.
 */

function toRef(customer: {
  id: string
  code: string
  fields: { name: string }
  status: 'ACTIVE' | 'INACTIVE'
}): CustomerRef {
  return {
    id: customer.id,
    code: customer.code,
    name: customer.fields.name,
    status: customer.status,
  }
}

export function createCustomerDirectory(repo: CustomersRepository): CustomerDirectory {
  return {
    async requireActiveForPosting(tx: TenantTx, customerId: string): Promise<CustomerForPosting> {
      const customer = await repo.lockForShare(tx, customerId)
      if (!customer) {
        throw new CustomerDirectoryError(
          'CUSTOMER_NOT_FOUND',
          `customer ${customerId} was not found.`,
        )
      }
      if (customer.status !== 'ACTIVE') {
        throw new CustomerDirectoryError(
          'CUSTOMER_INACTIVE',
          `customer ${customerId} is not active.`,
        )
      }
      return { ...toRef(customer), creditDays: customer.fields.creditDays }
    },

    async getRefs(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, CustomerRef>> {
      const found = await repo.findByIds(tx, ids)
      const result = new Map<string, CustomerRef>()
      for (const [id, customer] of found) result.set(id, toRef(customer))
      return result
    },
  }
}
