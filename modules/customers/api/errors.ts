import type { CustomerErrorCode } from '../domain/errors.ts'
import type { CustomerDirectoryErrorCode } from '../application/published.ts'

/*
 * CustomerErrorCode -> HTTP. docs/design/M3/api-contract.md §3 is the
 * reviewable surface; this table is its implementation. A code added to
 * domain/errors.ts with no entry here falls through to the 400 default —
 * never a 500, never a false "not found" — but should be reconciled with
 * the contract doc rather than left implicit (posting-error.mapper.ts's
 * own precedent, apps/api/src/accounting/).
 */

const STATUS_404: ReadonlySet<CustomerErrorCode | CustomerDirectoryErrorCode> = new Set([
  'CUSTOMER_NOT_FOUND',
])

const STATUS_409: ReadonlySet<CustomerErrorCode | CustomerDirectoryErrorCode> = new Set([
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'CUSTOMER_HAS_BALANCE',
])

const STATUS_422: ReadonlySet<CustomerErrorCode | CustomerDirectoryErrorCode> = new Set([
  'CUSTOMER_INACTIVE',
  'LEDGER_RANGE_TOO_LARGE',
])

export function statusForCustomerErrorCode(
  code: CustomerErrorCode | CustomerDirectoryErrorCode,
): number {
  if (STATUS_404.has(code)) return 404
  if (STATUS_409.has(code)) return 409
  if (STATUS_422.has(code)) return 422
  return 400
}

/** `VALIDATION_FAILED` -> `validation_failed`. */
export function customerErrorSlug(code: CustomerErrorCode | CustomerDirectoryErrorCode): string {
  return code.toLowerCase()
}
