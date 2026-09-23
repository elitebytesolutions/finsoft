import { z } from 'zod'
import { AmountError, Money, Percentage, Quantity, UnitCost } from './money.ts'

/*
 * Zod schemas for the boundary. ADR-0011: money arrives as a string in JSON
 * and is parsed exactly once, here or in Money.from — never by parseFloat,
 * never by Number(), never by an implicit cast.
 */

function amountSchema<T>(parse: (input: string) => T, label: string) {
  return z
    .string({ invalid_type_error: `${label} must be a decimal string, not a number` })
    .transform((input, ctx) => {
      try {
        return parse(input)
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof AmountError ? error.message : `Invalid ${label}`,
        })
        return z.NEVER
      }
    })
}

export const moneySchema = amountSchema(Money.from, 'amount')
export const unitCostSchema = amountSchema(UnitCost.from, 'unit cost')
export const quantitySchema = amountSchema(Quantity.from, 'quantity')
export const percentageSchema = amountSchema(Percentage.from, 'percentage')
