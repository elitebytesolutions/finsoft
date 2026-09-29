import { z } from 'zod'
import { isoDateSchema } from './shared'

/** GET /api/reports/trial-balance. docs/design/M2/api-contract.md §4. */
export const TrialBalanceQuerySchema = z
  .object({
    asOf: isoDateSchema,
  })
  .strict()

export type TrialBalanceQueryDto = z.infer<typeof TrialBalanceQuerySchema>
