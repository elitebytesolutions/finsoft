export const money = (n: number) => `Rs ${n.toLocaleString('en-PK')}`

/*
 * The real-API counterpart to `money` above — for a decimal STRING off the wire, never a
 * JS number. `money(Number(apiValue))` is exactly the float round-trip CLAUDE.md forbids
 * ("Money arrives as a string. Keep it a string. Never parseFloat it... never toFixed it
 * yourself"); this is the kit's one sanctioned way to turn that string into display text.
 *
 * `@finsoft/validation`'s `Money` does the parsing and the one, explicit, presentation-only
 * rounding boundary (ADR-0014, 01-foundations.md §1.3: "Presentation at 2 dp... rounds each
 * displayed figure half-up for display only"). A string `Money.from` refuses (not plain
 * decimal notation, wrong scale, out of range) throws `AmountError` — deliberately not
 * swallowed here: a malformed amount reaching this formatter is a server contract violation,
 * not a display nicety to paper over.
 */
import { Money } from '@finsoft/validation'

export interface MoneyFromStringOptions {
  /** Render an exact zero as an em dash (04-states / ledger & trial-balance convention)
   * instead of "Rs 0.00" — the caller decides per-column, since a KPI total still shows
   * "Rs 0.00" even when a ledger row's zero side should read as an em dash. */
  zeroAsDash?: boolean
}

const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g

export function moneyFromString(value: string, options: MoneyFromStringOptions = {}): string {
  const amount = Money.from(value)
  if (options.zeroAsDash && Money.isZero(amount)) return '—'

  const fixed = Money.serialize(amount, 2) // e.g. "1234.50" or "-1234.50" — never re-parsed
  const negative = fixed.startsWith('-')
  const unsigned = negative ? fixed.slice(1) : fixed
  const [wholePart = '0', fractionPart = '00'] = unsigned.split('.')
  const grouped = wholePart.replace(THOUSANDS, ',')
  return `Rs ${negative ? '-' : ''}${grouped}.${fractionPart}`
}

export const movementTone = (t: string): 'good' | 'info' | 'warn' | 'danger' | 'neutral' =>
  (
    ({
      Purchase: 'good',
      'Stock In': 'good',
      Sale: 'info',
      Gift: 'info',
      Count: 'info',
      Breakage: 'danger',
      Issue: 'danger',
      Transfer: 'warn',
      Adjustment: 'warn',
    }) as Record<string, 'good' | 'info' | 'warn' | 'danger' | 'neutral'>
  )[t] ?? 'neutral'
