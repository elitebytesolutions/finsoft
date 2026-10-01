import { describe, expect, it } from 'vitest'
import { adaptChartOfAccounts, formatBalance } from '@/lib/adapters/chart-of-accounts'
import type { AccountDto, TrialBalanceLine } from '@/lib/api/accounting-types'

function account(overrides: Partial<AccountDto>): AccountDto {
  return {
    id: 'a1',
    code: '1000',
    name: 'Assets',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    kind: 'HEADER',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentId: null,
    isActive: true,
    ...overrides,
  }
}

describe('adaptChartOfAccounts', () => {
  const accounts: AccountDto[] = [
    account({ id: 'a1000', code: '1000', name: 'Assets', kind: 'HEADER', parentId: null }),
    account({
      id: 'a1100',
      code: '1100',
      name: 'Current Assets',
      kind: 'HEADER',
      parentId: 'a1000',
    }),
    account({
      id: 'a1110',
      code: '1110',
      name: 'Cash in Hand',
      kind: 'POSTABLE',
      parentId: 'a1100',
    }),
    account({
      id: 'a1120',
      code: '1120',
      name: 'Bank — Current',
      kind: 'POSTABLE',
      parentId: 'a1100',
    }),
  ]

  it('reshapes accounts into the Master-like shape, computing real depth and parent code', () => {
    const { accounts: adapted } = adaptChartOfAccounts(accounts, [])
    const cash = adapted.find((a) => a.code === '1110')!
    expect(cash.level).toBe(3)
    expect(cash.parent).toBe('1100')
    expect(cash.kind).toBe('Postable')
    const header = adapted.find((a) => a.code === '1000')!
    expect(header.level).toBe(1)
    expect(header.parent).toBeNull()
    expect(header.kind).toBe('Header')
  })

  it('rollup() reads a leaf balance straight from the trial balance — never re-derives it', () => {
    const lines: TrialBalanceLine[] = [
      {
        accountId: 'a1110',
        code: '1110',
        name: 'Cash in Hand',
        type: 'ASSET',
        debit: '5000.0000',
        credit: '0.0000',
      },
    ]
    const { rollup } = adaptChartOfAccounts(accounts, lines)
    expect(rollup('1110')).toEqual({ amount: '5000.0000', side: 'Dr' })
  })

  it('rollup() on a header sums its descendants with Money, not JS +', () => {
    const lines: TrialBalanceLine[] = [
      {
        accountId: 'a1110',
        code: '1110',
        name: 'Cash in Hand',
        type: 'ASSET',
        debit: '1249.5',
        credit: '0.0000',
      },
      {
        accountId: 'a1120',
        code: '1120',
        name: 'Bank — Current',
        type: 'ASSET',
        debit: '8750.5',
        credit: '0.0000',
      },
    ]
    const { rollup } = adaptChartOfAccounts(accounts, lines)
    // 1249.5 + 8750.5 = 10000.0000 exactly — the float-addition trap
    // (voucher-totals.test.tsx carries the same case for the posting form).
    expect(rollup('1100')).toEqual({ amount: '10000.0000', side: 'Dr' })
    expect(rollup('1000')).toEqual({ amount: '10000.0000', side: 'Dr' })
  })

  it('rollup() nets opposite-sided descendants to a signed total, never just sums magnitudes', () => {
    const lines: TrialBalanceLine[] = [
      {
        accountId: 'a1110',
        code: '1110',
        name: 'Cash in Hand',
        type: 'ASSET',
        debit: '5000.0000',
        credit: '0.0000',
      },
      // Bank overdrawn — a credit balance on an asset account.
      {
        accountId: 'a1120',
        code: '1120',
        name: 'Bank — Current',
        type: 'ASSET',
        debit: '0.0000',
        credit: '2000.0000',
      },
    ]
    const { rollup } = adaptChartOfAccounts(accounts, lines)
    expect(rollup('1100')).toEqual({ amount: '3000.0000', side: 'Dr' })
  })

  it('rollup() returns null — never a fabricated "Rs 0.00" — for a code with no activity', () => {
    const { rollup } = adaptChartOfAccounts(accounts, [])
    expect(rollup('1110')).toBeNull()
    expect(rollup('1000')).toBeNull()
  })

  it('formatBalance renders null as an em dash, never as a zero amount', () => {
    expect(formatBalance(null)).toBe('—')
    expect(formatBalance({ amount: '5000.0000', side: 'Dr' })).toBe('Rs 5,000.00 Dr')
  })
})
