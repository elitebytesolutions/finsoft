import { describe, expect, it } from 'vitest'
import {
  adaptVoucherLines,
  adaptVoucherSummary,
  adaptVoucherTotal,
  nameOfAccount,
} from '@/lib/adapters/vouchers'
import type {
  AccountDto,
  JournalEntryDetail,
  JournalEntrySummary,
} from '@/lib/api/accounting-types'

function account(overrides: Partial<AccountDto>): AccountDto {
  return {
    id: 'a1',
    code: '1110',
    name: 'Cash in Hand',
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

describe('adaptVoucherSummary', () => {
  it("maps POSTED/REVERSED to the restored screen's Posted/Reversed labels — no Draft, no Cancelled", () => {
    const base: JournalEntrySummary = {
      id: 'e1',
      entryNumber: 'JV-2027-000001',
      postingRule: 'JOURNAL_VOUCHER_POSTED@1',
      event: 'JOURNAL_VOUCHER_POSTED',
      occurredAt: '2026-09-29',
      status: 'POSTED',
      narration: 'Owner capital contribution',
      reference: null,
      sourceType: 'journal_voucher',
      sourceId: 'e1',
      reversalOf: null,
      reversedBy: null,
      reversalReason: null,
    }
    expect(adaptVoucherSummary(base).status).toBe('Posted')
    expect(adaptVoucherSummary({ ...base, status: 'REVERSED' }).status).toBe('Reversed')
    expect(adaptVoucherSummary({ ...base, reversalOf: 'e0' }).isReversal).toBe(true)
  })
})

describe('nameOfAccount / adaptVoucherLines', () => {
  const accounts = [
    account({ id: 'a1110', code: '1110', name: 'Cash in Hand' }),
    account({ id: 'a3100', code: '3100', name: "Owner's Capital", normalBalance: 'CREDIT' }),
  ]

  it('formats a resolved account as "Name (Code)"', () => {
    expect(nameOfAccount(accounts, 'a1110')).toBe('Cash in Hand (1110)')
  })

  it('falls back to the raw id for an account not in the loaded list, rather than crashing', () => {
    expect(nameOfAccount(accounts, 'unknown-id')).toBe('unknown-id')
  })

  it('keeps one row per real line — never synthesises a dr-account/cr-account pairing', () => {
    const lines = adaptVoucherLines(
      [
        {
          lineNumber: 1,
          accountId: 'a1110',
          debit: '50000.0000',
          credit: '0.0000',
          partyId: null,
          memo: null,
        },
        {
          lineNumber: 2,
          accountId: 'a3100',
          debit: '0.0000',
          credit: '50000.0000',
          partyId: null,
          memo: 'note',
        },
      ],
      accounts,
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      accountName: 'Cash in Hand (1110)',
      debit: 'Rs 50,000.00',
      credit: '—',
    })
    expect(lines[1]).toMatchObject({
      accountName: "Owner's Capital (3100)",
      debit: '—',
      credit: 'Rs 50,000.00',
      memo: 'note',
    })
  })
})

describe('adaptVoucherTotal', () => {
  it('sums the debit-side lines with Money — an already-balanced total, never re-checked here', () => {
    const entry: JournalEntryDetail = {
      id: 'e1',
      entryNumber: 'JV-2027-000001',
      postingRule: 'JOURNAL_VOUCHER_POSTED@1',
      event: 'JOURNAL_VOUCHER_POSTED',
      occurredAt: '2026-09-29',
      status: 'POSTED',
      narration: 'Split debit',
      reference: null,
      sourceType: 'journal_voucher',
      sourceId: 'e1',
      reversalOf: null,
      reversedBy: null,
      reversalReason: null,
      lines: [
        {
          lineNumber: 1,
          accountId: 'a1',
          debit: '1249.5',
          credit: '0.0000',
          partyId: null,
          memo: null,
        },
        {
          lineNumber: 2,
          accountId: 'a2',
          debit: '8750.5',
          credit: '0.0000',
          partyId: null,
          memo: null,
        },
        {
          lineNumber: 3,
          accountId: 'a3',
          debit: '0.0000',
          credit: '10000.0000',
          partyId: null,
          memo: null,
        },
      ],
    }
    // 1249.5 + 8750.5 = 10000.0000 exactly — the float-addition trap.
    expect(adaptVoucherTotal(entry)).toBe('Rs 10,000.00')
  })
})
