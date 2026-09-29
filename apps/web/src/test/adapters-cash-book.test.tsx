import { describe, expect, it } from 'vitest'
import { buildCashEntryRequest } from '@/lib/adapters/cash-book'

describe('buildCashEntryRequest', () => {
  it('Cash In: debits the cash account, credits the chosen account', () => {
    const body = buildCashEntryRequest({
      kind: 'In',
      cashAccountId: 'cash-1',
      counterAccountId: 'sales-1',
      amount: '5000',
      date: '2026-09-29',
      party: 'Walk-in Customer',
      reference: 'INV-1042',
      notes: '',
    })
    expect(body.lines).toEqual([
      { accountId: 'cash-1', debit: '5000' },
      { accountId: 'sales-1', credit: '5000' },
    ])
    expect(body.occurredAt).toBe('2026-09-29')
    expect(body.reference).toBe('INV-1042')
    expect(body.narration).toContain('received')
    expect(body.narration).toContain('Walk-in Customer')
  })

  it('Cash Out: credits the cash account, debits the chosen account', () => {
    const body = buildCashEntryRequest({
      kind: 'Out',
      cashAccountId: 'cash-1',
      counterAccountId: 'expense-1',
      amount: '1200.50',
      date: '2026-09-29',
      party: '',
      reference: '',
      notes: 'Office supplies',
    })
    expect(body.lines).toEqual([
      { accountId: 'cash-1', credit: '1200.50' },
      { accountId: 'expense-1', debit: '1200.50' },
    ])
    expect(body.reference).toBeNull()
    expect(body.narration).toContain('paid')
    expect(body.narration).toContain('Office supplies')
  })

  it('never sends both debit and credit on the same line', () => {
    const body = buildCashEntryRequest({
      kind: 'In',
      cashAccountId: 'cash-1',
      counterAccountId: 'sales-1',
      amount: '100',
      date: '2026-09-29',
      party: '',
      reference: '',
      notes: '',
    })
    for (const line of body.lines) {
      const hasDebit = 'debit' in line
      const hasCredit = 'credit' in line
      expect(hasDebit).not.toBe(hasCredit)
    }
  })
})
