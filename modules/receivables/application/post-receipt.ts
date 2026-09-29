import { recordAudit, withTenant } from '@finsoft/database'
import { documentNumbers, postingEngine, PostingError } from '@finsoft/accounting-kernel'
import type { CustomerDirectory } from '@finsoft/customers/published'
import {
  assertAllocatable,
  assertComplete,
  buildCustomerPaymentPayload,
  type AllocatableInvoice,
  type Receipt,
} from '../domain/receipt.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import { computeCommandFingerprint } from './fingerprint.ts'
import type { InvoicesRepository, ReceiptsRepository } from './ports.ts'

/*
 * PostReceipt (R6). modules.md §4.2. Two lines of defence, same pattern as
 * PostInvoice — see that file's header.
 */

export interface PostReceiptCommand {
  readonly id: string
  readonly expectedVersion: number
  readonly idempotencyKey: string
  readonly actor: Actor
}

export interface PostReceiptResult {
  readonly receipt: Receipt
  readonly journalEntryId: string
  readonly journalEntryNumber: string
  readonly replayed: boolean
}

function toAllocatableMap(invoices: ReadonlyMap<string, { id: string; number: string | null; customerId: string; status: string; invoiceDate: string }>, outstanding: ReadonlyMap<string, string>): Map<string, AllocatableInvoice> {
  const map = new Map<string, AllocatableInvoice>()
  for (const [id, invoice] of invoices) {
    map.set(id, {
      id: invoice.id,
      number: invoice.number ?? '',
      customerId: invoice.customerId,
      status: invoice.status,
      invoiceDate: invoice.invoiceDate,
      outstanding: outstanding.get(id) ?? '0.0000',
    })
  }
  return map
}

export function createPostReceipt(
  receiptsRepo: ReceiptsRepository,
  invoicesRepo: InvoicesRepository,
  customerDirectory: CustomerDirectory,
) {
  return async function postReceipt(command: PostReceiptCommand): Promise<PostReceiptResult> {
    const fingerprint = computeCommandFingerprint({
      route: 'POST /api/receipts/:id/post',
      targetId: command.id,
      command: { version: command.expectedVersion },
    })

    return withTenant(async (tx) => {
      const customerId = await receiptsRepo.customerIdOf(tx, command.id)
      if (!customerId) {
        throw new ReceivablesError('RECEIPT_NOT_FOUND', `receipt ${command.id} was not found.`, {
          receiptId: command.id,
        })
      }
      // R-2: status-agnostic — an inactive customer can still be paid.
      await customerDirectory.requireForPayment(tx, customerId)

      const receipt = await receiptsRepo.lockForUpdate(tx, command.id)
      if (!receipt) {
        throw new ReceivablesError('RECEIPT_NOT_FOUND', `receipt ${command.id} was not found.`, {
          receiptId: command.id,
        })
      }

      if (receipt.status === 'CANCELLED') {
        throw new ReceivablesError(
          'RECEIPT_NOT_DRAFT',
          `receipt ${command.id} is CANCELLED, not DRAFT.`,
          { status: 'CANCELLED' },
        )
      }

      if (receipt.status === 'POSTED' || receipt.status === 'REVERSED') {
        if (receipt.postIdempotencyKey !== command.idempotencyKey) {
          throw new ReceivablesError(
            'SOURCE_ALREADY_POSTED',
            `receipt ${receipt.number} is already posted.`,
            { documentNumber: receipt.number },
          )
        }
        if (receipt.postFingerprint !== fingerprint) {
          throw new ReceivablesError(
            'IDEMPOTENCY_KEY_REUSED',
            `idempotencyKey "${command.idempotencyKey}" was already used for a different request.`,
          )
        }
        const live = await receiptsRepo.allocationsOf(tx, receipt.id)
        const complete = assertComplete({
          method: receipt.method,
          amount: receipt.amount,
          allocations: live
            .filter((a) => a.status === 'LIVE')
            .map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
        })
        const entry = await postingEngine.post(
          {
            event: 'CUSTOMER_PAYMENT_RECEIVED',
            referenceType: 'customer_receipt',
            referenceId: receipt.id,
            referenceNumber: receipt.number as string,
            occurredAt: receipt.receiptDate,
            idempotencyKey: command.idempotencyKey,
            payload: buildCustomerPaymentPayload(receipt.customerId, complete),
          },
          tx,
        )
        return {
          receipt,
          journalEntryId: entry.journalEntryId,
          journalEntryNumber: entry.entry.entryNumber,
          replayed: true,
        }
      }

      // OLD.status === 'DRAFT' from here.
      receipt.assertVersion(command.expectedVersion)
      if (receipt.customerId !== customerId) {
        throw new ReceivablesError(
          'VERSION_CONFLICT',
          `receipt ${command.id}'s customer changed since it was read.`,
          { currentVersion: receipt.version },
        )
      }

      const proposals = await receiptsRepo.currentProposals(tx, receipt.id)
      const complete = assertComplete({
        method: receipt.method,
        amount: receipt.amount,
        allocations: proposals.map((p) => ({ invoiceId: p.invoiceId, amount: p.amount })),
      })

      const invoiceIds = [...new Set(complete.allocations.map((a) => a.invoiceId))]
      const invoices = await invoicesRepo.lockManyForAllocation(tx, invoiceIds)
      const outstanding = await invoicesRepo.outstandingOf(tx, invoiceIds)
      const allocatable = toAllocatableMap(invoices, outstanding)
      assertAllocatable(receipt.customerId, receipt.receiptDate, complete.allocations, allocatable)

      const number = await documentNumbers.next(tx, {
        series: 'RCT',
        occurredAt: receipt.receiptDate,
      })

      const posted = await receiptsRepo.markPosted(
        tx,
        receipt.id,
        {
          number,
          postedBy: command.actor.userId,
          postIdempotencyKey: command.idempotencyKey,
          postFingerprint: fingerprint,
        },
        command.expectedVersion,
      )
      await receiptsRepo.insertAllocations(tx, receipt.id, complete.allocations, command.actor.userId)

      const entry = await postingEngine.post(
        {
          event: 'CUSTOMER_PAYMENT_RECEIVED',
          referenceType: 'customer_receipt',
          referenceId: receipt.id,
          referenceNumber: number,
          occurredAt: receipt.receiptDate,
          idempotencyKey: command.idempotencyKey,
          payload: buildCustomerPaymentPayload(receipt.customerId, complete),
        },
        tx,
      )

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'CUSTOMER_RECEIPT_POSTED',
        entityType: 'customer_receipt',
        entityId: receipt.id,
        beforeJson: { status: 'DRAFT' },
        afterJson: {
          status: 'POSTED',
          number,
          customerId: receipt.customerId,
          method: complete.method,
          amount: complete.amount,
          allocations: complete.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
          journalEntryId: entry.journalEntryId,
        },
      })

      return {
        receipt: posted,
        journalEntryId: entry.journalEntryId,
        journalEntryNumber: entry.entry.entryNumber,
        replayed: entry.outcome === 'REPLAYED',
      }
    })
  }
}

export { PostingError }
