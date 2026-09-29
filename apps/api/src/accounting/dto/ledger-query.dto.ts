import { z } from 'zod'
import { cursorSchema, isoDateSchema, limitSchema, UUID_PATTERN } from './shared'

/** GET /api/ledgers/:accountId. docs/design/M2/api-contract.md §3. */
export const LedgerQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    limit: limitSchema(500, 500),
    cursor: cursorSchema,
    // Inert in M2 (§3): no IMPLEMENTED posting rule carries a party yet.
    // Accepted and validated as a shape now so the M2-S lane's contract
    // does not change when M3 makes it meaningful.
    partyId: z.string().regex(UUID_PATTERN, 'partyId must be a uuid').optional(),
  })
  .strict()

export type LedgerQueryDto = z.infer<typeof LedgerQuerySchema>
