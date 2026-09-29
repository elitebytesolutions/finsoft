import { Money, Quantity, Rounding, UnitCost } from '@finsoft/validation'
import { parseQuantity, parseUnitCost } from './amounts.ts'
import { ReceivablesError } from './errors.ts'

/*
 * The sales invoice entity and its line arithmetic. Pure TypeScript — no
 * NestJS, no ORM, no HTTP, no `@finsoft/database` (ADR-0028 statement 5).
 * Mirrors packages/accounting-kernel/src/rules/service-sale.ts's OWN
 * arithmetic exactly (§4 rows 5-6: "rows 5 and 6 are verification, not
 * computation" — the module computes with the SAME function the kernel
 * re-runs), so the printed invoice and the GL entry always carry identical
 * numbers (docs/posting-rules/service-sale.md §4, §6).
 */

const DESCRIPTION_MAX = 500
const NARRATION_MAX = 500
const MIN_LINES = 1
const MAX_LINES = 200

export interface InvoiceLineInput {
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
}

export interface ComputedInvoiceLine {
  readonly lineNo: number
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
  readonly lineNet: string
}

export interface InvoiceCalculationProblem {
  readonly code: 'SALE_LINE_NON_POSITIVE' | 'SALE_TOO_MANY_LINES'
  readonly lineNo: number | null
}

export interface InvoiceCalculation {
  readonly lines: readonly ComputedInvoiceLine[]
  readonly netAmount: string
}

export interface InvoicePreview extends InvoiceCalculation {
  readonly problems: readonly InvoiceCalculationProblem[]
}

function normalizeDescription(value: string, lineNo: number): string {
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > DESCRIPTION_MAX) {
    throw new ReceivablesError(
      'VALIDATION_FAILED',
      `line ${lineNo}'s description must be 1-${DESCRIPTION_MAX} characters after trimming.`,
      { path: `lines[${lineNo - 1}].description` },
    )
  }
  return trimmed
}

/** round_half_up(quantity × unitPrice, 4) — the ONE rounding boundary (service-sale.md §6). */
function lineNetOf(quantity: Quantity, unitPrice: UnitCost): Money {
  return Money.round(Money.multiply(quantity, unitPrice), 4, Rounding.HALF_UP)
}

/**
 * I6 / `PreviewInvoice`: never throws on a line-level problem — it collects
 * `problems` so the screen can show them inline while the user is still
 * typing (api-contract.md §4.2 `InvoiceCalculation`). `quantity`/`unitPrice`
 * are assumed already shaped as decimal strings at the right scale by the
 * zod schema (`quantitySchema`/`unitCostSchema`) ahead of this call — a
 * malformed string is `AMOUNT_NOT_STRING`/`AMOUNT_SCALE` at the boundary,
 * never a "problem".
 */
export function previewInvoiceLines(rawLines: readonly InvoiceLineInput[]): InvoicePreview {
  const problems: InvoiceCalculationProblem[] = []
  if (rawLines.length > MAX_LINES) {
    problems.push({ code: 'SALE_TOO_MANY_LINES', lineNo: null })
  }

  let total = Money.zero()
  const lines = rawLines.map((raw, index) => {
    const lineNo = index + 1
    const quantity = parseQuantity(raw.quantity, `lines[${index}].quantity`)
    const unitPrice = parseUnitCost(raw.unitPrice, `lines[${index}].unitPrice`)
    if (Quantity.isZero(quantity) || Quantity.isNegative(quantity) || UnitCost.isZero(unitPrice) ||
        UnitCost.isNegative(unitPrice)) {
      problems.push({ code: 'SALE_LINE_NON_POSITIVE', lineNo })
    }
    const lineNet = lineNetOf(quantity, unitPrice)
    total = Money.add(total, lineNet)
    return {
      lineNo,
      description: raw.description,
      quantity: Quantity.serialize(quantity, 6),
      unitPrice: UnitCost.serialize(unitPrice, 6),
      lineNet: Money.serialize(lineNet, 4),
    }
  })

  return { lines, netAmount: Money.serialize(total, 4), problems }
}

/**
 * The THROWING validator, shared by CreateInvoiceDraft/UpdateInvoiceDraft
 * (`requireAtLeastOne: false` — api-contract.md §4.2: "0-200 on a draft")
 * and PostInvoice, which reads the invoice's CURRENT lines from the
 * repository and re-validates them here (`requireAtLeastOne: true` —
 * "≥ 1 to post"). Every code matches service-sale.md §4 rows 3-6 /
 * §12 exactly.
 */
