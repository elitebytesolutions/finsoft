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

const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be a valid ISO 8601 date-time',
  })
  .transform((value) => new Date(value))

const uuid = z.string().uuid()

export const auditQuerySchema = z
  .object({
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    action: z.string().min(1).max(64).optional(),
    entityType: z.string().min(1).max(64).optional(),
    entityId: uuid.optional(),
    actor: uuid.optional(),
    /**
     * Opaque to the client: the seq of the last row on the previous page.
     * Shape-validated (digits only) so a malformed cursor is a 400, not a
     * confusing empty result or a database error.
     */
    cursor: z.string().regex(/^\d+$/, 'cursor must be a decimal string').optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  })

export type AuditQuery = z.infer<typeof auditQuerySchema>
