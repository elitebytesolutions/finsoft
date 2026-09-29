import { z } from 'zod'

/*
 * POST /api/accounts body. docs/design/M2/api-contract.md §5,
 * docs/posting-rules/coa-standard.md §8.1.
 *
 * Structural only — the kernel (chartOfAccounts.create) is the authoritative
 * check (parent existence/kind, code format/range, name/code uniqueness).
 * `.strict()`: an unknown key (an opening balance, a controlKind, ...) fails
 * validation here, before the kernel is ever reached.
 */
export const CreateAccountSchema = z
  .object({
    parentId: z
      .string({ invalid_type_error: 'parentId must be a string' })
      .min(1, 'parentId must not be empty'),
    name: z
      .string({ invalid_type_error: 'name must be a string' })
      .min(1, 'name must not be empty')
      .max(200, 'name must be at most 200 characters'),
    code: z
      .string({ invalid_type_error: 'code must be a string' })
      .min(1, 'code must not be empty')
      .max(32, 'code must be at most 32 characters'),
  })
  .strict()

export type CreateAccountDto = z.infer<typeof CreateAccountSchema>
