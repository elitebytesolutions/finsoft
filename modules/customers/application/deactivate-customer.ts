import { recordAudit, withTenant } from '@finsoft/database'
import { Money } from '@finsoft/validation'
import type { Customer } from '../domain/customer.ts'
import { CustomerError } from '../domain/errors.ts'
import type { Actor } from './create-customer.ts'
import type { CustomersRepository } from './ports.ts'

/*
 * DeactivateCustomer. C5, api-contract.md §3 CUSTOMER_HAS_BALANCE. Deactivating
 * an already-INACTIVE customer (same version) is a no-op success —
 * modules.md §7's status column is a plain toggle, not a posting document's
 * one-way status; the contract defines no error code for that case
 * (delivery brief: do not invent one).
 */

export interface DeactivateCustomerCommand {
  readonly id: string
  readonly expectedVersion: number
  readonly actor: Actor
}

export function createDeactivateCustomer(repo: CustomersRepository) {
  return async function deactivateCustomer(command: DeactivateCustomerCommand): Promise<Customer> {
    return withTenant(async (tx) => {
      const existing = await repo.lockForUpdate(tx, command.id)
      if (!existing) {
        throw new CustomerError('CUSTOMER_NOT_FOUND', `customer ${command.id} was not found.`, {
          customerId: command.id,
        })
      }
      existing.assertVersion(command.expectedVersion)

      // Balance is read (and, in principle, could be non-zero) even for an
      // already-INACTIVE customer, but assertDeactivatable checks status
      // FIRST and short-circuits — so an inactive customer with a residual
      // balance (should never occur, but is not this call's job to correct)
      // never fails the read it doesn't need.
      const { balance } = await repo.currentBalance(tx, command.id)
      const { alreadyInactive } = existing.assertDeactivatable({
        isZero: Money.isZero(Money.from(balance)),
      })
      if (alreadyInactive) return existing

      const updated = await repo.update(
        tx,
        command.id,
        { status: 'INACTIVE' },
        command.expectedVersion,
      )

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'CUSTOMER_DEACTIVATED', // ADR-0020 §4/migration 009: UPPER_SNAKE_CASE
        entityType: 'customer',
        entityId: command.id,
        beforeJson: { status: existing.status },
        afterJson: { status: updated.status },
      })

      return updated
    })
  }
}
