/*
 * Typed domain errors. CLAUDE.md: "domain errors are typed and carry the
 * facts a user needs." Every code here appears in
 * docs/design/M3/api-contract.md §3, mapped to an HTTP status in
 * api/errors.ts. Codes the KERNEL raises (CUSTOMER_INACTIVE,
 * SALE_AMOUNT_MISMATCH, PERIOD_CLOSED, REVERSAL_VIA_SOURCE_REQUIRED, …) are
 * NOT redeclared here — they arrive as PostingError / CustomerDirectoryError
 * and are mapped straight through by api/errors.ts, exactly per
 * api-contract.md §3's table. This file holds only the errors the module
 * itself raises, before ever reaching the kernel.
 */

export type ReceivablesErrorCode =
  | 'VALIDATION_FAILED'
  | 'AMOUNT_NOT_STRING'
  | 'AMOUNT_SCALE'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'INVOICE_NOT_FOUND'
  | 'RECEIPT_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVOICE_NOT_DRAFT'
  | 'INVOICE_NOT_POSTED'
  | 'RECEIPT_NOT_DRAFT'
  | 'RECEIPT_NOT_POSTED'
  | 'SOURCE_ALREADY_POSTED'
  | 'ALREADY_REVERSED'
  | 'INVOICE_HAS_LIVE_ALLOCATIONS'
  | 'SALE_NO_LINES'
  | 'SALE_TOO_MANY_LINES'
  | 'SALE_LINE_NON_POSITIVE'
  | 'SALE_AMOUNT_MISMATCH'
  | 'RECEIPT_INCOMPLETE'
  | 'AMOUNT_NON_POSITIVE'
  | 'RECEIPT_NO_ALLOCATION'
  | 'ALLOCATION_DUPLICATE_INVOICE'
  | 'RECEIPT_UNALLOCATED_AMOUNT'
  | 'ALLOCATION_PARTY_MISMATCH'
  | 'INVOICE_NOT_OPEN'
  | 'ALLOCATION_INVOICE_AFTER_RECEIPT'
  | 'ALLOCATION_EXCEEDS_OUTSTANDING'
  | 'REVERSAL_REASON_REQUIRED'

export class ReceivablesError extends Error {
  readonly code: ReceivablesErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: ReceivablesErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'ReceivablesError'
    this.code = code
    this.details = details
  }
}
