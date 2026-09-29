import { randomUUID } from 'node:crypto'
import {
  IMPLEMENTED_EVENTS,
  PostingError,
  type FinancialEventName,
} from '@finsoft/accounting-kernel'
import {
  computeRequestFingerprint,
  findEntryById,
  findLinesByEntryId,
  withTenant,
  type JournalLineRow,
  type NewJournalLine,
  type TenantTx,
} from '@finsoft/database'
import { Money } from '@finsoft/validation'
import { requirePostingActor } from '../../../packages/accounting-kernel/src/actor.ts'
import { fixedClock } from '../../../packages/accounting-kernel/src/clock.ts'
import {
  assertIdempotencyKey,
  createPostingEngine,
  runPostingPipeline,
} from '../../../packages/accounting-kernel/src/posting-engine.ts'
import { markJournalEntryReversed } from '../../../packages/accounting-kernel/src/queries/journal-writes.ts'
import type { DocumentPostResult, DraftResult, ReceivablesPort } from '../receivables-port.ts'

/**
 * K2 (`reverseForSource`, docs/design/M3/README.md §4) does not exist on
 * this branch — it is M3-P's kernel addition. This is this FIXTURE's
 * best-effort stand-in, built the same way `reversal.ts`'s own
 * `createReversalEngine` is (`runPostingPipeline` directly, the same
 * pipeline every post uses — steps 2-11 of ADR-0005): mirror E's stored
 * lines with debit/credit swapped, same account/control/party, RV series,
 * `reversalOf: entryId`. It skips the real K2's disclosure logic (E's
 * period closed since) and its ACCOUNT_INACTIVE re-check — every M3
 * golden fixture keeps periods OPEN and accounts active throughout, so
 * neither branch is exercised by P04-P12 today. A real K2 must implement
 * both; this fake does not certify that it will.
 */
async function fakeReverseForSource(
  tx: TenantTx,
  clock: ReturnType<typeof fixedClock>,
  entryId: string,
  reason: string,
  idempotencyKey: string,
): Promise<{ outcome: 'POSTED' | 'REPLAYED'; entry: { id: string; entryNumber: string } }> {
  const { tenantId, actorUserId } = requirePostingActor(tx)
  const trimmedReason = reason.trim()
  if (trimmedReason.length === 0 || trimmedReason.length > 500) {
    throw new PostingError(
      'REVERSAL_REASON_REQUIRED',
      'a non-empty reason, at most 500 characters, is required.',
    )
  }
  assertIdempotencyKey(idempotencyKey)

  const original = await findEntryById(tx, tenantId, entryId)
  if (!original)
    throw new PostingError('ENTRY_NOT_FOUND', `entry ${entryId} was not found.`, { entryId })
  if (original.reversalOf !== null) {
    throw new PostingError(
      'REVERSAL_OF_REVERSAL',
      `${original.entryNumber} is itself a reversal.`,
      {
        entry: original.entryNumber,
      },
    )
  }
  if (original.status === 'REVERSED') {
    const rev = original.reversedBy ? await findEntryById(tx, tenantId, original.reversedBy) : null
    throw new PostingError(
      'ALREADY_REVERSED',
      `${original.entryNumber} is already REVERSED by ${rev?.entryNumber ?? String(original.reversedBy)}.`,
      { entry: original.entryNumber, reversedBy: rev?.entryNumber ?? null },
    )
  }

  const reverseLine = (line: JournalLineRow): NewJournalLine => ({
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    accountControl: line.accountControl,
    debit: line.credit,
    credit: line.debit,
    partyType: line.partyType,
    partyId: line.partyId,
    memo: line.memo,
  })

  const fingerprint = computeRequestFingerprint({
    event: 'REVERSAL@1',
    referenceType: 'reversal',
    referenceId: entryId,
    occurredAt: '',
    actorUserId,
    payload: { reason: trimmedReason },
  })

  const result = await runPostingPipeline({
    tx,
    clock,
    tenantId,
    actorUserId,
    event: original.event,
    referenceType: 'reversal',
    referenceId: entryId,
    occurredAt: original.occurredAt, // OPEN-period-only fake; see doc comment.
    idempotencyKey,
    fingerprint,
    reversalOf: entryId,
    reversalReason: trimmedReason,
    build: async () => ({
      postingRule: 'REVERSAL@1',
      series: 'RV',
      narration: `Reversal of ${original.entryNumber}: ${trimmedReason}`,
      reference: null,
      lines: (await findLinesByEntryId(tx, tenantId, entryId)).map(reverseLine),
    }),
    afterInsert: async (reversalEntry) => {
      await markJournalEntryReversed(
        tx,
        tenantId,
        entryId,
        reversalEntry.id,
        original.version,
        actorUserId,
      )
      return []
    },
  })
  return { outcome: result.outcome, entry: result.entry }
}

