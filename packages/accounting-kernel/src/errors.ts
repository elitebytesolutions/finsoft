/*
 * Typed domain errors. Every code below is a stable identifier quoted
 * verbatim from a posting-rules document's own "Errors" section, or from
 * ADR-0026 statement 6 (PARTY_*) — this file introduces none of its own.
 * CLAUDE.md: "domain errors are typed and carry the facts a user needs."
 */

export type PostingErrorCode =
  // Shape, docs/posting-rules/journal-voucher.md §3, service-sale.md §4,
  // customer-receipt.md §3
  | 'PAYLOAD_INVALID'
  | 'AMOUNT_NOT_STRING'
  | 'AMOUNT_SCALE'
  | 'AMOUNT_NEGATIVE'
  | 'AMOUNT_NON_POSITIVE'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'NARRATION_REQUIRED'
  | 'NARRATION_TOO_LONG'
  // journal-voucher.md §3
  | 'JV_TOO_FEW_LINES'
  | 'JV_TOO_MANY_LINES'
  | 'JV_LINE_BOTH_SIDES'
  | 'JV_LINE_NO_SIDE'
  | 'JV_ZERO_LINE'
  | 'JV_SAME_ACCOUNT_BOTH_SIDES'
  | 'JV_UNBALANCED'
  // coa-standard.md §3/§4, journal-voucher.md §3
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NOT_POSTABLE'
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_CONTROL_MANUAL_FORBIDDEN'
  | 'ACCOUNT_RESTRICTED'
  | 'ACCOUNT_ROLE_UNMAPPED'
  | 'ACCOUNT_ROLE_MISCONFIGURED'
  // ADR-0026 statement 6: the posting engine pre-checks every party a line
  // names; the composite FK to `parties` is the backstop.
  | 'PARTY_NOT_FOUND'
  | 'PARTY_TYPE_MISMATCH'
  // periods.md §5/§9
  | 'DATE_IN_FUTURE'
  | 'PERIOD_NOT_FOUND'
  | 'PERIOD_CLOSED'
  | 'PERIOD_LOCKED'
  | 'PERIOD_CLOSE_OUT_OF_ORDER'
  | 'PERIOD_REOPEN_OUT_OF_ORDER'
  | 'PERIOD_LOCK_OUT_OF_ORDER'
  | 'PERIOD_NOT_CLOSED'
  | 'PERIOD_REOPEN_REASON_REQUIRED'
  // README §4, journal-voucher.md §7
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'SOURCE_ALREADY_POSTED'
  // reversal.md §11
  | 'ENTRY_NOT_FOUND'
  | 'ALREADY_REVERSED'
  | 'REVERSAL_OF_REVERSAL'
  | 'REVERSAL_VIA_SOURCE_REQUIRED'
  | 'REVERSAL_REASON_REQUIRED'
  | 'FORBIDDEN'
  // README §1: an event or variant whose rule is not IMPLEMENTED
  | 'RULE_NOT_ENABLED'
  // service-sale.md §12
  | 'SALE_SETTLEMENT_NOT_ENABLED'
  | 'SALE_NO_LINES'
  | 'SALE_TOO_MANY_LINES'
  | 'SALE_LINE_KIND_NOT_ENABLED'
  | 'SALE_LINE_NON_POSITIVE'
  | 'SALE_AMOUNT_MISMATCH'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_INACTIVE'
  | 'INVOICE_HAS_LIVE_ALLOCATIONS'
  // customer-receipt.md §11
  | 'RECEIPT_NO_ALLOCATION'
  | 'ALLOCATION_DUPLICATE_INVOICE'
  | 'RECEIPT_UNALLOCATED_AMOUNT'
  | 'INVOICE_NOT_FOUND'
  | 'ALLOCATION_PARTY_MISMATCH'
  | 'INVOICE_NOT_OPEN'
  | 'ALLOCATION_INVOICE_AFTER_RECEIPT'
  | 'ALLOCATION_EXCEEDS_OUTSTANDING'
  // coa-standard.md §8.9 — chart of accounts create/edit (M2-C). Evaluation
  // order: permission, payload shape, account found and not protected
  // (edit), version (edit), parent, code format, code range, has-postings
  // (edit of code/parent), code and name uniqueness.
  | 'ACCOUNT_PARENT_NOT_FOUND'
  | 'ACCOUNT_PARENT_NOT_HEADER'
  | 'ACCOUNT_PARENT_TYPE_MISMATCH'
  | 'ACCOUNT_CODE_FORMAT'
  | 'ACCOUNT_CODE_OUT_OF_RANGE'
  | 'ACCOUNT_CODE_TAKEN'
  | 'ACCOUNT_NAME_INVALID'
  | 'ACCOUNT_NAME_TAKEN'
  | 'ACCOUNT_PROTECTED'
  | 'ACCOUNT_HAS_POSTINGS'
  | 'ACCOUNT_VERSION_CONFLICT'

/**
 * The one error type every posting-rule rejection and every reversal
 * rejection throws. `details` carries the facts a user needs — "available
 * 12, requested 20" in spirit — never a bare message alone.
 */
export class PostingError extends Error {
  readonly code: PostingErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: PostingErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PostingError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

/**
 * A kernel invariant was found broken: a condition that no valid input can
 * produce (a rule built an unbalanced entry, a line with no side, a conflict
 * on a constraint the kernel never races). Deliberately NOT a PostingError:
 * it is not a user's mistake to be shown and corrected, it is a defect to be
 * reported. It is never caught and never "corrected" — the caller's
 * transaction rolls back and nothing is posted (Accounting Guardian absolute
 * stop: an imbalance is reported, never auto-corrected).
 */
export class KernelInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KernelInvariantError'
  }
}
