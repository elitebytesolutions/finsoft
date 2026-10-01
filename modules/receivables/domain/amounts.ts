import { AmountError, Money, Quantity, UnitCost } from '@finsoft/validation'
import { ReceivablesError } from './errors.ts'

/*
 * Parse a decimal string at its kind's scale (Money 4dp, Quantity/UnitCost
 * 6dp — ADR-0011), translating `AmountError.reason` into the api-contract.md
 * §3 codes. Mirrors packages/accounting-kernel/src/rules/shared.ts's own
 * `parseAmountOfKind` — duplicated rather than imported: the kernel's rule
 * helpers are not part of its public index (kernel/index.ts's own header:
 * "the rule builders... [are] the only code in the system that writes
 * journal_entries").
 */

function translate(error: AmountError, field: string, value: string): never {
  switch (error.reason) {
    case 'SCALE':
      throw new ReceivablesError('AMOUNT_SCALE', error.message, { field, value })
    case 'RANGE':
      throw new ReceivablesError('AMOUNT_OUT_OF_RANGE', error.message, { field, value })
    case 'NOT_STRING':
      throw new ReceivablesError('AMOUNT_NOT_STRING', error.message, { field })
    default:
      throw new ReceivablesError('VALIDATION_FAILED', error.message, { field, value })
  }
}

export function parseMoney(value: string, field: string): Money {
  if (typeof value !== 'string') {
    throw new ReceivablesError('AMOUNT_NOT_STRING', `${field} must be a decimal string.`, { field })
  }
  try {
    return Money.from(value)
  } catch (error) {
    if (error instanceof AmountError) translate(error, field, value)
    throw error
  }
}

export function parseQuantity(value: string, field: string): Quantity {
  if (typeof value !== 'string') {
    throw new ReceivablesError('AMOUNT_NOT_STRING', `${field} must be a decimal string.`, { field })
  }
  try {
    return Quantity.from(value)
  } catch (error) {
    if (error instanceof AmountError) translate(error, field, value)
    throw error
  }
}

export function parseUnitCost(value: string, field: string): UnitCost {
  if (typeof value !== 'string') {
    throw new ReceivablesError('AMOUNT_NOT_STRING', `${field} must be a decimal string.`, { field })
  }
  try {
    return UnitCost.from(value)
  } catch (error) {
    if (error instanceof AmountError) translate(error, field, value)
    throw error
  }
}
