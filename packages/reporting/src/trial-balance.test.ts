import { describe, expect, it } from 'vitest'
import { presentTrialBalanceRow } from './trial-balance.ts'

/*
 * Pure unit tests for the trial balance's sign-presentation rule
 * (docs/posting-rules/ledger-and-trial-balance.md §3): the column a balance
 * falls into follows the SIGN of debit-minus-credit, never the account's
 * own normal_balance side. No database, no I/O — the real-Postgres cases
 * (multi-account totals, reading from journal_lines) are covered by
 * reporting.integration.spec.ts.
 */

describe('presentTrialBalanceRow', () => {
  it('puts a positive net balance in the Debit column', () => {
    const row = presentTrialBalanceRow('1000.0000', '400.0000')
    expect(row.debit).toBe('600.0000')
    expect(row.credit).toBe('0.0000')
  })

  it('puts a negative net balance in the Credit column, regardless of account type', () => {
    // An ASSET account (normally Debit) that has gone net-credit — an
    // overdrawn bank, or in this case just more credits posted than debits.
    const row = presentTrialBalanceRow('400.0000', '1000.0000')
    expect(row.debit).toBe('0.0000')
    expect(row.credit).toBe('600.0000')
  })

  it('shows a zero net balance as 0.0000 on both sides', () => {
    const row = presentTrialBalanceRow('500.0000', '500.0000')
    expect(row.debit).toBe('0.0000')
    expect(row.credit).toBe('0.0000')
  })

  it('never rounds — the inputs are already at the ledger scale', () => {
    const row = presentTrialBalanceRow('123.4567', '100.0001')
    expect(row.debit).toBe('23.4566')
    expect(row.credit).toBe('0.0000')
  })
})
