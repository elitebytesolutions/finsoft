import { recordAudit, withTenant } from '@finsoft/database'
import { reversalEngine } from '@finsoft/accounting-kernel'
import { assertReasonValid, type Receipt } from '../domain/receipt.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import { computeCommandFingerprint } from './fingerprint.ts'
import type { InvoicesRepository, ReceiptsRepository } from './ports.ts'

/*
 * ReverseReceipt (R8). modules.md §4.4. Voiding only ever INCREASES
 * outstanding, so locking the invoices here is not needed for correctness —
 * it keeps LOCK_REGISTRY's "allocations change only under their invoices'
 * locks" a single rule with no exception (§4.4's own note).
 */

export interface ReverseReceiptCommand {
  readonly id: string
  readonly reason: string
  readonly idempotencyKey: string
  readonly actor: Actor
}

export interface ReverseReceiptResult {
  readonly receipt: Receipt
  readonly journalEntryId: string
  readonly journalEntryNumber: string
  readonly replayed: boolean
}

export function createReverseReceipt(
  receiptsRepo: ReceiptsRepository,
  invoicesRepo: InvoicesRepository,
) {
  return async function reverseReceipt(command: ReverseReceiptCommand): Promise<ReverseReceiptResult> {
    return withTenant(async (tx) => {
      const receipt = await receiptsRepo.lockForUpdate(tx, command.id)
      if (!receipt) {
        throw new ReceivablesError('RECEIPT_NOT_FOUND', `receipt ${command.id} was not found.`, {
          receiptId: command.id,
        })
      }
      if (receipt.status === 'DRAFT' || receipt.status === 'CANCELLED') {
        throw new ReceivablesError(
          'RECEIPT_NOT_POSTED',
          `receipt ${command.id} is ${receipt.status}, not POSTED.`,
          { status: receipt.status },
        )
      }

      const reason = assertReasonValid(command.reason)
      const fingerprint = computeCommandFingerprint({
        route: 'POST /api/receipts/:id/reverse',
        targetId: command.id,
        command: { reason },
      })

      const invoiceIds = await receiptsRepo.allocatedInvoiceIds(tx, receipt.id)
      if (invoiceIds.length > 0) {
        await invoicesRepo.lockManyForAllocation(tx, invoiceIds)
      }

      let reversedReceipt = receipt
      if (receipt.status === 'POSTED') {
        await receiptsRepo.voidAllocations(tx, receipt.id, command.actor.userId)
        reversedReceipt = await receiptsRepo.markReversed(
          tx,
          receipt.id,
          {
            reversedBy: command.actor.userId,
            reason,
            reverseIdempotencyKey: command.idempotencyKey,
            reverseFingerprint: fingerprint,
          },
          receipt.version,
        )
      }

      const rev = await reversalEngine.reverseForSource(
        {
          referenceType: 'customer_receipt',
          referenceId: receipt.id,
          reason,
          idempotencyKey: command.idempotencyKey,
          actor: { userId: command.actor.userId },
        },
        tx,
      )

      if (receipt.status === 'POSTED') {
        await recordAudit(tx, {
          actorUserId: command.actor.userId,
          action: 'CUSTOMER_RECEIPT_REVERSED',
          entityType: 'customer_receipt',
          entityId: receipt.id,
          beforeJson: { status: 'POSTED' },
          afterJson: {
            status: 'REVERSED',
            reason,
            reversalEntryId: rev.journalEntryId,
            voidedAllocations: [...invoiceIds],
          },
        })
      }

      return {
        receipt: reversedReceipt,
        journalEntryId: rev.journalEntryId,
        journalEntryNumber: rev.entry.entryNumber,
        replayed: rev.outcome === 'REPLAYED',
      }
    })
  }
}
