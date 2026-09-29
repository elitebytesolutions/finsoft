import { describe, expect, it } from 'vitest'
import { moneyFromString } from '@finsoft/ui'

/*
 * packages/ui has no test runner of its own yet, so this exercises its
 * exported `moneyFromString` from here — the one place in the repo that
 * already has vitest wired to `@finsoft/ui`. CLAUDE.md: "Money arrives as a
 * string. Keep it a string." — this is the formatter every M2-S screen uses
 * instead of `money(Number(apiValue))`.
 */

describe('moneyFromString', () => {
  it('formats a plain amount with thousands separators and 2dp', () => {
    expect(moneyFromString('455000.0000')).toBe('Rs 455,000.00')
  })

  it('formats a small amount with no grouping needed', () => {
    expect(moneyFromString('45.5')).toBe('Rs 45.50')
  })

  it('rounds the 4dp scale down to 2dp for presentation, half-up', () => {
    expect(moneyFromString('1249.5000')).toBe('Rs 1,249.50')
    expect(moneyFromString('1249.505')).toBe('Rs 1,249.51')
    expect(moneyFromString('1249.504')).toBe('Rs 1,249.50')
  })

  it('renders a negative amount (an overdrawn/credit balance) with a leading minus', () => {
    expect(moneyFromString('-6000.0000')).toBe('Rs -6,000.00')
  })

  it('renders exact zero as "Rs 0.00" by default', () => {
    expect(moneyFromString('0.0000')).toBe('Rs 0.00')
  })

  it('renders exact zero as an em dash when zeroAsDash is set (ledger/TB convention)', () => {
    expect(moneyFromString('0.0000', { zeroAsDash: true })).toBe('—')
    expect(moneyFromString('0', { zeroAsDash: true })).toBe('—')
  })

  it('does not treat a non-zero small amount as zero', () => {
    expect(moneyFromString('0.01', { zeroAsDash: true })).toBe('Rs 0.01')
  })

  it('rejects a malformed amount rather than silently coercing it', () => {
    expect(() => moneyFromString('not-a-number')).toThrow()
    expect(() => moneyFromString('1e3')).toThrow() // exponential notation — ADR-0011
  })
})