export function computeInvoiceLines(
  rawLines: readonly InvoiceLineInput[],
  options: { readonly requireAtLeastOne: boolean },
): InvoiceCalculation {
  if (rawLines.length === 0 && options.requireAtLeastOne) {
    throw new ReceivablesError('SALE_NO_LINES', 'An invoice needs at least one line.')
  }
  if (rawLines.length > MAX_LINES) {
    throw new ReceivablesError(
      'SALE_TOO_MANY_LINES',
      `An invoice may have at most ${MAX_LINES} lines.`,
    )
  }
  void MIN_LINES // documents the floor service-sale.md §4 row 3 names; enforced by requireAtLeastOne above.

  let total = Money.zero()
  const lines = rawLines.map((raw, index) => {
    const lineNo = index + 1
    const description = normalizeDescription(raw.description, lineNo)
    const quantity = parseQuantity(raw.quantity, `lines[${index}].quantity`)
    const unitPrice = parseUnitCost(raw.unitPrice, `lines[${index}].unitPrice`)
    if (Quantity.isZero(quantity) || Quantity.isNegative(quantity)) {
      throw new ReceivablesError(
        'SALE_LINE_NON_POSITIVE',
        `Line ${lineNo}'s quantity must be > 0.`,
        { lineNo },
      )
    }
    if (UnitCost.isZero(unitPrice) || UnitCost.isNegative(unitPrice)) {
      throw new ReceivablesError(
        'SALE_LINE_NON_POSITIVE',
        `Line ${lineNo}'s unitPrice must be > 0.`,
        { lineNo },
      )
    }
    const lineNet = lineNetOf(quantity, unitPrice)
    total = Money.add(total, lineNet)
    return {
      lineNo,
      description,
      quantity: Quantity.serialize(quantity, 6),
      unitPrice: UnitCost.serialize(unitPrice, 6),
      lineNet: Money.serialize(lineNet, 4),
    }
  })

  return { lines, netAmount: Money.serialize(total, 4) }
}

/**
 * SALE_POSTED's payload (service-sale.md §3), built by the DOMAIN from the
 * SAME `Money` arithmetic the kernel re-runs. The kernel verifies these
 * figures and never substitutes its own (§4 rows 5-6).
 */
export function buildSalePostedPayload(
  customerId: string,
  calculation: InvoiceCalculation,
): {
  readonly settlement: 'CREDIT'
  readonly customerId: string
  readonly lines: readonly {
    readonly kind: 'SERVICE'
    readonly description: string
    readonly quantity: string
    readonly unitPrice: string
    readonly lineNet: string
  }[]
  readonly netAmount: string
} {
  return {
    settlement: 'CREDIT',
    customerId,
    lines: calculation.lines.map((line) => ({
      kind: 'SERVICE' as const,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineNet: line.lineNet,
    })),
    netAmount: calculation.netAmount,
  }
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

export type InvoiceStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'
export type InvoiceSettlement = 'OPEN' | 'PARTIALLY_PAID' | 'PAID'

export interface InvoiceRow {
  readonly id: string
  readonly customerId: string
  readonly status: InvoiceStatus
  readonly number: string | null
  readonly invoiceDate: string
  readonly dueDate: string | null
  readonly narration: string | null
  readonly netAmount: string
  readonly linesRevision: number
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

/** Settlement is derived, never stored (modules.md §5). */
export function deriveSettlement(netAmount: string, outstanding: string): InvoiceSettlement {
  if (Money.isZero(Money.from(outstanding))) return 'PAID'
  if (Money.equals(Money.from(outstanding), Money.from(netAmount))) return 'OPEN'
  return 'PARTIALLY_PAID'
}

/** A thin, immutable wrapper over a persisted row — status/version rules only. */
export class Invoice {
  readonly id: string
  readonly customerId: string
  readonly status: InvoiceStatus
  readonly number: string | null
  readonly invoiceDate: string
  readonly dueDate: string | null
  readonly narration: string | null
  readonly netAmount: string
  readonly linesRevision: number
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

  private constructor(row: InvoiceRow) {
    this.id = row.id
    this.customerId = row.customerId
    this.status = row.status
    this.number = row.number
    this.invoiceDate = row.invoiceDate
    this.dueDate = row.dueDate
    this.narration = row.narration
    this.netAmount = row.netAmount
    this.linesRevision = row.linesRevision
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

  static fromRow(row: InvoiceRow): Invoice {
    return new Invoice(row)
  }

  /** api-contract.md §1: checked ahead of every more specific rule. */
  assertVersion(expected: number): void {
    if (this.version !== expected) {
      throw new ReceivablesError(
        'VERSION_CONFLICT',
        `invoice ${this.id} is at version ${this.version}, not ${expected}.`,
        { currentVersion: this.version },
      )
    }
  }

  /** I4/I5: edit or cancel a draft. */
  assertDraft(): void {
    if (this.status !== 'DRAFT') {
      throw new ReceivablesError(
        'INVOICE_NOT_DRAFT',
        `invoice ${this.id} is ${this.status}, not DRAFT.`,
        { status: this.status },
      )
    }
  }

  /** I8: reverse. */
  assertPosted(): void {
    if (this.status !== 'POSTED') {
      throw new ReceivablesError(
        'INVOICE_NOT_POSTED',
        `invoice ${this.id} is ${this.status}, not POSTED.`,
        { status: this.status },
      )
    }
  }
}
