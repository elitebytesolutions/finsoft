import { recordAudit, withTenant } from '@finsoft/database'
import { documentNumbers, postingEngine, PostingError } from '@finsoft/accounting-kernel'
import { CustomerDirectoryError, type CustomerDirectory } from '@finsoft/customers/published'
import { buildSalePostedPayload, computeInvoiceLines } from '../domain/invoice.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import { computeCommandFingerprint } from './fingerprint.ts'
import { loadInvoiceReadModel, type GetInvoiceResult } from './get-invoice.ts'
import type { InvoicesRepository } from './ports.ts'

/*
 * PostInvoice (I7). modules.md §4.1, lock order §10 (1a customer FOR SHARE,
 * 1c invoice FOR UPDATE, 5a INV number, 5b JE number, 6 audit).
 *
 * Idempotency: two lines of defence (modules.md §9). This module's OWN
 * post_idempotency_key/post_fingerprint on `sales_invoices` answers a
 * REUSED-KEY-different-content request (IDEMPOTENCY_KEY_REUSED) without
 * ever reaching the kernel. A confirmed replay (same key, same fingerprint)
 * still makes ONE call to `postingEngine.post` with the identical command —
 * which the kernel's OWN idempotency (ADR-0027, "idempotency first, before
 * the period gate") answers immediately as REPLAYED, without writing
 * anything — purely so this module can return the SAME `journalEntry`
 * {id, number} the original call did, without a second pointer on the
 * invoice row (modules.md §7: "a second pointer would be a copy that can
 * disagree").
 */

export interface PostInvoiceCommand {
  readonly id: string
  readonly expectedVersion: number
  readonly idempotencyKey: string
  readonly actor: Actor
}

export interface PostInvoiceResult extends GetInvoiceResult {
  readonly journalEntryId: string
  readonly journalEntryNumber: string
  readonly replayed: boolean
}

