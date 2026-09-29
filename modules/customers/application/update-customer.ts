import { recordAudit, withTenant, type JsonObject } from '@finsoft/database'
import {
  normalizeCustomerPatch,
  type Customer,
  type CustomerFields,
  type UpdateCustomerInput,
} from '../domain/customer.ts'
import { CustomerError } from '../domain/errors.ts'
import type { Actor } from './create-customer.ts'
import type { CustomersRepository } from './ports.ts'

/*
 * UpdateCustomer. C4, api-contract.md §4.1: every field optional except
 * version; code and status are not editable here (status has its own
 * routes, C5/C6). docs/design/M3/README.md §10 records this endpoint's
 * permission debt: it uses `customer.create` (the MVP catalogue has no
 * `customer.update`).
 */

export interface UpdateCustomerCommand {
  readonly id: string
  readonly patch: UpdateCustomerInput
  readonly expectedVersion: number
  readonly actor: Actor
}

function pick(fields: CustomerFields, keys: readonly (keyof CustomerFields)[]): JsonObject {
  const out: Record<string, string | null> = {}
  for (const key of keys) {
    const value = fields[key]
    out[key] = key === 'creditDays' ? String(value) : (value as string | null)
  }
  return out
}

export function createUpdateCustomer(repo: CustomersRepository) {
  return async function updateCustomer(command: UpdateCustomerCommand): Promise<Customer> {
    const patch = normalizeCustomerPatch(command.patch)

    return withTenant(async (tx) => {
      const existing = await repo.lockForUpdate(tx, command.id)
      if (!existing) {
        throw new CustomerError('CUSTOMER_NOT_FOUND', `customer ${command.id} was not found.`, {
          customerId: command.id,
        })
      }
      existing.assertVersion(command.expectedVersion)

      const changedKeys = Object.keys(patch) as (keyof CustomerFields)[]
      if (changedKeys.length === 0) {
        // Nothing to change — return the current row unchanged. No write,
        // no audit record: nothing happened.
        return existing
      }

      const before = pick(existing.fields, changedKeys)
      const updated = await repo.update(tx, command.id, patch, command.expectedVersion)

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'CUSTOMER_UPDATED', // ADR-0020 §4/migration 009: UPPER_SNAKE_CASE
        entityType: 'customer',
        entityId: command.id,
        beforeJson: before,
        afterJson: pick(updated.fields, changedKeys),
      })

      return updated
    })
  }
}
