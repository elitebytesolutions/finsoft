import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TenantContext } from '@finsoft/database'
import { REPO_ROOT } from '@finsoft/database/testing'
import { customerDirectory } from '../../modules/customers/index.ts'
import type { DocumentPostResult, DraftResult, InvoiceLine, ReceivablesPort } from './receivables-port.ts'

/*
 * Loads a REAL `ReceivablesPort` from `modules/receivables`, once M3-P
 * builds it. Returns null — never throws — when the module does not exist
 * yet (this branch, today) or when it exists but its shape does not match
 * what this file expects: staying PENDING is always the safe failure,
 * never a crash that takes the whole financial gate down with it.
 *
 * File-existence check, not a bare `import()`, on purpose: a dynamic
 * import of a path that does not exist is still resolved STATICALLY by
 * TypeScript under `moduleResolution: nodenext` even inside `import()`,
 * which would fail `npm run typecheck` on THIS branch, where
 * `modules/receivables` has no files at all. Building the specifier from
 * parts (`pathToFileURL(...).href`, not a string literal) additionally
 * keeps Vite/esbuild from trying to pre-bundle it during `vitest run`'s
 * collection phase, which would fail the same way at runtime.
 *
 * `modules/customers` (and so `customerDirectory`) already exists on this
 * branch (M3-C, merged) — that import above is static, ordinary, and safe.
 * Only `modules/receivables` needs the dynamic gate.
 *
 * ADR-0028 statement 10: "tests/accounting/: golden scenarios and
 * Invariant 9, driven through the module's index.ts, not the kernel." This
 * file is that path — `createReceivablesUseCases(customerDirectory)`,
 * exactly as `apps/api/src/receivables/composition.ts` builds it, called
 * with NO `tx` argument (receivables-port.ts's own header: every use case
 * opens its own `withTenant`, matching `modules/customers`').
 */

const RECEIVABLES_INDEX = join(REPO_ROOT, 'modules', 'receivables', 'index.ts')

export function receivablesModuleFileExists(): boolean {
  return existsSync(RECEIVABLES_INDEX)
}

/** The one function this file needs from `modules/receivables/index.ts`. */
interface ReceivablesModule {
  readonly createReceivablesUseCases: (
    customerDirectory: unknown,
  ) => Record<string, (...args: never[]) => unknown>
}

async function loadReceivablesModule(): Promise<ReceivablesModule | null> {
  if (!receivablesModuleFileExists()) return null
  try {
    const specifier = pathToFileURL(RECEIVABLES_INDEX).href
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
    if (typeof mod['createReceivablesUseCases'] !== 'function') return null
    return mod as unknown as ReceivablesModule
  } catch {
    return null
  }
}

/** `{ userId }`, read from the AMBIENT TenantContext the caller established (receivables-port.ts's header). */
function actor(): { readonly userId: string } {
  const principal = TenantContext.require()
  if (!principal.userId) {
    throw new Error('receivables-real-port.ts: no acting user in the current TenantContext.')
  }
  return { userId: principal.userId }
}

type DocType = 'sales_invoice' | 'customer_receipt'

/**
 * Adapts the real module to `ReceivablesPort`, if `modules/receivables`
 * exists and matches this shape. Returns null otherwise, exactly like
 * `loadReceivablesModule` — never throws for "not found" or "wrong shape".
 *
 * State this test adapter keeps for itself, matching
 * `fixtures/fake-receivables-port.ts`'s own pattern: a document ref
 * ("INV-A1") to the real row's id, because the golden files reference
 * documents by fixture ref and the real module only knows ids.
 */
