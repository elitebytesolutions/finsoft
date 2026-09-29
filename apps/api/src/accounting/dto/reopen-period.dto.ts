import { z } from 'zod'

/*
 * POST /api/periods/:id/reopen body. docs/design/M2/api-contract.md §6.
 *
 * Only structural, same discipline as reverse-journal-entry.dto.ts: the
 * kernel (periodEngine.reopen) is the authoritative check
 * (PERIOD_REOPEN_REASON_REQUIRED, periods.md §4.1).
 */
export const ReopenPeriodSchema = z
  .object({
    reason: z
      .string({ invalid_type_error: 'reason must be a string' })
      .trim()
      .min(1, 'reason must not be empty')
      .max(500, 'reason must be at most 500 characters'),
  })
  .strict()

export type ReopenPeriodDto = z.infer<typeof ReopenPeriodSchema>
