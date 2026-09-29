import { recordAudit, withTenant } from '@finsoft/database'
import { reversalEngine } from '@finsoft/accounting-kernel'
import { assertReasonValid, type Invoice } from '../domain/invoice.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import { computeCommandFingerprint } from './fingerprint.ts'
import type { InvoicesRepository } from './ports.ts'

/*
 * ReverseInvoice (I8). modules.md §4.3. PO-Q1 Option A: an invoice with any
 * LIVE allocation cannot be reversed until its receipts are reversed first.
 *
 * REPLAY / ALREADY_REVERSED for a wrong-or-repeated key are answered by the
 * KERNEL's own `reverseForSource` (reversal.ts already translates a
 * SOURCE_ALREADY_POSTED lookup on the 'reversal' source into ALREADY_REVERSED
 * — see that file). This module pre-empts only what the kernel cannot know:
 * a DRAFT/CANCELLED invoice has no entry to reverse at all.
 */

export interface ReverseInvoiceCommand {
  readonly id: string
  readonly reason: string
  readonly idempotencyKey: string
  readonly actor: Actor
}

export interface ReverseInvoiceResult {
  readonly invoice: Invoice
  readonly journalEntryId: string
  readonly journalEntryNumber: string
  readonly replayed: boolean
}

export function createReverseInvoice(repo: InvoicesRepository) {
  return async function reverseInvoice(command: ReverseInvoiceCommand): Promise<ReverseInvoiceResult> {
    return withTenant(async (tx) => {
      const invoice = await repo.lockForUpdate(tx, command.id)
      if (!invoice) {
        throw new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${command.id} was not found.`, {
          invoiceId: command.id,
        })
      }
      if (invoice.status === 'DRAFT' || invoice.status === 'CANCELLED') {
        throw new ReceivablesError(
          'INVOICE_NOT_POSTED',
          `invoice ${command.id} is ${invoice.status}, not POSTED.`,
          { status: invoice.status },
        )
      }

      const reason = assertReasonValid(command.reason)
      const fingerprint = computeCommandFingerprint({
        route: 'POST /api/invoices/:id/reverse',
        targetId: command.id,
        command: { reason },
      })

      // Safe without locking the allocation rows (service-sale.md §8): every
      // writer of a LIVE allocation to this invoice holds this row's lock
      // first (PostReceipt), so while THIS transaction holds it, none can
      // appear.
      const live = await repo.liveAllocationsTo(tx, invoice.id)
      if (live.length > 0) {
        throw new ReceivablesError(
          'INVOICE_HAS_LIVE_ALLOCATIONS',
          `invoice ${invoice.number} has live allocations from ${live.map((r) => r.receiptNumber).join(', ')}.`,
          { receipts: live.map((r) => ({ id: r.receiptId, number: r.receiptNumber })) },
        )
      }

      let reversedInvoice = invoice
      if (invoice.status === 'POSTED') {
        reversedInvoice = await repo.markReversed(
          tx,
          invoice.id,
          {
            reversedBy: command.actor.userId,
            reason,
            reverseIdempotencyKey: command.idempotencyKey,
            reverseFingerprint: fingerprint,
          },
          invoice.version,
        )
      }

      const rev = await reversalEngine.reverseForSource(
        {
          referenceType: 'sales_invoice',
          referenceId: invoice.id,
          reason,
          idempotencyKey: command.idempotencyKey,
          actor: { userId: command.actor.userId },
        },
        tx,
      )

      if (invoice.status === 'POSTED') {
        await recordAudit(tx, {
          actorUserId: command.actor.userId,
          action: 'SALES_INVOICE_REVERSED',
          entityType: 'sales_invoice',
          entityId: invoice.id,
          beforeJson: { status: 'POSTED' },
          afterJson: { status: 'REVERSED', reason, reversalEntryId: rev.journalEntryId },
        })
      }

      return {
        invoice: reversedInvoice,
        journalEntryId: rev.journalEntryId,
        journalEntryNumber: rev.entry.entryNumber,
        replayed: rev.outcome === 'REPLAYED',
      }
    })
  }
}
