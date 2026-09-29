/*
 * The one ledger-specific money display rule that isn't a plain amount:
 * a running balance is stored debit-positive (docs/posting-rules/
 * ledger-and-trial-balance.md §2 — "running balance is computed
 * debit-positive; displayed as an amount with Dr or Cr. The account's normal
 * balance does not change the arithmetic") and crosses the wire as a signed
 * string (docs/design/M2/api-contract.md §3 — "a credit balance is a
 * negative string, e.g. "-6000.0000""). Every ledger-shaped screen (Account
 * Ledger, Cash Book, Account Detail) needs the same split into an absolute
 * amount plus a Dr/Cr suffix, so it lives here once rather than per screen.
 */
import { Money } from '@finsoft/validation'
import { moneyFromString } from '@finsoft/ui'

export interface RunningBalanceDisplay {
  /** Formatted absolute amount, e.g. "Rs 6,000.00" — never signed. */
  amount: string
  /** "Dr" for a debit (non-negative) balance, "Cr" for a credit (negative) one. */
  side: 'Dr' | 'Cr'
}

export function formatRunningBalance(value: string): RunningBalanceDisplay {
  const parsed = Money.from(value)
  const side: 'Dr' | 'Cr' = Money.isNegative(parsed) ? 'Cr' : 'Dr'
  const absolute = Money.abs(parsed)
  return { amount: moneyFromString(Money.serialize(absolute, 4)), side }
}
