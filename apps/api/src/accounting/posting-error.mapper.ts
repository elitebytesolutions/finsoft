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

const STATUS_404: ReadonlySet<PostingErrorCode> = new Set(['ENTRY_NOT_FOUND'])

const STATUS_409: ReadonlySet<PostingErrorCode> = new Set([
  'PERIOD_CLOSED',
  'PERIOD_LOCKED',
  'IDEMPOTENCY_KEY_REUSED',
  'SOURCE_ALREADY_POSTED',
  'ALREADY_REVERSED',
  'REVERSAL_OF_REVERSAL',
  'REVERSAL_VIA_SOURCE_REQUIRED',
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
