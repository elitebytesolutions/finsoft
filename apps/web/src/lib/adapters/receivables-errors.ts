/*
 * Shared error-code -> end-user copy for the invoice and receipt screens (M4-W2). Codes come
 * from modules/receivables/api/errors.ts; `ApiError.serverCode` is already
 * `receivablesErrorSlug(code)` (= `code.toLowerCase()`), set in lib/api/client.ts's non-2xx
 * handling. Anything not explicitly named here falls back to the server's own message
 * (CLAUDE.md: "the server's rejection is the truth; render it" — never swallowed).
 */
import { ApiError } from '@/lib/api/types'

export function receivablesErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again.'
  switch (err.serverCode) {
    case 'customer_inactive':
      return 'This customer is inactive. Reactivate the customer first.'
    case 'allocation_exceeds_outstanding':
      return 'This allocation is more than the invoice still owes. Reduce the amount.'
    case 'invoice_has_live_allocations':
      return 'This invoice has live receipt allocations. Reverse the receipt first, then reverse the invoice.'
    case 'period_closed':
      return 'The fiscal period for this date is closed. Choose a date in an open period, or ask for the period to be reopened.'
    case 'period_locked':
      return 'The fiscal period for this date is locked.'
    case 'version_conflict':
      return 'This record changed since you opened it. Reload the page and try again.'
    case 'receipt_unallocated_amount':
      return 'The full amount must be allocated across invoices before posting.'
    case 'receipt_no_allocation':
      return 'Allocate at least one invoice before posting.'
    case 'receipt_incomplete':
      return 'Enter a method and amount before continuing.'
    case 'allocation_invoice_after_receipt':
      return 'One of the selected invoices was raised after the receipt date and cannot be allocated.'
    case 'allocation_duplicate_invoice':
      return 'The same invoice cannot be allocated twice.'
    case 'allocation_party_mismatch':
      return 'Every allocated invoice must belong to this customer.'
    case 'invoice_not_open':
      return 'This invoice is no longer open for allocation.'
    case 'invoice_not_draft':
      return 'This invoice is no longer a draft.'
    case 'invoice_not_posted':
      return 'Only a posted invoice can be reversed.'
    case 'receipt_not_draft':
      return 'This receipt is no longer a draft.'
    case 'receipt_not_posted':
      return 'Only a posted receipt can be reversed.'
    case 'already_reversed':
      return 'This has already been reversed.'
    case 'sale_no_lines':
      return 'Add at least one line before saving.'
    case 'sale_too_many_lines':
      return 'This invoice has too many lines. Split it into more than one invoice.'
    case 'sale_line_non_positive':
      return 'Quantity and rate must be greater than zero on every line.'
    case 'sale_amount_mismatch':
      return 'The totals changed since you last checked. Recalculate and try again.'
    case 'amount_non_positive':
      return 'The amount must be greater than zero.'
    case 'date_in_future':
      return 'The date cannot be in the future.'
    case 'reversal_reason_required':
      return 'A reason is required.'
    case 'customer_not_found':
      return 'This customer could not be found.'
    case 'invoice_not_found':
      return 'This invoice could not be found.'
    default:
      return err.message
  }
}
