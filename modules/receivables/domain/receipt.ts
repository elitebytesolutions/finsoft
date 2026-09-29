import { Money } from '@finsoft/validation'
import { parseMoney } from './amounts.ts'
import { ReceivablesError } from './errors.ts'

/*
 * The customer receipt entity and its allocation arithmetic. Pure
 * TypeScript — no NestJS, no ORM, no HTTP (ADR-0028 statement 5). Rules from
 * docs/posting-rules/customer-receipt.md §1.1, §3, §5.
 */

const REFERENCE_MAX = 100
const NARRATION_MAX = 500

export type ReceiptStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'
export type ReceiptMethod = 'CASH' | 'BANK'

export interface AllocationInput {
  readonly invoiceId: string
  readonly amount: string
}

export interface ReceiptRow {
  readonly id: string
  readonly customerId: string
  readonly status: ReceiptStatus
  readonly number: string | null
  readonly receiptDate: string
  readonly method: ReceiptMethod | null
  readonly amount: string | null
  readonly reference: string | null
  readonly narration: string | null
  readonly proposalsRevision: number
  readonly version: number
  readonly postedAt: string | null
  readonly postedBy: string | null
  readonly postIdempotencyKey: string | null
  readonly postFingerprint: string | null
  readonly reversedAt: string | null
  readonly reversedBy: string | null
  readonly reversalReason: string | null
  readonly reverseIdempotencyKey: string | null
  readonly reverseFingerprint: string | null
  readonly cancelledAt: string | null
  readonly cancelledBy: string | null
  readonly createdAt: string
  readonly createdBy: string
  readonly updatedAt: string
  readonly updatedBy: string
}

export function normalizeReference(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > REFERENCE_MAX) {
    throw new ReceivablesError(
      'VALIDATION_FAILED',
      `reference must be at most ${REFERENCE_MAX} characters.`,
      { path: 'reference' },
    )
  }
  return trimmed
}

export function normalizeNarration(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > NARRATION_MAX) {
    throw new ReceivablesError(
      'VALIDATION_FAILED',
      `narration must be at most ${NARRATION_MAX} characters.`,
      { path: 'narration' },
    )
  }
  return trimmed
}

/**
 * Shape-validates a draft's amount field (R3/R5), if present. Positivity is
 * checked here too (not deferred to post) because the migration's own CHECK
 * (`amount > 0` when not null) admits no other value even on a DRAFT row —
 * a zero or negative amount is never a meaningful placeholder to save.
 */
export function normalizeAmountShape(value: string | null): string | null {
  if (value === null) return null
  const amount = parseMoney(value, 'amount')
  if (Money.isZero(amount) || Money.isNegative(amount)) {
    throw new ReceivablesError('AMOUNT_NON_POSITIVE', 'amount must be > 0.', {})
  }
  return value
}

/** Every allocation amount is a positive Money string, at draft-save shape time. */
export function assertAllocationAmountsShapeValid(allocations: readonly AllocationInput[]): void {
  for (const allocation of allocations) {
    const amount = parseMoney(allocation.amount, `allocations[${allocation.invoiceId}].amount`)
    if (Money.isZero(amount) || Money.isNegative(amount)) {
      throw new ReceivablesError(
        'AMOUNT_NON_POSITIVE',
        `allocation to invoice ${allocation.invoiceId} must be > 0.`,
        { invoiceId: allocation.invoiceId },
      )
    }
  }
  const seen = new Set<string>()
  for (const allocation of allocations) {
    if (seen.has(allocation.invoiceId)) {
      throw new ReceivablesError(
        'ALLOCATION_DUPLICATE_INVOICE',
        `invoice ${allocation.invoiceId} is allocated more than once on this receipt.`,
        { invoiceId: allocation.invoiceId },
      )
    }
    seen.add(allocation.invoiceId)
  }
}

export interface CompleteReceipt {
  readonly method: ReceiptMethod
  readonly amount: string
  readonly allocations: readonly AllocationInput[]
}

/**
 * PostReceipt step 3 (customer-receipt.md §3 rows 1-4): method set, amount
 * > 0, ≥ 1 allocation, each allocation > 0, no invoice twice,
 * Σ allocations = amount EXACTLY. Draft completeness only — row 5 onward
 * (each invoice's own state) needs the invoices loaded under lock, so those
 * live in `assertAllocatable`, below.
 */
