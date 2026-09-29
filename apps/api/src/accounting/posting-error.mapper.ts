import { HttpException } from '@nestjs/common'
import { PostingError, type PostingErrorCode } from '@finsoft/accounting-kernel'

/*
 * PostingErrorCode -> HTTP. docs/design/M2/api-contract.md §7 is the
 * reviewable surface; this file is its implementation and must not diverge
 * from it silently — a code added to packages/accounting-kernel/src/
 * errors.ts with no entry here falls through to STATUS_BY_CODE's default
 * (400), which is a safe default (never a 500, never a false "not found")
 * but should be reconciled with the contract doc rather than left implicit.
 *
 * KernelInvariantError is deliberately NOT handled here — see this file's
 * call sites: only `error instanceof PostingError` is passed to `mapPostingError`,
 * so a kernel defect keeps falling through to AllExceptionsFilter and
 * becomes an opaque 500, exactly as errors.ts's own header requires ("never
 * caught and never corrected").
 */

const STATUS_404: ReadonlySet<PostingErrorCode> = new Set([
  'ENTRY_NOT_FOUND',
  // M2-C, coa-standard.md §8.1: "the same error whether the id is unknown
  // or belongs to another tenant" — never 403, RLS makes the two
  // indistinguishable, so the API must too. NOT `ACCOUNT_NOT_FOUND`: that
  // code is ALSO raised by journal-voucher.ts for an unknown account named
  // inside a JV's body (accounting-api.spec.ts: 400, by design — a body
  // field, not a path parameter). accounts.controller.ts's PATCH handler
  // special-cases `ACCOUNT_NOT_FOUND` to 404 itself, for its own path-
  // parameter case only, rather than widening this shared, code-keyed map.
  'ACCOUNT_PARENT_NOT_FOUND',
])

const STATUS_409: ReadonlySet<PostingErrorCode> = new Set([
  'PERIOD_CLOSED',
  'PERIOD_LOCKED',
  'IDEMPOTENCY_KEY_REUSED',
  'SOURCE_ALREADY_POSTED',
  'ALREADY_REVERSED',
  'REVERSAL_OF_REVERSAL',
  'REVERSAL_VIA_SOURCE_REQUIRED',
  // M2-B Council ruling, 2026-09-29: period.md §4.1's ordering rules and
  // §4's reopen-only-when-closed rule are, like the codes above, "the
  // request is individually valid but conflicts with the current state of
  // something it names" — the period named is real, but out of order or
  // not in the state this transition requires.
  'PERIOD_CLOSE_OUT_OF_ORDER',
  'PERIOD_REOPEN_OUT_OF_ORDER',
  'PERIOD_LOCK_OUT_OF_ORDER',
  'PERIOD_NOT_CLOSED',
  // M2-C, coa-standard.md §8.9: the request is individually valid but
  // conflicts with the account's current state — already taken, protected,
  // has postings, or a stale version.
  'ACCOUNT_CODE_TAKEN',
  'ACCOUNT_NAME_TAKEN',
  'ACCOUNT_PROTECTED',
  'ACCOUNT_HAS_POSTINGS',
  'ACCOUNT_VERSION_CONFLICT',
])

const STATUS_403: ReadonlySet<PostingErrorCode> = new Set(['FORBIDDEN'])

function statusFor(code: PostingErrorCode): number {
  if (STATUS_404.has(code)) return 404
  if (STATUS_409.has(code)) return 409
  if (STATUS_403.has(code)) return 403
  return 400
}

/** `PAYLOAD_INVALID` -> `payload_invalid`, `JV_UNBALANCED` -> `jv_unbalanced`. */
function errorSlug(code: PostingErrorCode): string {
  return code.toLowerCase()
}

export function mapPostingError(error: PostingError): HttpException {
  const status = statusFor(error.code)
  return new HttpException(
    {
      statusCode: status,
      error: errorSlug(error.code),
      message: error.message,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    },
    status,
  )
}
