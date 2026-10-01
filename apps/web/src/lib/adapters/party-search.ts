/*
 * Shared by the customer-search fields on /sales/voucher and /payments (New Receipt): both
 * show options as "Name (CODE)" and resolve a selection by matching the typed text against
 * that exact label.
 *
 * A real user who types a few characters gets a server search on that partial text, then picks
 * a suggestion — by the time the full "Name (CODE)" text exists in the input, the LAST partial
 * search already populated the matching option, so the exact-match check resolves immediately.
 * But a value that arrives as a single, complete "Name (CODE)" string in one go — paste,
 * autofill, or a test/automation tool filling the field — skips that incremental search
 * entirely. Searching the API with the FULL label (including " (CODE)") finds nothing: the
 * server matches `q` against a customer's name or code field, neither of which contains the
 * literal substring "Name (CODE)". Found by tests/e2e/m4-invoices.spec.ts failing to resolve a
 * customer it had just filled in one call.
 *
 * Stripping a trailing " (CODE)" before sending the search request fixes this: the API search
 * runs on the name, and the exact-match check (done by the caller, against the ORIGINAL,
 * unstripped text) still only resolves a selection that names a real, exact "Name (CODE)" pair.
 */
const TRAILING_CODE = / \([^()]+\)$/

export function searchTermFor(rawQuery: string): string {
  return rawQuery.replace(TRAILING_CODE, '').trim()
}
