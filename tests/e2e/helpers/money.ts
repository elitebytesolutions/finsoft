/*
 * Money-string formatting for assertions only — never for computation (rule 19: the browser
 * computes no money, and neither does this test). The API returns 4dp decimal strings
 * ("10000.0000", ADR-0011/api-contract.md §1); every screen in this repo displays 2dp with
 * comma grouping ("Rs 75,000.00", m2-accounting.spec.ts). These helpers turn one into the
 * other so a test can assert "the screen shows 10,000.00" without hand-writing the comma in
 * five different places and risking a typo the brief's "assert exact money strings" would not
 * forgive.
 */

/** "10000.0000" | "10000" | 10000 -> "10,000.00" (2dp, comma-grouped, half-up already applied server-side). */
export function twoDp(amount: string | number): string {
  const n = typeof amount === 'string' ? Number(amount) : amount
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "10000.0000" -> "Rs 10,000.00", matching the JV confirm dialog's own convention. */
export function rs(amount: string | number): string {
  return `Rs ${twoDp(amount)}`
}
