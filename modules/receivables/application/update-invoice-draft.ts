import { recordAudit, withTenant } from '@finsoft/database'
import type { CustomerDirectory } from '@finsoft/customers/published'
import {
  computeInvoiceLines,
  normalizeNarration,
  type InvoiceLineInput,
} from '../domain/invoice.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import { loadInvoiceReadModel, type GetInvoiceResult } from './get-invoice.ts'
import type { InvoicesRepository } from './ports.ts'

/** UpdateInvoiceDraft (I4) — full replacement of a DRAFT's header + lines. */
export interface UpdateInvoiceDraftCommand {
  readonly id: string
  readonly customerId: string
  readonly invoiceDate: string | null
  readonly dueDate: string | null
  readonly narration: string | null
  readonly lines: readonly InvoiceLineInput[]
  readonly expectedVersion: number
  readonly actor: Actor
}

function assertDueDate(invoiceDate: string, dueDate: string | null): void {
  if (dueDate !== null && dueDate < invoiceDate) {
    throw new ReceivablesError('VALIDATION_FAILED', 'dueDate must not be before invoiceDate.', {
      path: 'dueDate',
    })
  }
}

export function createUpdateInvoiceDraft(
  repo: InvoicesRepository,
  customerDirectory: CustomerDirectory,
) {
  return async function updateInvoiceDraft(
    command: UpdateInvoiceDraftCommand,
  ): Promise<GetInvoiceResult> {
    return withTenant(async (tx) => {
      // LOCK_REGISTRY 1a before 1c (Security seat, Council review of
      // efb7e3f, S-C): the customer is locked FOR SHARE before the invoice
      // row, exactly as PostInvoice does — a lock order with an exception
      // for drafts is a lock order the next change forgets. CUSTOMER_INACTIVE
      // on I4 (api-contract.md §3) is re-checked even when customerId is
      // unchanged — a customer can be deactivated between two edits of the
      // same draft.
      const customer = await customerDirectory.requireActiveForPosting(tx, command.customerId)

      const existing = await repo.lockForUpdate(tx, command.id)
      if (!existing) {
        throw new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${command.id} was not found.`, {
          invoiceId: command.id,
        })
      }
      existing.assertVersion(command.expectedVersion)
      existing.assertDraft()

      const calculation = computeInvoiceLines(command.lines, { requireAtLeastOne: false })
      const narration = normalizeNarration(command.narration)
      const invoiceDate = command.invoiceDate ?? (await repo.today(tx))
      const dueDate = command.dueDate ?? addDays(invoiceDate, customer.creditDays)
      assertDueDate(invoiceDate, dueDate)

      const before = {
        customerId: existing.customerId,
        invoiceDate: existing.invoiceDate,
        dueDate: existing.dueDate,
        narration: existing.narration,
        netAmount: existing.netAmount,
      }

      const updated = await repo.updateDraft(
        tx,
        command.id,
        {
          customerId: command.customerId,
          invoiceDate,
          dueDate,
          narration,
          lines: calculation.lines,
          netAmount: calculation.netAmount,
        },
        command.expectedVersion,
      )

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'SALES_INVOICE_DRAFT_UPDATED',
        entityType: 'sales_invoice',
        entityId: command.id,
        beforeJson: before,
        afterJson: {
          customerId: updated.customerId,
          invoiceDate: updated.invoiceDate,
          dueDate: updated.dueDate,
          narration: updated.narration,
          netAmount: updated.netAmount,
          lines: calculation.lines.map((l) => ({
            lineNo: String(l.lineNo),
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineNet: l.lineNet,
          })),
        },
      })

      return loadInvoiceReadModel(tx, updated, repo, customerDirectory)
    })
  }
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
