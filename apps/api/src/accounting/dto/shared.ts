import { z } from 'zod'

/*
 * Shared boundary primitives for the accounting HTTP API.
 * docs/design/M2/api-contract.md.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const isoDateSchema = z
  .string({ invalid_type_error: 'must be a YYYY-MM-DD string' })
  .regex(ISO_DATE, 'must be a calendar date, YYYY-MM-DD')

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether `value` has the shape of a uuid. Used to reject a malformed path
 * parameter with a clean 404 (the entry/account "was not found") before it
 * ever reaches a `uuid`-typed database column, where PostgreSQL would raise
 * a type-cast error instead — the same answer the kernel already gives for
 * "unknown id" and "another tenant's id" (reversal.md §3 row 1,
 * journal-voucher.md §3 row 7): a malformed id must not be a THIRD, worse
 * answer (a 500).
 */
export function isUuidShaped(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/** `?limit=` query coercion: a string, defaulted and clamped, never trusted past `max`. */
export function limitSchema(defaultValue: number, max: number) {
  return z.coerce
    .number({ invalid_type_error: 'limit must be a number' })
    .int()
    .min(1)
    .max(max)
    .optional()
    .default(defaultValue)
}

/** A cursor is opaque to the client; only its transport shape (a bounded string) is checked here. */
export const cursorSchema = z.string().min(1).max(2000).optional()
