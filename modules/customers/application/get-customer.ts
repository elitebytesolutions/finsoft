import { withTenant } from '@finsoft/database'
import type { Customer } from '../domain/customer.ts'
import { CustomerError } from '../domain/errors.ts'
import type { CustomersRepository } from './ports.ts'

/** C3. Balance is read fresh on every call (K5) — never cached (rule 11). */
export interface GetCustomerResult {
  readonly customer: Customer
  readonly balance: string
  readonly balanceAsOf: string
}

export function createGetCustomer(repo: CustomersRepository) {
  return async function getCustomer(id: string): Promise<GetCustomerResult> {
    return withTenant(async (tx) => {
      const customer = await repo.findById(tx, id)
      if (!customer) {
        throw new CustomerError('CUSTOMER_NOT_FOUND', `customer ${id} was not found.`, {
          customerId: id,
        })
      }
      const { balance, asOf } = await repo.currentBalance(tx, id)
      return { customer, balance, balanceAsOf: asOf }
    })
  }
}
