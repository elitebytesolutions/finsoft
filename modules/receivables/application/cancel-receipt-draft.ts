import { recordAudit, withTenant } from '@finsoft/database'
import type { CustomerDirectory } from '@finsoft/customers/published'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import { loadReceiptReadModel, type GetReceiptResult } from './get-receipt.ts'
import type { InvoicesRepository, ReceiptsRepository } from './ports.ts'

/** CancelReceiptDraft (R7). Terminal; never numbered (customer-receipt.md §1.1). */
export interface CancelReceiptDraftCommand {
  readonly id: string
  readonly expectedVersion: number
  readonly actor: Actor
}

export function createCancelReceiptDraft(
  repo: ReceiptsRepository,
  invoicesRepo: InvoicesRepository,
  customerDirectory: CustomerDirectory,
) {
  return async function cancelReceiptDraft(
    command: CancelReceiptDraftCommand,
  ): Promise<GetReceiptResult> {
    return withTenant(async (tx) => {
      const existing = await repo.lockForUpdate(tx, command.id)
      if (!existing) {
        throw new ReceivablesError('RECEIPT_NOT_FOUND', `receipt ${command.id} was not found.`, {
          receiptId: command.id,
        })
      }
      existing.assertVersion(command.expectedVersion)
      existing.assertDraft()

      const updated = await repo.markCancelled(
        tx,
        command.id,
        command.actor.userId,
        command.expectedVersion,
      )

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'CUSTOMER_RECEIPT_DRAFT_CANCELLED',
        entityType: 'customer_receipt',
        entityId: command.id,
        beforeJson: { status: 'DRAFT' },
        afterJson: { status: 'CANCELLED' },
      })

      return loadReceiptReadModel(tx, updated, repo, invoicesRepo, customerDirectory)
    })
  }
}
