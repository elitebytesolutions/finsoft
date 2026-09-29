import { z } from 'zod'

/*
 * POST /api/journals body. docs/design/M2/api-contract.md §2.
 *
 * This schema validates only the ENVELOPE: occurredAt is a calendar-date
 * shape, narration/reference are strings of the right JS type, lines is a
 * non-empty array. It deliberately does NOT validate line content (exactly
 * one side per line, amount scale/sign, balance, account eligibility) -
 * docs/posting-rules/journal-voucher.md §3 rows 1-14 are the kernel's own
 * validation (validateJournalVoucherPayload / runPostingPipeline), and
 * letting the kernel see the raw payload is what makes its exact
 * PostingErrorCode (AMOUNT_SCALE, JV_ZERO_LINE, JV_UNBALANCED, ...) the
 * thing a caller actually sees, rather than a generic zod rejection that
 * loses the distinction. The kernel's own requireKnownKeys gives the same
 * "unknown key" rejection again one level down, inside `payload`.
 *
 * `.strict()` below is a REJECTION, not the silent-drop behaviour
 * ZodValidationPipe's own header describes for a non-strict schema - every
 * schema in apps/api/src/accounting/dto is `.strict()`, so an unrecognised
 * top-level key fails validation outright (400 validation_failed) rather
 * than being dropped and the request proceeding without it.
 *
 * Corrected per the Council review, 2026-09-29: an earlier version of this
 * comment cited "ADR-0004's 'an unknown key is a 400'". That ADR does not
 * say that - ADR-0004 is row-level security, and its §76 is specifically
 * about `tenant_id` never being honoured from a request body, not a general
 * unknown-key rule. The unknown-key-is-a-400 behaviour here is this
 * codebase's `.strict()` convention, not something any ADR requires.
 *
 * referenceType/referenceId are never part of this schema: the controller
 * sets referenceType = 'journal_voucher' and mints referenceId itself
 * (journal-voucher.md §2, "uuid generated server-side"). A client cannot
 * name either.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const JournalVoucherLineSchema = z
  .record(z.string(), z.unknown())
  .refine((line) => typeof line['accountId'] === 'string', {
    message: 'Each line needs an accountId.',
  })

export const PostJournalVoucherSchema = z
  .object({
    occurredAt: z
      .string({ invalid_type_error: 'occurredAt must be a YYYY-MM-DD string' })
      .regex(ISO_DATE, 'occurredAt must be a calendar date, YYYY-MM-DD'),
    narration: z.string({ invalid_type_error: 'narration must be a string' }),
    reference: z.string().max(100).nullish(),
    lines: z.array(JournalVoucherLineSchema).min(1, 'lines must be a non-empty array'),
  })
  .strict()

export type PostJournalVoucherDto = z.infer<typeof PostJournalVoucherSchema>