export async function loadReceivablesRealPort(): Promise<ReceivablesPort | null> {
  const mod = await loadReceivablesModule()
  if (!mod) return null

  let useCases: ReturnType<ReceivablesModule['createReceivablesUseCases']>
  try {
    useCases = mod.createReceivablesUseCases(customerDirectory)
  } catch {
    return null
  }

  const REQUIRED = [
    'createInvoiceDraft',
    'updateInvoiceDraft',
    'cancelInvoiceDraft',
    'postInvoice',
    'reverseInvoice',
    'getInvoice',
    'listInvoices',
    'createReceiptDraft',
    'updateReceiptDraft',
    'cancelReceiptDraft',
    'postReceipt',
    'reverseReceipt',
    'getReceipt',
    'listReceipts',
  ] as const
  if (REQUIRED.some((name) => typeof useCases[name] !== 'function')) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uc = useCases as any

  const refToDoc = new Map<string, { readonly id: string; readonly type: DocType }>()
  const trackedIds = { sales_invoice: new Set<string>(), customer_receipt: new Set<string>() }

  function track(ref: string, id: string, type: DocType): void {
    refToDoc.set(ref, { id, type })
    trackedIds[type].add(id)
  }
  function resolve(ref: string, expect?: DocType): { readonly id: string; readonly type: DocType } {
    const found = refToDoc.get(ref)
    if (!found) throw new Error(`receivables-real-port.ts: unknown document ref "${ref}".`)
    if (expect && found.type !== expect) {
      throw new Error(`receivables-real-port.ts: "${ref}" is not a ${expect}.`)
    }
    return found
  }

  /** service-sale.md §4/§6: the golden payload's lines carry `kind`/`lineNet`; the real command computes lineNet itself and knows only SERVICE. */
  function toInvoiceLines(
    rawLines: readonly Record<string, unknown>[],
  ): readonly { description: string; quantity: string; unitPrice: string }[] {
    return rawLines.map((line) => ({
      description: line.description as string,
      quantity: line.quantity as string,
      unitPrice: line.unitPrice as string,
    }))
  }

  async function ensureInvoiceDraft(
    documentRef: string,
    customerId: string,
    occurredAt: string,
    payload: Record<string, unknown>,
  ): Promise<{ readonly id: string; readonly version: number }> {
    const existing = refToDoc.get(documentRef)
    if (existing) {
      const current = await uc.getInvoice(existing.id)
      return { id: existing.id, version: current.invoice.version }
    }
    const result = await uc.createInvoiceDraft({
      customerId,
      invoiceDate: occurredAt,
      dueDate: null,
      narration: null,
      lines: toInvoiceLines((payload.lines as Record<string, unknown>[]) ?? []),
      idempotencyKey: `${documentRef}:draft`,
      actor: actor(),
    })
    track(documentRef, result.invoice.id, 'sales_invoice')
    return { id: result.invoice.id, version: result.invoice.version }
  }

  async function ensureReceiptDraft(
    documentRef: string,
    customerId: string,
    occurredAt: string,
    payload: Record<string, unknown>,
  ): Promise<{ readonly id: string; readonly version: number }> {
    const existing = refToDoc.get(documentRef)
    if (existing) {
      const current = await uc.getReceipt(existing.id)
      return { id: existing.id, version: current.receipt.version }
    }
    const rawAllocations = (payload.allocations as { invoice: string; amount: string }[]) ?? []
    const result = await uc.createReceiptDraft({
      customerId,
      receiptDate: occurredAt,
      method: (payload.method as string) ?? null,
      amount: (payload.amount as string) ?? null,
      reference: null,
      narration: null,
      allocations: rawAllocations.map((a) => ({
        invoiceId: resolve(a.invoice, 'sales_invoice').id,
        amount: a.amount,
      })),
      idempotencyKey: `${documentRef}:draft`,
      actor: actor(),
    })
    track(documentRef, result.receipt.id, 'customer_receipt')
    return { id: result.receipt.id, version: result.receipt.version }
  }

  return {
    async postInvoice(input) {
      const { id, version } = await ensureInvoiceDraft(
        input.documentRef,
        input.customerId,
        input.occurredAt,
        input.payload,
      )
      const result = await uc.postInvoice({
        id,
        expectedVersion: version,
        idempotencyKey: input.idempotencyKey,
        actor: actor(),
      })
      /*
       * P10 (Accounting seat ruling, 2026-09-29): read the module's OWN
       * computed lines back (getInvoice, not a value this adapter derived),
       * so `invoiceLines` proves the module independently arrives at the
       * same half-up tie the kernel enforces. `ComputedInvoiceLine` also
       * carries `lineNo`, which `InvoiceLine` (receivables-port.ts) does
       * not — stripped here, not added to the golden file, because line
       * order is already what the array's own position asserts.
       */
      const current = await uc.getInvoice(id)
      const lines: readonly InvoiceLine[] = (
        current.lines as readonly {
          description: string
          quantity: string
          unitPrice: string
          lineNet: string
        }[]
      ).map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineNet: line.lineNet,
      }))
      return {
        outcome: result.replayed ? 'REPLAYED' : 'POSTED',
        documentNumber: result.invoice.number as string,
        entryNumber: result.journalEntryNumber,
        entryId: result.journalEntryId,
        documentStatus: result.invoice.status,
        lines,
      } satisfies DocumentPostResult
    },

    async postReceipt(input) {
      const { id, version } = await ensureReceiptDraft(
        input.documentRef,
        input.customerId,
        input.occurredAt,
        input.payload,
      )
      const result = await uc.postReceipt({
        id,
        expectedVersion: version,
        idempotencyKey: input.idempotencyKey,
        actor: actor(),
      })
      return {
        outcome: result.replayed ? 'REPLAYED' : 'POSTED',
        documentNumber: result.receipt.number as string,
        entryNumber: result.journalEntryNumber,
        entryId: result.journalEntryId,
        documentStatus: result.receipt.status,
      } satisfies DocumentPostResult
    },

    async reverseDocument(input) {
      const doc = resolve(input.documentRef)
      const result =
        doc.type === 'sales_invoice'
          ? await uc.reverseInvoice({
              id: doc.id,
              reason: input.reason,
              idempotencyKey: input.idempotencyKey,
              actor: actor(),
            })
          : await uc.reverseReceipt({
              id: doc.id,
              reason: input.reason,
              idempotencyKey: input.idempotencyKey,
              actor: actor(),
            })
      const document = doc.type === 'sales_invoice' ? result.invoice : result.receipt
      return {
        outcome: result.replayed ? 'REPLAYED' : 'POSTED',
        documentNumber: document.number as string,
        entryNumber: result.journalEntryNumber,
        entryId: result.journalEntryId,
        documentStatus: document.status,
      } satisfies DocumentPostResult
    },

    async saveDraft(input) {
      const fields = input.fields as Record<string, unknown>
      if (input.documentType === 'sales_invoice') {
        const result = await uc.createInvoiceDraft({
          customerId: input.customerId,
          invoiceDate: (fields.invoiceDate as string) ?? null,
          dueDate: null,
          narration: null,
          lines: toInvoiceLines((fields.lines as Record<string, unknown>[]) ?? []),
          idempotencyKey: `${input.documentRef}:draft`,
          actor: actor(),
        })
        track(input.documentRef, result.invoice.id, 'sales_invoice')
        return {
          documentStatus: result.invoice.status,
          documentNumber: result.invoice.number,
        } satisfies DraftResult
      }
      const rawAllocations = (fields.allocations as { invoice: string; amount: string }[]) ?? []
      const result = await uc.createReceiptDraft({
        customerId: input.customerId,
        receiptDate: (fields.receiptDate as string) ?? null,
        method: (fields.method as string) ?? null,
        amount: (fields.amount as string) ?? null,
        reference: null,
        narration: null,
        allocations: rawAllocations.map((a) => ({
          invoiceId: resolve(a.invoice, 'sales_invoice').id,
          amount: a.amount,
        })),
        idempotencyKey: `${input.documentRef}:draft`,
        actor: actor(),
      })
      track(input.documentRef, result.receipt.id, 'customer_receipt')
      return {
        documentStatus: result.receipt.status,
        documentNumber: result.receipt.number,
        allocations: rawAllocations.map((a) => ({
          invoiceRef: a.invoice,
          amount: a.amount,
          status: 'PROPOSED',
        })),
      } satisfies DraftResult
    },

    async editDraft(input) {
      const doc = resolve(input.documentRef, input.documentType)
      const fields = input.fields as Record<string, unknown>
      if (doc.type === 'sales_invoice') {
        const current = await uc.getInvoice(doc.id)
        const updated = await uc.updateInvoiceDraft({
          id: doc.id,
          customerId: current.invoice.customerId,
          invoiceDate: (fields.invoiceDate as string) ?? current.invoice.invoiceDate,
          dueDate: current.invoice.dueDate,
          narration: current.invoice.narration,
          lines: toInvoiceLines(current.lines),
          expectedVersion: current.invoice.version,
          actor: actor(),
        })
        return {
          documentStatus: updated.status,
          documentNumber: updated.number,
        } satisfies DraftResult
      }
      const current = await uc.getReceipt(doc.id)
      const updated = await uc.updateReceiptDraft({
        id: doc.id,
        receiptDate: (fields.receiptDate as string) ?? current.receipt.receiptDate,
        expectedVersion: current.receipt.version,
        actor: actor(),
      })
      return {
        documentStatus: updated.status,
        documentNumber: updated.number,
      } satisfies DraftResult
    },

    async cancelDraft(input) {
      const doc = resolve(input.documentRef, input.documentType)
      if (doc.type === 'sales_invoice') {
        const current = await uc.getInvoice(doc.id)
        const updated = await uc.cancelInvoiceDraft({
          id: doc.id,
          expectedVersion: current.invoice.version,
          actor: actor(),
        })
        return {
          documentStatus: updated.status,
          documentNumber: updated.number,
        } satisfies DraftResult
      }
      const current = await uc.getReceipt(doc.id)
      const updated = await uc.cancelReceiptDraft({
        id: doc.id,
        expectedVersion: current.receipt.version,
        actor: actor(),
      })
      return {
        documentStatus: updated.status,
        documentNumber: updated.number,
      } satisfies DraftResult
    },

    async invoiceOutstanding(documentRef) {
      const doc = resolve(documentRef, 'sales_invoice')
      const current = await uc.getInvoice(doc.id)
      return current.outstanding as string
    },

    async documentStatus(documentType, documentRef) {
      const doc = resolve(documentRef, documentType)
      if (doc.type === 'sales_invoice')
        return (await uc.getInvoice(doc.id)).invoice.status as string
      return (await uc.getReceipt(doc.id)).receipt.status as string
    },

    async documentNumbersIssued(series) {
      const type: DocType = series === 'INV' ? 'sales_invoice' : 'customer_receipt'
      const numbers: string[] = []
      for (const id of trackedIds[type]) {
        const number: string | null =
          type === 'sales_invoice'
            ? (await uc.getInvoice(id)).invoice.number
            : (await uc.getReceipt(id)).receipt.number
        if (number !== null) numbers.push(number)
      }
      return numbers.sort()
    },
  }
}
