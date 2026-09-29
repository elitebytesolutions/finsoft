import { describe, expect, it } from 'vitest'
import { formatRunningBalance } from '@/lib/money/running-balance'

describe('formatRunningBalance', () => {
  it('shows a positive (debit) balance with the Dr suffix', () => {
    expect(formatRunningBalance('455000.0000')).toEqual({ amount: 'Rs 455,000.00', side: 'Dr' })
  })

  it('shows a negative (credit) balance, unsigned, with the Cr suffix', () => {
    expect(formatRunningBalance('-6000.0000')).toEqual({ amount: 'Rs 6,000.00', side: 'Cr' })
  })

  it('treats an exact zero balance as Dr, not Cr', () => {
    expect(formatRunningBalance('0.0000')).toEqual({ amount: 'Rs 0.00', side: 'Dr' })
  })
})
