/*
 * Error code -> HTTP status. docs/design/M3/api-contract.md §3 is the
 * reviewable surface; this table is its implementation, covering codes this
 * module raises itself (ReceivablesError), codes the KERNEL raises
 * (PostingError — VERSION_CONFLICT, PERIOD_CLOSED, CUSTOMER_INACTIVE via the
 * party pre-check, ACCOUNT_ROLE_*, …) and CustomerDirectoryError
 * (CUSTOMER_NOT_FOUND / CUSTOMER_INACTIVE). One table because api-contract.md
 * §3 is itself one table across all three sources.
 */

const STATUS_404 = new Set<string>([])

const STATUS_409 = new Set<string>([
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'INVOICE_NOT_DRAFT',
  'INVOICE_NOT_POSTED',
  'RECEIPT_NOT_DRAFT',
  'RECEIPT_NOT_POSTED',
  'SOURCE_ALREADY_POSTED',
  'ALREADY_REVERSED',
  'INVOICE_HAS_LIVE_ALLOCATIONS',
])

const STATUS_422 = new Set<string>([
  'CUSTOMER_NOT_FOUND', // in a request body (invoices/receipts): 422 per api-contract.md §3
  'INVOICE_NOT_FOUND', // in allocations[]: 422; on a path id it is 404 (controller decides which)
  'CUSTOMER_INACTIVE',
  'SALE_NO_LINES',
  'SALE_TOO_MANY_LINES',
  'SALE_LINE_NON_POSITIVE',
  'SALE_AMOUNT_MISMATCH',
  'RECEIPT_INCOMPLETE',
  'AMOUNT_NON_POSITIVE',
  'RECEIPT_NO_ALLOCATION',
  'ALLOCATION_DUPLICATE_INVOICE',
  'RECEIPT_UNALLOCATED_AMOUNT',
  'ALLOCATION_PARTY_MISMATCH',
  'INVOICE_NOT_OPEN',
  'ALLOCATION_INVOICE_AFTER_RECEIPT',
  'ALLOCATION_EXCEEDS_OUTSTANDING',
  'DATE_IN_FUTURE',
  'PERIOD_NOT_FOUND',
  'PERIOD_CLOSED',
  'PERIOD_LOCKED',
  'REVERSAL_REASON_REQUIRED',
  'ACCOUNT_ROLE_UNMAPPED',
  'ACCOUNT_ROLE_MISCONFIGURED',
])

const STATUS_400 = new Set<string>([
  'VALIDATION_FAILED',
  'AMOUNT_NOT_STRING',
  'AMOUNT_SCALE',
  'AMOUNT_OUT_OF_RANGE',
  'PAYLOAD_INVALID',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_INVALID',
])

const STATUS_503 = new Set<string>(['AUDIT_BUSY'])

/**
 * RECEIPT_NOT_FOUND is always 404 (R4-R8 — api-contract.md §3 has no 422
 * variant for it, because a receipt is never named in another document's
 * body the way an invoice can be in an allocation). CUSTOMER_NOT_FOUND and
 * INVOICE_NOT_FOUND vary by *where* the id came from; the controller passes
 * `fromPathId` to disambiguate — see statusForReceivablesErrorCode.
 */
export function statusForReceivablesErrorCode(code: string, fromPathId = false): number {
  if (code === 'RECEIPT_NOT_FOUND') return 404
  if (fromPathId && (code === 'CUSTOMER_NOT_FOUND' || code === 'INVOICE_NOT_FOUND')) return 404
  if (STATUS_404.has(code)) return 404
  if (STATUS_409.has(code)) return 409
  if (STATUS_422.has(code)) return 422
  if (STATUS_503.has(code)) return 503
  if (STATUS_400.has(code)) return 400
  // §3: "anything else, including a kernel RULE_NOT_ENABLED,
  // SALE_SETTLEMENT_NOT_ENABLED, ..., REVERSAL_VIA_SOURCE_REQUIRED or
  // REVERSAL_OF_REVERSAL reaching a module path" is INTERNAL — a bug, not a
  // user error. Unknown codes fall through to the same 500 default, never a
  // false "not found" and never a silent 400.
  return 500
}

export function receivablesErrorSlug(code: string): string {
  return code.toLowerCase()
}
