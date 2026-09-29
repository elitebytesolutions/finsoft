import { describe, expect, it } from 'vitest'
import { computeVoucherTotals } from '@/lib/accounting/voucher-totals'

/*
 * voucher-new/README.md §6: totals are computed with @finsoft/validation's
 * Money, never JS number arithmetic — these cases exist specifically because
 * float arithmetic gets them wrong (P02's fractional-amount voucher in
 * journal-voucher.md is the same shape of case).
 */
describe('computeVoucherTotals', () => {
  it('balances an even two-line voucher', () => {
    const t = computeVoucherTotals([{ debit: '50000' }, { credit: '50000' }])
    expect(t.totalDebit).toBe('50000.0000')
    expect(t.totalCredit).toBe('50000.0000')
    expect(t.difference).toBe('0.0000')
    expect(t.balanced).toBe(true)
  })

  it('sums fractional amounts exactly — the float-arithmetic trap', () => {
    // 45000 + 1249.5 + 8750.5 = 55000.0000 exactly. Float addition of these
    // three in JS `number` arithmetic is fine here, but the point is that
    // this module never does that addition — it goes through Money.sum.
    const t = computeVoucherTotals([
      { debit: '45000' },
      { debit: '1249.5' },
      { debit: '8750.5' },
      { credit: '55000' },
    ])
    expect(t.totalDebit).toBe('55000.0000')
    expect(t.totalCredit).toBe('55000.0000')
    expect(t.balanced).toBe(true)
  })

  it('reports an exact difference when unbalanced', () => {
    const t = computeVoucherTotals([{ debit: '100.1234' }, { credit: '100' }])
    expect(t.difference).toBe('0.1234')
    expect(t.balanced).toBe(false)
  })

  it('treats a blank or half-typed cell as zero, not an error', () => {
    const t = computeVoucherTotals([{ debit: '' }, { debit: '-' }, { credit: undefined }])
    expect(t.totalDebit).toBe('0.0000')
    expect(t.totalCredit).toBe('0.0000')
    expect(t.balanced).toBe(false) // zero is never "balanced" — nothing to post
  })

  it('is not balanced when both sides are zero', () => {
    const t = computeVoucherTotals([{ debit: '0' }, { credit: '0' }])
    expect(t.balanced).toBe(false)
  })

  it('handles an empty line list', () => {
    const t = computeVoucherTotals([])
    expect(t.totalDebit).toBe('0.0000')
    expect(t.balanced).toBe(false)
  })
})
