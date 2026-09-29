import { recordAudit, withTenant } from '@finsoft/database'
import type { CustomerDirectory } from '@finsoft/customers/published'
import {
  assertAllocationAmountsShapeValid,
  normalizeAmountShape,
  normalizeNarration,
  normalizeReference,
  type AllocationInput,
  type ReceiptMethod,
} from '../domain/receipt.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import { loadReceiptReadModel, type GetReceiptResult } from './get-receipt.ts'
import type { InvoicesRepository, ReceiptsRepository } from './ports.ts'

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
  invoicesRepo: InvoicesRepository,
  customerDirectory: CustomerDirectory,
) {
  return async function updateReceiptDraft(
    command: UpdateReceiptDraftCommand,
  ): Promise<GetReceiptResult> {
    return withTenant(async (tx) => {
      // LOCK_REGISTRY 1a before 1b (Security seat, Council review of
      // efb7e3f, S-C): the customer is locked before the receipt row. An
      // unlocked read (step 0, mirroring PostReceipt) resolves WHICH
      // customer to lock when the command does not name one — `command.
      // customerId` is optional (undefined means "unchanged").
      const currentCustomerId = await repo.customerIdOf(tx, command.id)
      if (!currentCustomerId) {
        throw new ReceivablesError('RECEIPT_NOT_FOUND', `receipt ${command.id} was not found.`, {
          receiptId: command.id,
        })
      }
      const customerId = command.customerId ?? currentCustomerId
      await customerDirectory.requireForPayment(tx, customerId)

      const existing = await repo.lockForUpdate(tx, command.id)
      if (!existing) {
        throw new ReceivablesError('RECEIPT_NOT_FOUND', `receipt ${command.id} was not found.`, {
          receiptId: command.id,
        })
      }
      existing.assertVersion(command.expectedVersion)
      existing.assertDraft()
      if (existing.customerId !== currentCustomerId) {
        // The draft's customer changed between the step-0 read and this
        // lock (a concurrent edit) — reload and retry, same as PostInvoice/
        // PostReceipt's own TOCTOU guard.
        throw new ReceivablesError(
          'VERSION_CONFLICT',
          `receipt ${command.id}'s customer changed since it was read.`,
          { currentVersion: existing.version },
        )
      }

      const reference =
        command.reference !== undefined ? normalizeReference(command.reference) : existing.reference
      const narration =
        command.narration !== undefined ? normalizeNarration(command.narration) : existing.narration
      const allocations = command.allocations ?? null
      if (allocations !== null) assertAllocationAmountsShapeValid(allocations)

      // S-D (Security seat, Council review of efb7e3f): same as
      // CreateReceiptDraft — a foreign-tenant (or unknown) invoiceId in a
      // revised proposal set must be a typed INVOICE_NOT_FOUND (422), not a
      // raw 23503 from the composite FK when the proposal row is inserted.
      if (allocations !== null && allocations.length > 0) {
        const invoiceIds = [...new Set(allocations.map((a) => a.invoiceId))]
        const found = await invoicesRepo.existingIds(tx, invoiceIds)
        for (const invoiceId of invoiceIds) {
          if (!found.has(invoiceId)) {
            throw new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${invoiceId} was not found.`, {
              invoiceId,
            })
          }
        }
      }

      const amount =
        command.amount !== undefined ? normalizeAmountShape(command.amount) : existing.amount

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
          allocations:
            allocations?.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) ?? null,
        },
      })

      return loadReceiptReadModel(tx, updated, repo, invoicesRepo, customerDirectory)
    })
  }
}