/*
 * A FAKE `ReceivablesPort`, in-memory, for `golden-posting-runner-m3.spec.ts`
 * ONLY. It exists to prove the RUNNER's own step-interpretation logic —
 * `golden-posting-runner.ts`'s new verb handlers and expectation checks —
 * against a well-defined double, exactly as `tests/reconciliation/
 * reconciler.ts` is proved against fixtures rather than a live ledger
 * (README: "nothing here imports a kernel... and it never will" is THAT
 * file's rule, not this one's — this fake DOES call the real kernel for
 * every GL-affecting operation, which is the whole point: the posting side
 * must be real, or the runner's assertions about entries/lines/trial
 * balance/customer ledger would be checking nothing).
 *
 * IT IS NOT modules/receivables, does not pretend to be, and MUST NEVER be
 * wired into posting-scenarios-m3.spec.ts (which probes for the REAL
 * module only). Its allocation bookkeeping (outstanding, LIVE/VOIDED,
 * draft proposals) is invented here, in memory, to the best reading of
 * docs/posting-rules/customer-receipt.md and docs/design/M3/modules.md —
 * it is this lane's best-effort MODEL of what the module must do, useful
 * for proving the runner drives that model correctly, and NOT evidence
 * that the real module — once it exists — behaves the same way.
 *
 * IMPLEMENTED_EVENTS is mutated here, at module load, to include
 * SALE_POSTED / CUSTOMER_PAYMENT_RECEIVED — the one place in this lane
 * that does that, and only for this fixture's own process. It is never
 * done to packages/accounting-kernel/src/events.ts itself (FORBIDDEN path)
 * and never survives past this test file's process.
 */
;(IMPLEMENTED_EVENTS as Set<FinancialEventName>).add('SALE_POSTED')
;(IMPLEMENTED_EVENTS as Set<FinancialEventName>).add('CUSTOMER_PAYMENT_RECEIVED')

type DocType = 'sales_invoice' | 'customer_receipt'
type DocStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'

interface Allocation {
  readonly invoiceRef: string
  amount: string
  status: 'PROPOSED' | 'LIVE' | 'VOIDED'
}

interface DocRecord {
  readonly type: DocType
  readonly customerId: string
  status: DocStatus
  number: string | null
  entryId: string | null
  entryNumber: string | null
  date: string
  amount: string // netAmount (invoice) or amount (receipt)
  method?: 'CASH' | 'BANK' | undefined
  rawPayload: Record<string, unknown>
  allocations: Allocation[] // invoice: allocations RECEIVED against it; receipt: allocations MADE by it
}

/*
 * The real `modules/receivables` will almost certainly throw its own error
 * type (as `modules/customers` throws `CustomerError`, not `PostingError`) —
 * `PostingErrorCode` is a closed kernel union that does not, and should not,
 * know module-level codes like `ALLOCATION_EXCEEDS_OUTSTANDING`. This cast
 * is this FAKE's business only: `checkRejection` (golden-posting-runner.ts)
 * checks `.code`/`.details`, which is all it needs, whatever the real
 * exception class turns out to be.
 */
function detail(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): PostingError {
  return new PostingError(code as PostingError['code'], message, details)
}

/** Golden files write `customer`/`invoice` (fixture refs); the kernel's rule payloads want `customerId`. */
function toKernelPayload(
  raw: Record<string, unknown>,
  customerId: string,
): Record<string, unknown> {
  const { customer: _customer, ...rest } = raw
  return { ...rest, customerId }
}

