import { recordAudit, withTenant } from '@finsoft/database'
import type { Invoice } from '../domain/invoice.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import type { InvoicesRepository } from './ports.ts'

/** CancelInvoiceDraft (I5). Terminal; never numbered (service-sale.md §2, ruling R-3). */
export interface CancelInvoiceDraftCommand {
  readonly id: string
  readonly expectedVersion: number
  readonly actor: Actor
}

export function createCancelInvoiceDraft(repo: InvoicesRepository) {
  return async function cancelInvoiceDraft(command: CancelInvoiceDraftCommand): Promise<Invoice> {
    return withTenant(async (tx) => {
      const existing = await repo.lockForUpdate(tx, command.id)
      if (!existing) {
        throw new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${command.id} was not found.`, {
          invoiceId: command.id,
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
        action: 'SALES_INVOICE_DRAFT_CANCELLED',
        entityType: 'sales_invoice',
        entityId: command.id,
        beforeJson: { status: 'DRAFT' },
        afterJson: { status: 'CANCELLED' },
      })

      return updated
    })
  }
}
