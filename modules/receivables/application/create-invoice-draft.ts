import { recordAudit, withTenant } from '@finsoft/database'
import type { CustomerDirectory } from '@finsoft/customers/published'
import {
  computeInvoiceLines,
  normalizeNarration,
  type Invoice,
  type InvoiceLineInput,
} from '../domain/invoice.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { Actor } from './actor.ts'
import { computeCommandFingerprint } from './fingerprint.ts'
import type { InvoicesRepository } from './ports.ts'

/*
 * CreateInvoiceDraft (I2). modules.md §4.1 restated for a non-posting
 * mutation, §9 (idempotency). `customerDirectory.requireActiveForPosting`
 * per api-contract.md §3 (CUSTOMER_INACTIVE on I2/I4/I7) — an inactive
 * customer cannot be invoiced, even as a draft (service-sale.md ruling R-2).
 */

export interface CreateInvoiceDraftCommand {
  readonly customerId: string
  readonly invoiceDate: string | null
  readonly dueDate: string | null
  readonly narration: string | null
  readonly lines: readonly InvoiceLineInput[]
  readonly idempotencyKey: string
  readonly actor: Actor
}

export interface CreateInvoiceDraftResult {
  readonly invoice: Invoice
  readonly replayed: boolean
}

function assertDueDate(invoiceDate: string, dueDate: string | null): void {
  if (dueDate !== null && dueDate < invoiceDate) {
    throw new ReceivablesError('VALIDATION_FAILED', 'dueDate must not be before invoiceDate.', {
      path: 'dueDate',
    })
  }
}

export function createCreateInvoiceDraft(
  repo: InvoicesRepository,
  customerDirectory: CustomerDirectory,
) {
  return async function createInvoiceDraft(
    command: CreateInvoiceDraftCommand,
  ): Promise<CreateInvoiceDraftResult> {
    const calculation = computeInvoiceLines(command.lines, { requireAtLeastOne: false })
    const narration = normalizeNarration(command.narration)
    const fingerprint = computeCommandFingerprint({
      route: 'POST /api/invoices',
      targetId: null,
      command: {
        customerId: command.customerId,
        invoiceDate: command.invoiceDate,
        dueDate: command.dueDate,
        narration,
        lines: command.lines,
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
        return { invoice: prior.invoice, replayed: true }
      }

      const customer = await customerDirectory.requireActiveForPosting(tx, command.customerId)
      const invoiceDate = command.invoiceDate ?? (await repo.today(tx))
      const dueDate = command.dueDate ?? addDays(invoiceDate, customer.creditDays)
      assertDueDate(invoiceDate, dueDate)

      const invoice = await repo.createDraft(tx, {
        customerId: command.customerId,
        invoiceDate,
        dueDate,
        narration,
        lines: calculation.lines,
        netAmount: calculation.netAmount,
        createIdempotencyKey: command.idempotencyKey,
        createFingerprint: fingerprint,
      })

      await recordAudit(tx, {
        actorUserId: command.actor.userId,
        action: 'SALES_INVOICE_DRAFT_CREATED',
        entityType: 'sales_invoice',
        entityId: invoice.id,
        beforeJson: null,
        afterJson: {
          customerId: invoice.customerId,
          invoiceDate: invoice.invoiceDate,
          dueDate: invoice.dueDate,
          narration: invoice.narration,
          netAmount: invoice.netAmount,
          lines: calculation.lines.map((l) => ({
            lineNo: String(l.lineNo),
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineNet: l.lineNet,
          })),
        },
      })

      return { invoice, replayed: false }
    })
  }
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