export function assertComplete(row: {
  readonly method: ReceiptMethod | null
  readonly amount: string | null
  readonly allocations: readonly AllocationInput[]
}): CompleteReceipt {
  const missing: string[] = []
  if (row.method === null) missing.push('method')
  if (row.amount === null) missing.push('amount')
  if (missing.length > 0) {
    throw new ReceivablesError(
      'RECEIPT_INCOMPLETE',
      `receipt is missing: ${missing.join(', ')}.`,
      { missing },
    )
  }
  const method = row.method as ReceiptMethod
  const amount = row.amount as string
  const amountValue = Money.from(amount)
  if (Money.isZero(amountValue) || Money.isNegative(amountValue)) {
    throw new ReceivablesError('AMOUNT_NON_POSITIVE', 'amount must be > 0.', {})
  }
  if (row.allocations.length === 0) {
    throw new ReceivablesError(
      'RECEIPT_NO_ALLOCATION',
      'A receipt must be allocated to at least one invoice.',
    )
  }
  assertAllocationAmountsShapeValid(row.allocations)

  const allocatedTotal = Money.sum(row.allocations.map((a) => Money.from(a.amount)))
  if (!Money.equals(allocatedTotal, amountValue)) {
    throw new ReceivablesError(
      'RECEIPT_UNALLOCATED_AMOUNT',
      `allocations sum to ${Money.serialize(allocatedTotal, 4)}, not the receipt amount ${amount}.`,
      { amount, allocatedTotal: Money.serialize(allocatedTotal, 4) },
    )
  }

  return { method, amount, allocations: row.allocations }
}

export interface AllocatableInvoice {
  readonly id: string
  readonly number: string
  readonly customerId: string
  readonly status: string
  readonly invoiceDate: string
  readonly outstanding: string
}

/**
 * PostReceipt step 6 (customer-receipt.md §3 rows 5-7): under the invoice
 * row locks, re-validated against the state AT POST — this is where a stale
 * draft proposal fails, naming the invoice, nothing partially applied.
 */
export function assertAllocatable(
  customerId: string,
  receiptDate: string,
  allocations: readonly AllocationInput[],
  invoices: ReadonlyMap<string, AllocatableInvoice>,
): void {
  for (const allocation of allocations) {
    const invoice = invoices.get(allocation.invoiceId)
    if (!invoice) {
      throw new ReceivablesError(
        'INVOICE_NOT_FOUND',
        `invoice ${allocation.invoiceId} was not found.`,
        { invoiceId: allocation.invoiceId },
      )
    }
    if (invoice.customerId !== customerId) {
      throw new ReceivablesError(
        'ALLOCATION_PARTY_MISMATCH',
        `invoice ${invoice.number} does not belong to this receipt's customer.`,
        { invoiceId: invoice.id, invoiceNumber: invoice.number },
      )
    }
    if (invoice.status !== 'POSTED') {
      throw new ReceivablesError(
        'INVOICE_NOT_OPEN',
        `invoice ${invoice.number} is ${invoice.status}, not POSTED.`,
        { invoiceId: invoice.id, invoiceNumber: invoice.number },
      )
    }
    if (invoice.invoiceDate > receiptDate) {
      throw new ReceivablesError(
        'ALLOCATION_INVOICE_AFTER_RECEIPT',
        `invoice ${invoice.number} is dated after this receipt.`,
        { invoiceId: invoice.id, invoiceNumber: invoice.number },
      )
    }
    const requested = Money.from(allocation.amount)
    const outstanding = Money.from(invoice.outstanding)
    if (Money.compare(requested, outstanding) > 0) {
      throw new ReceivablesError(
        'ALLOCATION_EXCEEDS_OUTSTANDING',
        `invoice ${invoice.number} has ${invoice.outstanding} outstanding; ${allocation.amount} was requested.`,
        {
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          outstanding: invoice.outstanding,
          requested: allocation.amount,
        },
      )
    }
  }
}

/** CUSTOMER_PAYMENT_RECEIVED's payload (customer-receipt.md §2). */
export function buildCustomerPaymentPayload(
  customerId: string,
  complete: CompleteReceipt,
): {
  readonly customerId: string
  readonly method: ReceiptMethod
  readonly amount: string
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: string }[]
} {
  return {
    customerId,
    method: complete.method,
    amount: complete.amount,
    allocations: complete.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
  }
}

export interface AllocationProblem {
  readonly code: string
  readonly invoiceId: string | null
  readonly details: Readonly<Record<string, unknown>> | null
}

/** R2: the SAME rules as assertAllocatable, collected as `problems` instead of thrown. */
export function previewAllocationProblems(
  customerId: string,
  receiptDate: string,
  allocations: readonly AllocationInput[],
  invoices: ReadonlyMap<string, AllocatableInvoice>,
): readonly AllocationProblem[] {
  const problems: AllocationProblem[] = []
  for (const allocation of allocations) {
    try {
      assertAllocatable(customerId, receiptDate, [allocation], invoices)
    } catch (error) {
      if (error instanceof ReceivablesError) {
        problems.push({ code: error.code, invoiceId: allocation.invoiceId, details: error.details })
      } else {
        throw error
      }
    }
  }
  return problems
}

