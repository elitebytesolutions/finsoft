import { withTenant } from '@finsoft/database'
import { Money } from '@finsoft/validation'
import {
  previewAllocationProblems,
  suggestAllocations,
  type AllocatableInvoice,
  type AllocationInput,
} from '../domain/receipt.ts'
import { ReceivablesError } from '../domain/errors.ts'
import type { InvoicesRepository, ReceiptsRepository } from './ports.ts'

/*
 * PreviewReceipt (R2). Stateless from the caller's point of view: writes
 * nothing, takes no lock (api-contract.md §2). Runs the SAME domain
 * functions `PostReceipt` runs, so the figure the user sees is the figure
 * that posts (api-contract.md §2 "Why I6 and R2 exist").
 */

export interface PreviewReceiptCommand {
  readonly customerId: string | null
  readonly receiptId: string | null
  readonly receiptDate: string | null
  readonly amount: string | null
  readonly allocations: readonly AllocationInput[] | null
}

export interface ReceiptPreviewOpenInvoice {
  readonly invoiceId: string
  readonly number: string
  readonly invoiceDate: string
  readonly dueDate: string | null
  readonly netAmount: string
  readonly outstanding: string
}

export interface ReceiptPreviewResult {
  readonly openInvoices: readonly ReceiptPreviewOpenInvoice[]
  readonly allocations: readonly AllocationInput[]
  readonly suggested: boolean
  readonly allocatedTotal: string
  readonly unallocated: string
  readonly problems: readonly { code: string; invoiceId: string | null; details: unknown }[]
}

export function createPreviewReceipt(
  receiptsRepo: ReceiptsRepository,
  invoicesRepo: InvoicesRepository,
) {
  return async function previewReceipt(command: PreviewReceiptCommand): Promise<ReceiptPreviewResult> {
    return withTenant(async (tx) => {
      let customerId = command.customerId
      let receiptDate = command.receiptDate
      let amount = command.amount
      let allocations = command.allocations

      if (command.receiptId) {
        const draft = await receiptsRepo.findById(tx, command.receiptId)
        if (!draft) {
          throw new ReceivablesError(
            'RECEIPT_NOT_FOUND',
            `receipt ${command.receiptId} was not found.`,
          )
        }
        customerId = customerId ?? draft.customerId
        receiptDate = receiptDate ?? draft.receiptDate
        amount = amount ?? draft.amount
        if (allocations === null) {
          const proposals = await receiptsRepo.currentProposals(tx, command.receiptId)
          allocations = proposals.map((p) => ({ invoiceId: p.invoiceId, amount: p.amount }))
        }
      }
      if (!customerId) {
        throw new ReceivablesError('VALIDATION_FAILED', 'customerId or receiptId is required.', {
          path: 'customerId',
        })
      }
      const resolvedDate = receiptDate ?? (await receiptsRepo.today(tx))
      const resolvedAmount = amount ?? '0.0000'

      const openPage = await invoicesRepo.list(
        tx,
        { customerId, status: ['POSTED'], openOnly: true, from: null, to: null, q: null },
        { limit: 200, after: null },
      )
      const openInvoices: ReceiptPreviewOpenInvoice[] = []
      const byId = new Map<string, AllocatableInvoice>()
      for (const item of openPage.items) {
        const outstanding = item.outstanding ?? '0.0000'
        openInvoices.push({
          invoiceId: item.invoice.id,
          number: item.invoice.number as string,
          invoiceDate: item.invoice.invoiceDate,
          dueDate: item.invoice.dueDate,
          netAmount: item.invoice.netAmount,
          outstanding,
        })
        byId.set(item.invoice.id, {
          id: item.invoice.id,
          number: item.invoice.number as string,
          customerId: item.invoice.customerId,
          status: item.invoice.status,
          invoiceDate: item.invoice.invoiceDate,
          outstanding,
        })
      }

      const suggested = allocations === null || allocations === undefined
      let finalAllocations: readonly AllocationInput[]
      let unallocated: string
      if (suggested) {
        const oldestFirst = [...byId.values()].sort((a, b) => (a.invoiceDate < b.invoiceDate ? -1 : 1))
        const result = suggestAllocations(oldestFirst, resolvedAmount)
        finalAllocations = result.allocations
        unallocated = result.unallocated
      } else {
        finalAllocations = allocations ?? []
        const allocatedTotal = Money.sum(finalAllocations.map((a) => Money.from(a.amount)))
        unallocated = Money.serialize(Money.subtract(Money.from(resolvedAmount), allocatedTotal), 4)
      }

      const problems = previewAllocationProblems(customerId, resolvedDate, finalAllocations, byId).map(
        (p) => ({ code: p.code, invoiceId: p.invoiceId, details: p.details }),
      )
      if (!suggested && !Money.isZero(Money.from(unallocated))) {
        problems.push({ code: 'RECEIPT_UNALLOCATED_AMOUNT', invoiceId: null, details: { unallocated } })
      }

      const allocatedTotal = Money.serialize(
        Money.sum(finalAllocations.map((a) => Money.from(a.amount))),
        4,
      )

      return {
        openInvoices,
        allocations: finalAllocations,
        suggested,
        allocatedTotal,
        unallocated,
        problems,
      }
    })
  }
}
