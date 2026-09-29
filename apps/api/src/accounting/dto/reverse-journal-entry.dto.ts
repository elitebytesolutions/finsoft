import { z } from 'zod'

/*
 * POST /api/journals/:id/reverse body. docs/design/M2/api-contract.md §2.
 *
 * Only structural: non-empty after trim, bounded length. The kernel is the
 * authoritative check (reversal.md §3 row 5, REVERSAL_REASON_REQUIRED) —
 * this schema exists so a plainly-empty or absurdly long body 400s before a
 * database round trip, not to duplicate the kernel's own rejection message.
 */
export const ReverseJournalEntrySchema = z
  .object({
    reason: z
      .string({ invalid_type_error: 'reason must be a string' })
      .trim()
      .min(1, 'reason must not be empty')
      .max(500, 'reason must be at most 500 characters'),
  })
  .strict()

export type ReverseJournalEntryDto = z.infer<typeof ReverseJournalEntrySchema>
