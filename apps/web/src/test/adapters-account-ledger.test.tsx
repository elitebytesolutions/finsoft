import { describe, expect, it } from 'vitest'
import { adaptLedgerLine, adaptLedgerPages } from '@/lib/adapters/account-ledger'
import type { LedgerLine, LedgerResponse } from '@/lib/api/accounting-types'

function line(overrides: Partial<LedgerLine>): LedgerLine {
  return {
    lineId: 'l1',
    entryId: 'e1',
    entryNumber: 'JV-2027-000001',
    entryStatus: 'POSTED',
    occurredAt: '2026-09-05',
    narration: 'Owner capital contribution',
    sourceType: 'journal_voucher',
    sourceId: 'e1',
    reversalOf: null,
    reversedBy: null,
    debit: '5000.0000',
    credit: '0.0000',
    runningBalance: '5000.0000',
    ...overrides,
  }
}

describe('adaptLedgerLine', () => {
  it('reads the running balance straight off the line — never re-derives it from debit/credit', () => {
    const row = adaptLedgerLine(line({ runningBalance: '-1500.0000' }))
    expect(row.runningAmount).toBe('Rs 1,500.00')
    expect(row.runningSide).toBe('Cr')
  })

  it('formats debit/credit as zero-as-dash strings, never numbers', () => {
    const row = adaptLedgerLine(line({ debit: '5000.0000', credit: '0.0000' }))
    expect(row.dr).toBe('Rs 5,000.00')
    expect(row.cr).toBe('—')
  })

  it('does not repeat the narration as the "toBy" sub-caption — no counter-account data exists at this line', () => {
    const row = adaptLedgerLine(line({}))
    expect(row.toBy).toBe('')
    expect(row.desc).toBe('Owner capital contribution')
  })

  it('flags a reversed line and a reversing line distinctly, without fabricating the other side', () => {
    expect(adaptLedgerLine(line({ entryStatus: 'REVERSED' })).toBy).toBe('Reversed')
    expect(adaptLedgerLine(line({ reversalOf: 'e0' })).toBy).toBe('Reverses an earlier entry')
  })
})

describe('adaptLedgerPages', () => {
  it('takes opening balance from the first page and closing from the last', () => {
    const first: LedgerResponse = {
      accountId: 'a1',
      code: '1110',
      name: 'Cash in Hand',
      type: 'ASSET',
      openingBalance: '1000.0000',
      closingBalance: '3000.0000',
      lines: [line({})],
      nextCursor: 'cursor-1',
    }
    const second: LedgerResponse = {
      ...first,
      openingBalance: '3000.0000',
      closingBalance: '6000.0000',
      lines: [line({ lineId: 'l2', runningBalance: '6000.0000' })],
      nextCursor: null,
    }
    const adapted = adaptLedgerPages([first, second])
    expect(adapted.opening).toEqual({ amount: 'Rs 1,000.00', side: 'Dr' })
    expect(adapted.closing).toEqual({ amount: 'Rs 6,000.00', side: 'Dr' })
    expect(adapted.count).toBe(2)
    expect(adapted.rows).toHaveLength(2)
  })
})