/**
 * The oldest-first suggestion (customer-receipt.md's UI note; ledger order
 * matches api-contract.md §4.2's `open=true`). Never applied implicitly —
 * the server returns it, R6 accepts only what is submitted back (rule 19).
 */
export function suggestAllocations(
  openInvoicesOldestFirst: readonly AllocatableInvoice[],
  amount: string,
): { readonly allocations: readonly AllocationInput[]; readonly unallocated: string } {
  let remaining = Money.from(amount)
  const allocations: AllocationInput[] = []
  for (const invoice of openInvoicesOldestFirst) {
    if (Money.isZero(remaining)) break
    const outstanding = Money.from(invoice.outstanding)
    if (Money.isZero(outstanding) || Money.isNegative(outstanding)) continue
    const take = Money.compare(remaining, outstanding) <= 0 ? remaining : outstanding
    allocations.push({ invoiceId: invoice.id, amount: Money.serialize(take, 4) })
    remaining = Money.subtract(remaining, take)
  }
  return { allocations, unallocated: Money.serialize(remaining, 4) }
}

export function assertReasonValid(reason: string): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  if (trimmed.length === 0 || trimmed.length > 500) {
    throw new ReceivablesError(
      'REVERSAL_REASON_REQUIRED',
      'A reason is required: non-empty after trimming, at most 500 characters.',
    )
  }
  return trimmed
}

/** A thin, immutable wrapper over a persisted row — status/version rules only. */
export class Receipt {
  readonly id: string
  readonly customerId: string
  readonly status: ReceiptStatus
  readonly number: string | null
  readonly receiptDate: string
  readonly method: ReceiptMethod | null
  readonly amount: string | null
  readonly reference: string | null
  readonly narration: string | null
  readonly proposalsRevision: number
  readonly version: number
  readonly postedAt: string | null
  readonly postedBy: string | null
  readonly postIdempotencyKey: string | null
  readonly postFingerprint: string | null
  readonly reversedAt: string | null
  readonly reversedBy: string | null
  readonly reversalReason: string | null
  readonly reverseIdempotencyKey: string | null
  readonly reverseFingerprint: string | null
  readonly cancelledAt: string | null
  readonly cancelledBy: string | null
  readonly createdAt: string
  readonly createdBy: string
  readonly updatedAt: string
  readonly updatedBy: string

  private constructor(row: ReceiptRow) {
    this.id = row.id
    this.customerId = row.customerId
    this.status = row.status
    this.number = row.number
    this.receiptDate = row.receiptDate
    this.method = row.method
    this.amount = row.amount
    this.reference = row.reference
    this.narration = row.narration
    this.proposalsRevision = row.proposalsRevision
    this.version = row.version
    this.postedAt = row.postedAt
    this.postedBy = row.postedBy
    this.postIdempotencyKey = row.postIdempotencyKey
    this.postFingerprint = row.postFingerprint
    this.reversedAt = row.reversedAt
    this.reversedBy = row.reversedBy
    this.reversalReason = row.reversalReason
    this.reverseIdempotencyKey = row.reverseIdempotencyKey
    this.reverseFingerprint = row.reverseFingerprint
    this.cancelledAt = row.cancelledAt
    this.cancelledBy = row.cancelledBy
    this.createdAt = row.createdAt
    this.createdBy = row.createdBy
    this.updatedAt = row.updatedAt
    this.updatedBy = row.updatedBy
    Object.freeze(this)
  }

  static fromRow(row: ReceiptRow): Receipt {
    return new Receipt(row)
  }

  assertVersion(expected: number): void {
    if (this.version !== expected) {
      throw new ReceivablesError(
        'VERSION_CONFLICT',
        `receipt ${this.id} is at version ${this.version}, not ${expected}.`,
        { currentVersion: this.version },
      )
    }
  }

  assertDraft(): void {
    if (this.status !== 'DRAFT') {
      throw new ReceivablesError(
        'RECEIPT_NOT_DRAFT',
        `receipt ${this.id} is ${this.status}, not DRAFT.`,
        { status: this.status },
      )
    }
  }

  assertPosted(): void {
    if (this.status !== 'POSTED') {
      throw new ReceivablesError(
        'RECEIPT_NOT_POSTED',
        `receipt ${this.id} is ${this.status}, not POSTED.`,
        { status: this.status },
      )
    }
  }
}
