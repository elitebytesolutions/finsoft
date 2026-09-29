import { z } from 'zod'
import { cursorSchema, isoDateSchema, limitSchema } from './shared'

/** GET /api/journals. docs/design/M2/api-contract.md §2. */
export const JournalListQuerySchema = z
  .object({
    status: z.enum(['POSTED', 'REVERSED']).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    limit: limitSchema(50, 200),
    cursor: cursorSchema,
  })
  .strict()

export type JournalListQueryDto = z.infer<typeof JournalListQuerySchema>
