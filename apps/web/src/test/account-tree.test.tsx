import { describe, expect, it } from 'vitest'
import {
  accountByCode,
  accountByRole,
  buildAccountTree,
  flattenAccountTree,
  postableAccounts,
  postableJournalAccounts,
} from '@/lib/accounting/account-tree'
import type { AccountDto } from '@/lib/api/accounting-types'

function account(
  overrides: Partial<AccountDto> & Pick<AccountDto, 'id' | 'code' | 'name'>,
): AccountDto {
  return {
    type: 'ASSET',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentId: null,
    isActive: true,
    ...overrides,
  }
}

const ASSETS = account({ id: '1000', code: '1000', name: 'Assets', kind: 'HEADER', parentId: null })
const CASH = account({
  id: '1110',
  code: '1110',
  name: 'Cash in Hand',
  parentId: '1000',
  role: 'CASH_DEFAULT',
})
const AR = account({
  id: '1200',
  code: '1200',
  name: 'Accounts Receivable',
  parentId: '1000',
  controlKind: 'AR',
})
const COGS = account({
  id: '5100',
  code: '5100',
  name: 'Cost of Goods Sold',
  parentId: null,
  restricted: true,
})
const INACTIVE = account({
  id: '9999',
  code: '9999',
  name: 'Old Account',
  parentId: '1000',
  isActive: false,
})

const ACCOUNTS = [ASSETS, CASH, AR, COGS, INACTIVE]

describe('buildAccountTree / flattenAccountTree', () => {
  it('nests children under their parent and roots at depth 1', () => {
    const tree = buildAccountTree(ACCOUNTS)
    const assetsNode = tree.find((n) => n.account.id === '1000')!
    expect(assetsNode.depth).toBe(1)
    expect(assetsNode.children.map((c) => c.account.id).sort()).toEqual(['1110', '1200', '9999'])
    expect(assetsNode.children[0].depth).toBe(2)
  })

  it('a header with no parent is a root; COGS (no parent here) is also a root', () => {
    const tree = buildAccountTree(ACCOUNTS)
    expect(tree.map((n) => n.account.id).sort()).toEqual(['1000', '5100'])
  })

  it('flattens back to every node, pre-order', () => {
    const tree = buildAccountTree(ACCOUNTS)
    const flat = flattenAccountTree(tree)
    expect(flat).toHaveLength(ACCOUNTS.length)
    expect(flat[0].account.id).toBe('1000')
  })
})

describe('postableAccounts / postableJournalAccounts', () => {
  it('excludes headers and inactive accounts', () => {
    const result = postableAccounts(ACCOUNTS)
    expect(result.map((a) => a.id).sort()).toEqual(['1110', '1200', '5100'])
  })

  it('journal-eligible accounts also exclude control and restricted accounts', () => {
    const result = postableJournalAccounts(ACCOUNTS)
    expect(result.map((a) => a.id)).toEqual(['1110'])
  })
})

describe('accountByRole / accountByCode', () => {
  it('finds the account holding a role', () => {
    expect(accountByRole(ACCOUNTS, 'CASH_DEFAULT')?.id).toBe('1110')
  })

  it('returns undefined for an unmapped role', () => {
    expect(accountByRole(ACCOUNTS, 'BANK_DEFAULT')).toBeUndefined()
  })

  it('ignores an inactive account even if it happens to hold a role', () => {
    const withInactiveRole = [
      ...ACCOUNTS,
      account({ id: 'x', code: 'x', name: 'x', role: 'BANK_DEFAULT', isActive: false }),
    ]
    expect(accountByRole(withInactiveRole, 'BANK_DEFAULT')).toBeUndefined()
  })

  it('finds an account by its code', () => {
    expect(accountByCode(ACCOUNTS, '1200')?.name).toBe('Accounts Receivable')
  })
})
