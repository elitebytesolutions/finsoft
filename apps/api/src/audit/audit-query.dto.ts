import { z } from 'zod'

/*
 * GET /api/audit's query schema. Validated at the boundary, per ARCHITECTURE
 * §2 — nothing from the client is trusted, including a cursor that LOOKS
 * like one of ours.
 *
 * Not in packages/validation: that package is for genuinely shared,
 * cross-module concerns (money, decimals). This is one endpoint's own DTO,
 * and it lives beside the controller it belongs to.
 */

/**
 * Bounded so an out-of-range value is a 400 from THIS schema, not a
 * PostgreSQL error surfacing as a 500 from a `timestamptz` that cannot
 * represent it, or a driver exception from a Date far enough outside range
 * to misbehave. 1970-2100 comfortably covers every realistic audit query;
 * nothing in this system predates 1970 or has a legitimate reason to ask
 * about the 22nd century.
 */
const MIN_DATE = new Date('1970-01-01T00:00:00.000Z')
const MAX_DATE = new Date('2100-01-01T00:00:00.000Z')

const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be a valid ISO 8601 date-time',
  })
  .transform((value) => new Date(value))
  .refine((value) => value >= MIN_DATE && value <= MAX_DATE, {
    message: `must be between ${MIN_DATE.toISOString()} and ${MAX_DATE.toISOString()}`,
  })

const uuid = z.string().uuid()

/** The largest value a PostgreSQL bigint (int8) — and therefore `audit_log.seq` — can hold. */
const INT8_MAX = 9223372036854775807n

/**
 * Opaque to the client: the seq of the last row on the previous page.
 * Bounded on BOTH shape and value: `^\d{1,19}$` alone still admits a
 * 19-digit string larger than int8 max (e.g. "9999999999999999999"), which
 * would otherwise reach `listAuditEvents`' `seq < $cursor` comparison as a
 * value PostgreSQL's bigint cannot represent — a database error surfacing
 * as a 500, not a 400 this schema should have caught.
 */
const CURSOR_SHAPE = /^\d{1,19}$/

const cursor = z
  .string()
  .regex(CURSOR_SHAPE, 'cursor must be a decimal string of at most 19 digits')
  .refine(
    (value) => {
      // Guarded rather than assumed: zod does not short-circuit a failed
      // .regex() before running a later .refine(), so a value that already
      // failed the shape check (and is therefore not guaranteed to be
      // digits-only) still reaches this callback. BigInt() on non-digit
      // input throws a native SyntaxError, which zod's safeParse does NOT
      // catch as a validation issue — it propagates as an unhandled
      // exception, past the pipe, into a flat 500. Measured: "cursor must
      // be a decimal string" was correctly reported for shape, but the
      // controller returned 500 because this refine still ran against
      // "not-a-number" and threw.
      if (!CURSOR_SHAPE.test(value)) return true
      return BigInt(value) <= INT8_MAX
    },
    { message: `cursor exceeds the maximum representable seq (${INT8_MAX})` },
  )

export const auditQuerySchema = z
  .object({
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    action: z.string().min(1).max(64).optional(),
    entityType: z.string().min(1).max(64).optional(),
    entityId: uuid.optional(),
    actor: uuid.optional(),
    cursor: cursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  })

export type AuditQuery = z.infer<typeof auditQuerySchema>
