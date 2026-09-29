import { recordAudit, withTenant } from '@finsoft/database'
import type { CustomerDirectory } from '@finsoft/customers/published'
import {
  assertAllocationAmountsShapeValid,
  normalizeAmountShape,
  normalizeNarration,
  normalizeReference,
  type AllocationInput,
  type Receipt,
  type ReceiptMethod,
} from '../domain/receipt.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import type { ReceiptsRepository } from './ports.ts'

/** UpdateReceiptDraft (R5). Every field optional; `allocations`, if present, replaces all proposals. */
export interface UpdateReceiptDraftCommand {
  readonly id: string
  readonly customerId?: string
  readonly receiptDate?: string
  readonly method?: ReceiptMethod | null
  readonly amount?: string | null
  readonly reference?: string | null
  readonly narration?: string | null
  readonly allocations?: readonly AllocationInput[]
  readonly expectedVersion: number
  readonly actor: Actor
}

export function createUpdateReceiptDraft(
  repo: ReceiptsRepository,
  customerDirectory: CustomerDirectory,
) {
  return async function updateReceiptDraft(command: UpdateReceiptDraftCommand): Promise<Receipt> {
    return withTenant(async (tx) => {
      const existing = await repo.lockForUpdate(tx, command.id)
      if (!existing) {
        throw new ReceivablesError('RECEIPT_NOT_FOUND', `receipt ${command.id} was not found.`, {
          receiptId: command.id,
        })
      }
      existing.assertVersion(command.expectedVersion)
      existing.assertDraft()

      const customerId = command.customerId ?? existing.customerId
      await customerDirectory.requireForPayment(tx, customerId)

      const reference =
        command.reference !== undefined ? normalizeReference(command.reference) : existing.reference
      const narration =
        command.narration !== undefined ? normalizeNarration(command.narration) : existing.narration
      const allocations = command.allocations ?? null
      if (allocations !== null) assertAllocationAmountsShapeValid(allocations)
      const amount = command.amount !== undefined ? normalizeAmountShape(command.amount) : existing.amount

      const before = {
        customerId: existing.customerId,
        receiptDate: existing.receiptDate,
        method: existing.method,
        amount: existing.amount,
        reference: existing.reference,
        narration: existing.narration,
      }

      const updated = await repo.updateDraft(
        tx,
        command.id,
        {
          customerId,
          receiptDate: command.receiptDate ?? existing.receiptDate,
          method: command.method !== undefined ? command.method : existing.method,
          amount,
          reference,
          narration,
          allocations,
        },
        command.expectedVersion,
      )

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'CUSTOMER_RECEIPT_DRAFT_UPDATED',
        entityType: 'customer_receipt',
        entityId: command.id,
        beforeJson: before,
        afterJson: {
          customerId: updated.customerId,
          receiptDate: updated.receiptDate,
          method: updated.method,
          amount: updated.amount,
          reference: updated.reference,
          narration: updated.narration,
          allocations: allocations?.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) ?? null,
        },
      })

      return updated
    })
  }
}
