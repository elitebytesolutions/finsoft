import { z } from 'zod'

/*
 * GET /api/accounts/suggest-code?parentId=. coa-standard.md §8.1 — advisory
 * only, re-validated at submit like any typed code.
 */
export const SuggestAccountCodeQuerySchema = z
  .object({
    parentId: z
      .string({ invalid_type_error: 'parentId must be a string' })
      .min(1, 'parentId must not be empty'),
  })
  .strict()

export type SuggestAccountCodeQueryDto = z.infer<typeof SuggestAccountCodeQuerySchema>
