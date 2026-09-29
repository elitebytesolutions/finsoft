/*
 * Typed domain errors. CLAUDE.md: "domain errors are typed and carry the
 * facts a user needs." `code` is the stable machine-readable fact
 * (docs/design/M3/api-contract.md §3); `message` is for logs, never for
 * users — the UI owns the copy, keyed by `code` (modules.md §12).
 *
 * Every code here appears in api-contract.md §3, mapped to an HTTP status in
 * api/errors.ts. No code is invented that the contract does not already
 * name — where a transition (deactivating an already-inactive customer,
 * reactivating an already-active one) has no code in the contract, the use
 * case treats it as idempotent rather than raising one (see
 * application/deactivate-customer.ts's header).
 */

export type CustomerErrorCode =
  | 'VALIDATION_FAILED'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_INACTIVE'
  | 'CUSTOMER_HAS_BALANCE'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'LEDGER_RANGE_TOO_LARGE'

export class CustomerError extends Error {
  readonly code: CustomerErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: CustomerErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'CustomerError'
    this.code = code
    this.details = details
  }
}