export function createPostInvoice(repo: InvoicesRepository, customerDirectory: CustomerDirectory) {
  return async function postInvoice(command: PostInvoiceCommand): Promise<PostInvoiceResult> {
    const fingerprint = computeCommandFingerprint({
      route: 'POST /api/invoices/:id/post',
      targetId: command.id,
      command: { version: command.expectedVersion },
    })

    return withTenant(async (tx) => {
      // Step 0: an unlocked read, so the customer can be locked BEFORE the
      // invoice, in LOCK_REGISTRY order (modules.md §4.1's own note).
      const customerId = await repo.customerIdOf(tx, command.id)
      if (!customerId) {
        throw new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${command.id} was not found.`, {
          invoiceId: command.id,
        })
      }
      // Step 1: FOR SHARE (1a) — lock order preserved unconditionally.
      // CUSTOMER_INACTIVE on I7 (api-contract.md §3) is thrown only on the
      // FRESH-post path below, not here: a replay of an invoice posted
      // while the customer was still ACTIVE must succeed even after the
      // customer has since been deactivated (Accounting seat, Council
      // review of efb7e3f — "move the replay branch BEFORE
      // requireActiveForPosting"). The lock itself still happens first,
      // in order; only the THROW is deferred.
      let inactiveError: CustomerDirectoryError | null = null
      try {
        await customerDirectory.requireActiveForPosting(tx, customerId)
      } catch (error) {
        if (error instanceof CustomerDirectoryError && error.code === 'CUSTOMER_INACTIVE') {
          inactiveError = error
        } else {
          throw error
        }
      }

      // Step 2: FOR UPDATE (1c).
      const invoice = await repo.lockForUpdate(tx, command.id)
      if (!invoice) {
        throw new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${command.id} was not found.`, {
          invoiceId: command.id,
        })
      }

      if (invoice.status === 'CANCELLED') {
        throw new ReceivablesError(
          'INVOICE_NOT_DRAFT',
          `invoice ${command.id} is CANCELLED, not DRAFT.`,
          { status: 'CANCELLED' },
        )
      }

      if (invoice.status === 'POSTED' || invoice.status === 'REVERSED') {
        if (invoice.postIdempotencyKey !== command.idempotencyKey) {
          throw new ReceivablesError(
            'SOURCE_ALREADY_POSTED',
            `invoice ${invoice.number} is already posted.`,
            { documentNumber: invoice.number },
          )
        }
        if (invoice.postFingerprint !== fingerprint) {
          throw new ReceivablesError(
            'IDEMPOTENCY_KEY_REUSED',
            `idempotencyKey "${command.idempotencyKey}" was already used for a different request.`,
          )
        }
        // Confirmed replay: re-run the SAME command so the kernel's own
        // idempotency (step 2, before the period gate) hands back the
        // ORIGINAL entry — no new number, no new lines, no new audit.
        const lines = await repo.currentLines(tx, invoice.id)
        const calculation = computeInvoiceLines(
          lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          })),
          { requireAtLeastOne: true },
        )
        const entry = await postingEngine.post(
          {
            event: 'SALE_POSTED',
            referenceType: 'sales_invoice',
            referenceId: invoice.id,
            referenceNumber: invoice.number as string,
            occurredAt: invoice.invoiceDate,
            idempotencyKey: command.idempotencyKey,
            payload: buildSalePostedPayload(invoice.customerId, calculation),
          },
          tx,
        )
        const readModel = await loadInvoiceReadModel(tx, invoice, repo, customerDirectory)
        return {
          ...readModel,
          journalEntryId: entry.journalEntryId,
          journalEntryNumber: entry.entry.entryNumber,
          replayed: true,
        }
      }

      // OLD.status === 'DRAFT' from here — a FRESH post, which does need an
      // ACTIVE customer. This is where the deferred CUSTOMER_INACTIVE (if
      // any) is finally thrown.
      if (inactiveError) throw inactiveError
      invoice.assertVersion(command.expectedVersion)
      if (invoice.customerId !== customerId) {
        // The draft's customer changed between step 0's read and this lock —
        // reload and retry (modules.md §4.1).
        throw new ReceivablesError(
          'VERSION_CONFLICT',
          `invoice ${command.id}'s customer changed since it was read.`,
          { currentVersion: invoice.version },
        )
      }

      const lines = await repo.currentLines(tx, invoice.id)
      const calculation = computeInvoiceLines(
        lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
        { requireAtLeastOne: true },
      )

      const number = await documentNumbers.next(tx, {
        series: 'INV',
        occurredAt: invoice.invoiceDate,
      })

      const posted = await repo.markPosted(
        tx,
        invoice.id,
        {
          number,
          postedBy: command.actor.userId,
          postIdempotencyKey: command.idempotencyKey,
          postFingerprint: fingerprint,
        },
        command.expectedVersion,
      )

      const entry = await postingEngine.post(
        {
          event: 'SALE_POSTED',
          referenceType: 'sales_invoice',
          referenceId: invoice.id,
          referenceNumber: number,
          occurredAt: invoice.invoiceDate,
          idempotencyKey: command.idempotencyKey,
          payload: buildSalePostedPayload(invoice.customerId, calculation),
        },
        tx,
      )

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'SALES_INVOICE_POSTED',
        entityType: 'sales_invoice',
        entityId: invoice.id,
        beforeJson: { status: 'DRAFT' },
        afterJson: {
          status: 'POSTED',
          number,
          netAmount: calculation.netAmount,
          journalEntryId: entry.journalEntryId,
        },
      })

      const readModel = await loadInvoiceReadModel(tx, posted, repo, customerDirectory)
      return {
        ...readModel,
        journalEntryId: entry.journalEntryId,
        journalEntryNumber: entry.entry.entryNumber,
        replayed: entry.outcome === 'REPLAYED',
      }
    })
  }
}

export { PostingError }
