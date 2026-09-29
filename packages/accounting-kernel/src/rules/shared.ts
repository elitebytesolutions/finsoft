import { AmountError, Money, Quantity, UnitCost } from '@finsoft/validation'
import { PostingError } from '../errors.ts'

/*
 * Payload-shape helpers shared by every rule (pipeline step 1). Each throws a
 * PostingError with the exact code its governing posting-rules document
 * names. No database access here: shape is checked before idempotency, so a
 * malformed request never reaches a query — in particular a malformed uuid
 * never reaches PostgreSQL, where a 22P02 would abort the caller's
 * transaction instead of producing a typed rejection.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PostingError('PAYLOAD_INVALID', `${field} must be an object.`, { field })
  }
  return value as Record<string, unknown>
}

/**
 * journal-voucher.md §3 row 1 ("no unknown keys"), service-sale.md §3 ("a tax
 * or discount key is a schema rejection, never an implicit zero"). An
 * unrecognised key is rejected, never ignored: ignoring `taxAmount` would
 * post a sale without the tax the caller believed it was posting.
 */
export function requireKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new PostingError(
      'PAYLOAD_INVALID',
      `${field} carries unknown key(s): ${unknown.join(', ')}.`,
      {
        field,
        unknownKeys: unknown,
      },
    )
  }
}

export function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PostingError('PAYLOAD_INVALID', `${field} must be an array.`, { field })
  }
  return value
}

export function requireOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new PostingError('PAYLOAD_INVALID', `${field} must be a string or absent.`, { field })
  }
  if (value.length > maxLength) {
    throw new PostingError('PAYLOAD_INVALID', `${field} exceeds ${maxLength} characters.`, {
      field,
      maxLength: String(maxLength),
    })
  }
  return value
}

export function requireNarration(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new PostingError('PAYLOAD_INVALID', 'narration must be a string.', { field: 'narration' })
  }
  if (value.trim().length === 0) {
    throw new PostingError('NARRATION_REQUIRED', 'narration must be non-empty after trimming.')
  }
  if (value.length > maxLength) {
    throw new PostingError('NARRATION_TOO_LONG', `narration exceeds ${maxLength} characters.`, {
      maxLength: String(maxLength),
    })
  }
  return value
}

type AmountKind = 'Money' | 'Quantity' | 'UnitCost'
const PARSERS = { Money: Money.from, Quantity: Quantity.from, UnitCost: UnitCost.from }

/**
 * Parse a decimal string at its kind's scale (Money 4 dp, Quantity and
 * UnitCost 6 dp — ADR-0011), mapping `AmountError.reason` to the rule codes.
 * Never coerces: a JSON number is AMOUNT_NOT_STRING (P03 step 7), excess
 * decimals are AMOUNT_SCALE and are never rounded on the way in (ADR-0014
 * `Money.from`), a value past numeric(19,s) is AMOUNT_OUT_OF_RANGE.
 */
function parseAmountOfKind<K extends AmountKind>(
  kind: K,
  value: unknown,
  field: string,
): ReturnType<(typeof PARSERS)[K]> {
  if (typeof value !== 'string') {
    throw new PostingError('AMOUNT_NOT_STRING', `${field} must be a decimal string.`, { field })
  }
  try {
    return PARSERS[kind](value) as ReturnType<(typeof PARSERS)[K]>
  } catch (error) {
    if (!(error instanceof AmountError)) throw error
    switch (error.reason) {
      case 'SCALE':
        throw new PostingError('AMOUNT_SCALE', error.message, { field, value })
      case 'RANGE':
        throw new PostingError('AMOUNT_OUT_OF_RANGE', error.message, { field, value })
      case 'NOT_STRING':
        throw new PostingError('AMOUNT_NOT_STRING', error.message, { field })
      default:
        throw new PostingError('PAYLOAD_INVALID', error.message, { field, value })
    }
  }
}

/**
 * A non-negative Money amount. Zero is returned, not rejected — whether zero
 * is an error, and under which code, is the rule's call (JV_ZERO_LINE,
 * AMOUNT_NON_POSITIVE).
 */
export function parseNonNegativeMoney(value: unknown, field: string): Money {
  const amount = parseAmountOfKind('Money', value, field)
  if (Money.isNegative(amount)) {
    throw new PostingError('AMOUNT_NEGATIVE', `${field} must not be negative.`, { field, value })
  }
  return amount
}

export function parsePositiveMoney(value: unknown, field: string): Money {
  const amount = parseNonNegativeMoney(value, field)
  if (Money.isZero(amount)) {
    throw new PostingError('AMOUNT_NON_POSITIVE', `${field} must be greater than zero.`, {
      field,
      value,
    })
  }
  return amount
}

export function parseQuantity(value: unknown, field: string): Quantity {
  return parseAmountOfKind('Quantity', value, field)
}

export function parseUnitCost(value: unknown, field: string): UnitCost {
  return parseAmountOfKind('UnitCost', value, field)
}
