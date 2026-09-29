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
import { computeCommandFingerprint } from './fingerprint.ts'
import type { ReceiptsRepository } from './ports.ts'

/*
 * CreateReceiptDraft (R3). customer-receipt.md §1.1 rule 4: "a draft may be
 * saved incomplete... because it has no effect." Only customerId and
 * receiptDate are required; method/amount/allocations may be empty.
 * `customerDirectory.requireForPayment` (status-agnostic, ruling R-2) —
 * NOT requireActiveForPosting: an inactive customer's receipts are exactly
 * what R-2 exists to allow.
 */

export interface CreateReceiptDraftCommand {
  readonly customerId: string
  readonly receiptDate: string | null
  readonly method: ReceiptMethod | null
  readonly amount: string | null
  readonly reference: string | null
  readonly narration: string | null
  readonly allocations: readonly AllocationInput[]
  readonly idempotencyKey: string
  readonly actor: Actor
}

export interface CreateReceiptDraftResult {
  readonly receipt: Receipt
  readonly replayed: boolean
}

export function createCreateReceiptDraft(
  repo: ReceiptsRepository,
  customerDirectory: CustomerDirectory,
) {
  return async function createReceiptDraft(
    command: CreateReceiptDraftCommand,
  ): Promise<CreateReceiptDraftResult> {
    assertAllocationAmountsShapeValid(command.allocations)
    const reference = normalizeReference(command.reference)
    const narration = normalizeNarration(command.narration)
    const amount = normalizeAmountShape(command.amount)
    const fingerprint = computeCommandFingerprint({
      route: 'POST /api/receipts',
      targetId: null,
      command: {
        customerId: command.customerId,
        receiptDate: command.receiptDate,
        method: command.method,
        amount,
        reference,
        narration,
        allocations: command.allocations,
      },
    })

    return withTenant(async (tx) => {
      const prior = await repo.findByCreateIdempotencyKey(tx, command.idempotencyKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new ReceivablesError(
            'IDEMPOTENCY_KEY_REUSED',
            `idempotencyKey "${command.idempotencyKey}" was already used for a different request.`,
          )
        }
        return { receipt: prior.receipt, replayed: true }
      }

      await customerDirectory.requireForPayment(tx, command.customerId)
      const receiptDate = command.receiptDate ?? (await repo.today(tx))

      const receipt = await repo.createDraft(tx, {
        customerId: command.customerId,
        receiptDate,
        method: command.method,
        amount,
        reference,
        narration,
        allocations: command.allocations,
        createIdempotencyKey: command.idempotencyKey,
        createFingerprint: fingerprint,
      })

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'CUSTOMER_RECEIPT_DRAFT_CREATED',
        entityType: 'customer_receipt',
        entityId: receipt.id,
        beforeJson: null,
        afterJson: {
          customerId: receipt.customerId,
          receiptDate: receipt.receiptDate,
          method: receipt.method,
          amount: receipt.amount,
          reference: receipt.reference,
          narration: receipt.narration,
          allocations: command.allocations.map((a) => ({
            invoiceId: a.invoiceId,
            amount: a.amount,
          })),
        },
      })

      return { receipt, replayed: false }
    })
  }
}
