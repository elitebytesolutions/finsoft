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
import { computeCommandFingerprint } from './fingerprint.ts'
import { loadReceiptReadModel, type GetReceiptResult } from './get-receipt.ts'
import type { InvoicesRepository, ReceiptsRepository } from './ports.ts'

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

export interface CreateReceiptDraftResult extends GetReceiptResult {
  readonly replayed: boolean
}

export function createCreateReceiptDraft(
  repo: ReceiptsRepository,
  invoicesRepo: InvoicesRepository,
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
        const readModel = await loadReceiptReadModel(
          tx,
          prior.receipt,
          repo,
          invoicesRepo,
          customerDirectory,
        )
        return { ...readModel, replayed: true }
      }

      await customerDirectory.requireForPayment(tx, command.customerId)

      // S-D (Security seat, Council review of efb7e3f): a foreign-tenant
      // (or simply unknown) invoiceId in a proposal must be a typed
      // INVOICE_NOT_FOUND (422, api-contract.md §3 "in allocations[]"), not
      // a raw 23503 from the composite FK when the proposal row is
      // inserted. `existingIds` is scoped to the tenant, so an id from
      // another tenant is indistinguishable from an unknown one.
      if (command.allocations.length > 0) {
        const invoiceIds = [...new Set(command.allocations.map((a) => a.invoiceId))]
        const found = await invoicesRepo.existingIds(tx, invoiceIds)
        for (const invoiceId of invoiceIds) {
          if (!found.has(invoiceId)) {
            throw new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${invoiceId} was not found.`, {
              invoiceId,
            })
          }
        }
      }

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

      const readModel = await loadReceiptReadModel(
        tx,
        receipt,
        repo,
        invoicesRepo,
        customerDirectory,
      )
      return { ...readModel, replayed: false }
    })
  }
}