export function createFakeReceivablesPort(clockIso: string): ReceivablesPort {
  const clock = fixedClock(clockIso)
  const engine = createPostingEngine(clock)

  const docs = new Map<string, DocRecord>()
  let invSeq = 0
  let rctSeq = 0
  const nextNumber = (series: 'INV' | 'RCT'): string => {
    const n = series === 'INV' ? ++invSeq : ++rctSeq
    return `${series}-2027-${String(n).padStart(6, '0')}`
  }

  function requireDoc(ref: string, type?: DocType): DocRecord {
    const doc = docs.get(ref)
    if (!doc) throw new Error(`fake receivables port: unknown document "${ref}".`)
    if (type && doc.type !== type)
      throw new Error(`fake receivables port: "${ref}" is not a ${type}.`)
    return doc
  }

  /** netAmount minus LIVE allocations against it. */
  function outstandingOf(invoiceRef: string): Money {
    const inv = requireDoc(invoiceRef, 'sales_invoice')
    const live = inv.allocations
      .filter((a) => a.status === 'LIVE')
      .reduce((sum, a) => Money.add(sum, Money.from(a.amount)), Money.zero())
    return Money.subtract(Money.from(inv.amount), live)
  }

  async function doPostInvoice(
    input: Parameters<ReceivablesPort['postInvoice']>[0],
  ): Promise<DocumentPostResult> {
    return withTenant((tx) => doPostInvoiceOn(tx, input))
  }

  async function doPostInvoiceOn(
    tx: TenantTx,
    input: Parameters<ReceivablesPort['postInvoice']>[0],
  ): Promise<DocumentPostResult> {
    let doc = docs.get(input.documentRef)
    if (doc && doc.status !== 'DRAFT') {
      // Replay / SOURCE_ALREADY_POSTED handled by the kernel below via
      // source uniqueness — fall through to engine.post.
    }
    if (!doc) {
      doc = {
        type: 'sales_invoice',
        customerId: input.customerId,
        status: 'DRAFT',
        number: null,
        entryId: null,
        entryNumber: null,
        date: input.occurredAt,
        amount: (input.payload.netAmount as string) ?? '0.0000',
        rawPayload: input.payload,
        allocations: [],
      }
      docs.set(input.documentRef, doc)
    }

    if (doc.status === 'DRAFT') {
      /*
       * service-sale.md §4 row 7 / customer-receipt.md ruling R-2: an
       * inactive customer cannot be INVOICED (this check), but CAN still
       * be PAID (doPostReceipt below has no such check, deliberately).
       * Re-checked only on the FIRST post attempt, matching the kernel's
       * idempotency-first rule (a replay never re-runs business
       * validation).
       *
       * Reads `customers.status` on the SAME `tx` this post is running
       * on, not through the real `getCustomer` use case: that use case
       * opens its OWN `withTenant` (its own pooled connection), and this
       * harness pins the test pool to ONE connection
       * (financial-invariant-suite.spec.ts's own doc comment) — calling it
       * from inside an already-open transaction on that pool deadlocks.
       * Reading the row directly is still real data, on the SAME
       * transaction snapshot this post is about to write into.
       */
      const row = await tx
        .selectFrom('customers')
        .select('status')
        .where('id', '=', input.customerId)
        .executeTakeFirst()
      if (row && row.status !== 'ACTIVE') {
        throw detail('CUSTOMER_INACTIVE', `customer ${input.customerId} is not active.`, {
          customerId: input.customerId,
        })
      }
    }

    const result = await engine.post(
      {
        event: 'SALE_POSTED',
        referenceType: 'sales_invoice',
        referenceId: documentUuid(input.documentRef),
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        payload: toKernelPayload(input.payload, input.customerId),
      },
      tx,
    )
    doc.entryId = result.entry.id
    doc.entryNumber = result.entry.entryNumber
    if (doc.status === 'DRAFT') {
      doc.status = 'POSTED'
      doc.number = nextNumber('INV')
    }
    /*
     * P10's `invoiceLines` (Accounting seat ruling, 2026-09-29): the fake
     * port posts the payload's OWN `lines` verbatim (no server-side
     * recomputation — unlike the real module), so this is `rawPayload.lines`
     * itself, narrowed to the four fields `InvoiceLine` names. Good enough
     * to validate the runner's plumbing against golden-posting-runner-m3.
     * spec.ts; the real module's INDEPENDENT recomputation is what
     * receivables-real-port.ts's `postInvoice` proves.
     */
    const rawLines = (doc.rawPayload.lines as Record<string, unknown>[] | undefined) ?? []
    const lines = rawLines.map((line) => ({
      description: line.description as string,
      quantity: line.quantity as string,
      unitPrice: line.unitPrice as string,
      lineNet: line.lineNet as string,
    }))
    return {
      outcome: result.outcome,
      documentNumber: doc.number!,
      entryNumber: result.entry.entryNumber,
      entryId: result.entry.id,
      documentStatus: doc.status,
      lines,
    }
  }

  async function doPostReceipt(
    input: Parameters<ReceivablesPort['postReceipt']>[0],
  ): Promise<DocumentPostResult> {
    return withTenant((tx) => doPostReceiptOn(tx, input))
  }

  async function doPostReceiptOn(
    tx: TenantTx,
    input: Parameters<ReceivablesPort['postReceipt']>[0],
  ): Promise<DocumentPostResult> {
    let doc = docs.get(input.documentRef)
    const payload = input.payload
    const allocationsIn = (payload.allocations as { invoice: string; amount: string }[]) ?? []

    if (!doc) {
      doc = {
        type: 'customer_receipt',
        customerId: input.customerId,
        status: 'DRAFT',
        number: null,
        entryId: null,
        entryNumber: null,
        date: input.occurredAt,
        amount: (payload.amount as string) ?? '0.0000',
        method: payload.method as 'CASH' | 'BANK',
        rawPayload: payload,
        allocations: allocationsIn.map((a) => ({
          invoiceRef: a.invoice,
          amount: a.amount,
          status: 'PROPOSED',
        })),
      }
      docs.set(input.documentRef, doc)
    }

    if (doc.status !== 'DRAFT') {
      // Let the kernel's source-uniqueness decide (REPLAYED or SOURCE_ALREADY_POSTED).
    } else {
      // §3 rows 3-7, the module's own rules — checked BEFORE the kernel, exactly as
      // customer-receipt.md §3 states the kernel never sees allocation content.
      if (doc.allocations.length === 0) throw detail('RECEIPT_NO_ALLOCATION', 'no allocations.')
      const seen = new Set<string>()
      for (const a of doc.allocations) {
        if (seen.has(a.invoiceRef))
          throw detail('ALLOCATION_DUPLICATE_INVOICE', 'duplicate invoice.', {
            invoice: a.invoiceRef,
          })
        seen.add(a.invoiceRef)
        if (Money.compare(Money.from(a.amount), Money.zero()) <= 0) {
          throw detail('AMOUNT_NON_POSITIVE', 'allocation amount must be positive.')
        }
      }
      const total = doc.allocations.reduce(
        (s, a) => Money.add(s, Money.from(a.amount)),
        Money.zero(),
      )
      if (!Money.equals(total, Money.from(doc.amount))) {
        throw detail('RECEIPT_UNALLOCATED_AMOUNT', 'allocations do not sum to the amount.', {
          amount: doc.amount,
          allocatedTotal: Money.serialize(total, 4),
        })
      }
      for (const a of doc.allocations) {
        const inv = docs.get(a.invoiceRef)
        if (!inv || inv.type !== 'sales_invoice')
          throw detail('INVOICE_NOT_FOUND', 'unknown invoice.', { invoice: a.invoiceRef })
        if (inv.customerId !== doc.customerId)
          throw detail('ALLOCATION_PARTY_MISMATCH', 'different customer.', {
            invoice: a.invoiceRef,
          })
        if (inv.status !== 'POSTED')
          throw detail('INVOICE_NOT_OPEN', 'invoice is not open.', {
            invoice: a.invoiceRef,
            status: inv.status,
          })
        if (inv.date > doc.date)
          throw detail('ALLOCATION_INVOICE_AFTER_RECEIPT', 'invoice postdates the receipt.', {
            invoice: a.invoiceRef,
          })
        const outstanding = outstandingOf(a.invoiceRef)
        if (Money.compare(Money.from(a.amount), outstanding) > 0) {
          throw detail('ALLOCATION_EXCEEDS_OUTSTANDING', 'allocation exceeds outstanding.', {
            invoice: a.invoiceRef,
            outstanding: Money.serialize(outstanding, 4),
            requested: a.amount,
          })
        }
      }
    }

    const result = await engine.post(
      {
        event: 'CUSTOMER_PAYMENT_RECEIVED',
        referenceType: 'customer_receipt',
        referenceId: documentUuid(input.documentRef),
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        payload: toKernelPayload(payload, input.customerId),
      },
      tx,
    )
    doc.entryId = result.entry.id
    doc.entryNumber = result.entry.entryNumber
    if (doc.status === 'DRAFT') {
      doc.status = 'POSTED'
      doc.number = nextNumber('RCT')
      for (const a of doc.allocations) {
        a.status = 'LIVE'
        const inv = requireDoc(a.invoiceRef, 'sales_invoice')
        inv.allocations.push({ invoiceRef: input.documentRef, amount: a.amount, status: 'LIVE' })
      }
    }
    return {
      outcome: result.outcome,
      documentNumber: doc.number!,
      entryNumber: result.entry.entryNumber,
      entryId: result.entry.id,
      documentStatus: doc.status,
    }
  }

  const uuidByRef = new Map<string, string>()
  function documentUuid(ref: string): string {
    if (!uuidByRef.has(ref)) uuidByRef.set(ref, randomUUID())
    return uuidByRef.get(ref)!
  }

  return {
    postInvoice: doPostInvoice,
    postReceipt: doPostReceipt,

    async reverseDocument(input) {
      const doc = requireDoc(input.documentRef)
      if (doc.type === 'sales_invoice') {
        const liveReceipts = doc.allocations.filter((a) => a.status === 'LIVE')
        if (liveReceipts.length > 0) {
          throw detail('INVOICE_HAS_LIVE_ALLOCATIONS', 'invoice has live allocations.', {
            receipts: liveReceipts.map((a) => requireDoc(a.invoiceRef).number),
          })
        }
      }
      if (doc.status !== 'POSTED')
        throw detail('ALREADY_REVERSED', `document is ${doc.status}, not POSTED.`)
      const result = await withTenant((tx) =>
        fakeReverseForSource(tx, clock, doc.entryId!, input.reason, input.idempotencyKey),
      )
      if (result.outcome === 'POSTED') {
        doc.status = 'REVERSED'
        if (doc.type === 'customer_receipt') {
          for (const a of doc.allocations) {
            a.status = 'VOIDED'
            const inv = requireDoc(a.invoiceRef, 'sales_invoice')
            const backRef = inv.allocations.find(
              (x) => x.invoiceRef === input.documentRef && x.status === 'LIVE',
            )
            if (backRef) backRef.status = 'VOIDED'
          }
        }
      }
      return {
        outcome: result.outcome === 'REPLAYED' ? 'REPLAYED' : 'POSTED',
        documentNumber: doc.number!,
        entryNumber: result.entry.entryNumber,
        entryId: result.entry.id,
        documentStatus: doc.status,
      }
    },

    async saveDraft(input): Promise<DraftResult> {
      const fields = input.fields as Record<string, unknown>
      const allocationsIn =
        (fields.allocations as { invoice: string; amount: string }[] | undefined) ?? []
      const doc: DocRecord = {
        type: input.documentType,
        customerId: input.customerId,
        status: 'DRAFT',
        number: null,
        entryId: null,
        entryNumber: null,
        date: (fields.receiptDate ?? fields.invoiceDate) as string,
        amount: (fields.amount as string) ?? '0.0000',
        method: fields.method as 'CASH' | 'BANK' | undefined,
        rawPayload: fields,
        allocations: allocationsIn.map((a) => ({
          invoiceRef: a.invoice,
          amount: a.amount,
          status: 'PROPOSED',
        })),
      }
      docs.set(input.documentRef, doc)
      return {
        documentStatus: 'DRAFT',
        documentNumber: null,
        allocations: doc.allocations.map((a) => ({
          invoiceRef: a.invoiceRef,
          amount: a.amount,
          status: a.status,
        })),
      }
    },

    async editDraft(input): Promise<DraftResult> {
      const doc = requireDoc(input.documentRef)
      if (doc.status !== 'DRAFT')
        throw detail('RECEIPT_NOT_DRAFT', `document is ${doc.status}.`, { status: doc.status })
      const fields = input.fields as Record<string, unknown>
      if (fields.receiptDate) doc.date = fields.receiptDate as string
      if (fields.invoiceDate) doc.date = fields.invoiceDate as string
      return { documentStatus: 'DRAFT', documentNumber: null }
    },

    async cancelDraft(input): Promise<DraftResult> {
      const doc = requireDoc(input.documentRef)
      if (doc.status !== 'DRAFT')
        throw detail('RECEIPT_NOT_DRAFT', `document is ${doc.status}.`, { status: doc.status })
      doc.status = 'CANCELLED'
      return {
        documentStatus: 'CANCELLED',
        documentNumber: null,
        allocations: doc.allocations.map((a) => ({
          invoiceRef: a.invoiceRef,
          amount: a.amount,
          status: a.status,
        })),
      }
    },

    async invoiceOutstanding(ref) {
      return Money.serialize(outstandingOf(ref), 4)
    },

    async documentStatus(_type, ref) {
      return requireDoc(ref).status
    },

    async documentNumbersIssued(series) {
      return [...docs.values()]
        .filter((d) =>
          series === 'INV' ? d.type === 'sales_invoice' : d.type === 'customer_receipt',
        )
        .map((d) => d.number)
        .filter((n): n is string => n !== null)
        .sort()
    },
  }
}

/** Test-only escape hatch, used by the spec to look up an entry by id directly when needed. */
export async function debugEntry(tx: TenantTx, tenantId: string, entryId: string) {
  return findEntryById(tx, tenantId, entryId)
}
