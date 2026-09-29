import { recordAudit, withTenant } from '@finsoft/database'
import type { Customer } from '../domain/customer.ts'
import { CustomerError } from '../domain/errors.ts'
import type { Actor } from './create-customer.ts'
import type { CustomersRepository } from './ports.ts'

/*
 * ReactivateCustomer. C6. Reactivating an already-ACTIVE customer (same
 * version) is a no-op success — see deactivate-customer.ts's header.
 */

export interface ReactivateCustomerCommand {
  readonly id: string
  readonly expectedVersion: number
  readonly actor: Actor
}

export function createReactivateCustomer(repo: CustomersRepository) {
  return async function reactivateCustomer(command: ReactivateCustomerCommand): Promise<Customer> {
    return withTenant(async (tx) => {
      const existing = await repo.lockForUpdate(tx, command.id)
      if (!existing) {
        throw new CustomerError('CUSTOMER_NOT_FOUND', `customer ${command.id} was not found.`, {
          customerId: command.id,
        })
      }
      existing.assertVersion(command.expectedVersion)

      const { alreadyActive } = existing.assertReactivatable()
      if (alreadyActive) return existing

      const updated = await repo.update(
        tx,
        command.id,
        { status: 'ACTIVE' },
        command.expectedVersion,
      )

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'CUSTOMER_REACTIVATED', // ADR-0020 §4/migration 009: UPPER_SNAKE_CASE
        entityType: 'customer',
        entityId: command.id,
        beforeJson: { status: existing.status },
        afterJson: { status: updated.status },
      })

      return updated
    })
  }
}
