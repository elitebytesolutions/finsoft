import { z } from 'zod'

/*
 * PATCH /api/accounts/:id body. docs/design/M2/api-contract.md §5,
 * docs/posting-rules/coa-standard.md §8.2.
 *
 * Only name/code/parentId/expectedVersion — "the request names only
 * editable fields ... any other field is rejected with PAYLOAD_INVALID,
 * never silently ignored" (§8.2). `.strict()` gives that rejection at the
 * HTTP boundary; the kernel's own validateUpdatePayload re-checks the same
 * shape for any caller that reaches it directly (tests, a future caller).
 *
 * At least one of name/code/parentId must be present — an edit that names
 * none of them is not a request to change anything, and the kernel's own
 * "changes nothing" short-circuit (§8.2) is for a payload that names a
 * field but repeats its current value, not for a payload naming none.
 */
export const UpdateAccountSchema = z
  .object({
    name: z
      .string({ invalid_type_error: 'name must be a string' })
      .min(1, 'name must not be empty')
      .max(200, 'name must be at most 200 characters')
      .optional(),
    code: z
      .string({ invalid_type_error: 'code must be a string' })
      .min(1, 'code must not be empty')
      .max(32, 'code must be at most 32 characters')
      .optional(),
    parentId: z
      .string({ invalid_type_error: 'parentId must be a string' })
      .min(1, 'parentId must not be empty')
      .optional(),
    expectedVersion: z
      .number({ invalid_type_error: 'expectedVersion must be a number' })
      .int('expectedVersion must be an integer')
      .min(0, 'expectedVersion must not be negative'),
  })
  .strict()
  .refine(
    (body) => body.name !== undefined || body.code !== undefined || body.parentId !== undefined,
    {
      message: 'at least one of name, code or parentId is required',
    },
  )

export type UpdateAccountDto = z.infer<typeof UpdateAccountSchema>
