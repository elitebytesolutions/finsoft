import { randomUUID } from 'node:crypto'
import { withTenant, type FiscalPeriodRow, type TenantTx } from '@finsoft/database'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  scalarOn,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accountLedger } from './ledger.ts'
import { trialBalance } from './trial-balance.ts'
import { customerSubledgerBalance } from './subledger.ts'

/*
 * Real-database tests for the reporting layer. No mocked database anywhere
 * (AGENTS.md): every figure here is computed by posting real rows with raw
 * SQL (deliberately not through packages/accounting-kernel — this suite
 * tests the reporting arithmetic against known inputs, independent of
 * whatever the kernel's own posting path is doing) and then asserting what
 * accountLedger/trialBalance/customerSubledgerBalance compute from them.
 *
 * This file owns its own minimal fixtures rather than importing
 * database/tests/accounting-support.ts: packages/reporting's declared import
 * boundary (its own README) is packages/database, packages/validation and
 * packages/shared-types only — not the top-level database/tests directory.
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

interface LedgerTenant extends TenantFixture {
  readonly accounts: ReadonlyMap<string, string>
  readonly periods: ReadonlyMap<string, string>
}

async function createLedgerTenant(label: string): Promise<LedgerTenant> {
  const fixture = await createTenantFixture(label)
  return runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant(async (tx) => {
      const accounts = await seedChartOfAccounts(tx, fixture.tenantId)
      const periods: readonly FiscalPeriodRow[] = await createFiscalYear(tx, fixture.tenantId, 2027)
      return {
        ...fixture,
        accounts,
        periods: new Map(periods.map((p) => [p.label, p.id])),
      }
    }),
  )
}

function acct(t: LedgerTenant, code: string): string {
  const id = t.accounts.get(code)
  if (!id) throw new Error(`fixture: no account ${code}`)
  return id
}

function asTenant<T>(t: TenantFixture, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return runAs({ tenantId: t.tenantId, userId: t.ownerId }, () => withTenant(fn))
}

interface RawLine {
  readonly accountId: string
  readonly accountControl: 'NONE' | 'AR' | 'AP' | 'INVENTORY'
  readonly debit: string
  readonly credit: string
  readonly partyType?: 'CUSTOMER' | 'VENDOR' | null
  readonly partyId?: string | null
}

const FINGERPRINT = 'b'.repeat(64)

/** Insert one balanced entry (>=2 lines) directly, bypassing the kernel. */
async function postRaw(
  t: LedgerTenant,
  periodLabel: string,
  occurredAt: string,
  lines: readonly RawLine[],
): Promise<string> {
  const periodId = t.periods.get(periodLabel)
  if (!periodId) throw new Error(`fixture: no period ${periodLabel}`)

  return asTenant(t, async (tx) => {
    const entryId = await scalarOn<string>(
      tx,
      `insert into journal_entries (
         tenant_id, entry_number, posting_rule, event, occurred_at, fiscal_period_id,
         narration, source_type, source_id, idempotency_key, request_fingerprint,
         created_by, updated_by)
       values ($1, $2, 'JOURNAL_VOUCHER_POSTED@1', 'JOURNAL_VOUCHER_POSTED', $3, $4,
         'reporting fixture', 'journal_voucher', $5, $6, $7, $8, $8)
       returning id`,
      [
        t.tenantId,
        `JV-2027-${String(Math.floor(Math.random() * 900_000) + 100_000)}`,
        occurredAt,
        periodId,
        randomUUID(),
        `idem-${unique()}`,
        FINGERPRINT,
        t.ownerId,
      ],
    )
    if (!entryId) throw new Error('fixture: entry insert returned no id')

    let n = 0
    for (const line of lines) {
      n += 1
      await rawOn(
        tx,
        `insert into journal_lines (
           tenant_id, entry_id, line_number, account_id, account_control, debit, credit,
           party_type, party_id, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          t.tenantId,
          entryId,
          n,
          line.accountId,
          line.accountControl,
          line.debit,
          line.credit,
          line.partyType ?? null,
          line.partyId ?? null,
          t.ownerId,
        ],
      )
    }
    return entryId
  })
}

async function registerPartyRaw(t: TenantFixture, partyType: 'CUSTOMER' | 'VENDOR') {
  return asTenant(t, async (tx) => {
    const id = await scalarOn<string>(
      tx,
      `insert into parties (tenant_id, party_type, created_by, updated_by)
       values ($1, $2, $3, $3) returning id`,
      [t.tenantId, partyType, t.ownerId],
    )
    if (!id) throw new Error('fixture: party insert returned no id')
    return id
  })
}

describe('accountLedger', () => {
  it('computes opening balance, per-line running balance and closing balance', async () => {
    const t = await createLedgerTenant('LDG')
    const cash = acct(t, '1110')
    const capital = acct(t, '3100')

    // Two entries in July: +500 then -120 on cash. Running balance: 500, 380.
    await postRaw(t, '2026-07', '2026-07-05', [
      { accountId: cash, accountControl: 'NONE', debit: '500.0000', credit: '0' },
      { accountId: capital, accountControl: 'NONE', debit: '0', credit: '500.0000' },
    ])
    await postRaw(t, '2026-07', '2026-07-20', [
      { accountId: capital, accountControl: 'NONE', debit: '120.0000', credit: '0' },
      { accountId: cash, accountControl: 'NONE', debit: '0', credit: '120.0000' },
    ])

    const result = await asTenant(t, (tx) =>
      accountLedger(tx, t.tenantId, cash, { from: '2026-07-01', to: '2026-07-31' }),
    )

    expect(result.openingBalance).toBe('0.0000')
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0]?.debit).toBe('500.0000')
    expect(result.lines[0]?.runningBalance).toBe('500.0000')
    expect(result.lines[1]?.credit).toBe('120.0000')
    expect(result.lines[1]?.runningBalance).toBe('380.0000')
    expect(result.closingBalance).toBe('380.0000')
  })

  it('carries the closing balance of July into August as August opening balance', async () => {
    const t = await createLedgerTenant('LDG2')
    const cash = acct(t, '1110')
    const capital = acct(t, '3100')

    await postRaw(t, '2026-07', '2026-07-05', [
      { accountId: cash, accountControl: 'NONE', debit: '1000.0000', credit: '0' },
      { accountId: capital, accountControl: 'NONE', debit: '0', credit: '1000.0000' },
    ])

    const august = await asTenant(t, (tx) =>
      accountLedger(tx, t.tenantId, cash, { from: '2026-08-01', to: '2026-08-31' }),
    )
    expect(august.openingBalance).toBe('1000.0000')
    expect(august.lines).toHaveLength(0)
    expect(august.closingBalance).toBe('1000.0000')
  })

  it("does not see another tenant's lines against a matching account id (RLS)", async () => {
    const a = await createLedgerTenant('LDGA')
    const b = await createLedgerTenant('LDGB')
    const cashA = acct(a, '1110')
    const capitalA = acct(a, '3100')

    await postRaw(a, '2026-07', '2026-07-05', [
      { accountId: cashA, accountControl: 'NONE', debit: '999.0000', credit: '0' },
      { accountId: capitalA, accountControl: 'NONE', debit: '0', credit: '999.0000' },
    ])

    // Tenant B's own tx, tenant A's account id — RLS scopes journal_lines to
    // tenant B, so this must read as empty, not throw and not cross over.
    const asB = await asTenant(b, (tx) =>
      accountLedger(tx, b.tenantId, cashA, { from: '2026-07-01', to: '2026-07-31' }),
    )
    expect(asB.lines).toHaveLength(0)
    expect(asB.openingBalance).toBe('0.0000')
  })
})

describe('trialBalance', () => {
  it('presents by the sign of the net balance and totals debit = credit', async () => {
    const t = await createLedgerTenant('TB')
    const cash = acct(t, '1110')
    const capital = acct(t, '3100')
    const revenue = acct(t, '4200')

    await postRaw(t, '2026-07', '2026-07-10', [
      { accountId: cash, accountControl: 'NONE', debit: '1000.0000', credit: '0' },
      { accountId: capital, accountControl: 'NONE', debit: '0', credit: '1000.0000' },
    ])
    // A cash payment out that overdraws the account on paper, so its net
    // balance goes negative for this test — must land in the CREDIT column
    // despite being an ASSET account.
    await postRaw(t, '2026-07', '2026-07-15', [
      { accountId: revenue, accountControl: 'NONE', debit: '1500.0000', credit: '0' },
      { accountId: cash, accountControl: 'NONE', debit: '0', credit: '1500.0000' },
    ])

    const tb = await asTenant(t, (tx) => trialBalance(tx, t.tenantId, '2026-07-31'))

    const cashRow = tb.lines.find((l) => l.accountId === cash)
    expect(cashRow?.debit).toBe('0.0000')
    expect(cashRow?.credit).toBe('500.0000') // net = 1000 - 1500 = -500

    const capitalRow = tb.lines.find((l) => l.accountId === capital)
    expect(capitalRow?.debit).toBe('0.0000')
    expect(capitalRow?.credit).toBe('1000.0000')

    const revenueRow = tb.lines.find((l) => l.accountId === revenue)
    expect(revenueRow?.debit).toBe('1500.0000')
    expect(revenueRow?.credit).toBe('0.0000')

    expect(tb.totalDebit).toBe(tb.totalCredit)
    // revenue (+1500) is the only positive net balance; cash (-500) and
    // capital (-1000) both fall into Credit, summing to the same total.
    expect(tb.totalDebit).toBe('1500.0000')
  })
})

describe('customerSubledgerBalance', () => {
  it('nets AR-control lines for one party', async () => {
    const t = await createLedgerTenant('SUB')
    const ar = acct(t, '1200')
    const revenue = acct(t, '4200')
    const cash = acct(t, '1110')
    const customerId = await registerPartyRaw(t, 'CUSTOMER')

    // Invoice: Dr AR 800 / Cr Revenue 800.
    await postRaw(t, '2026-07', '2026-07-05', [
      {
        accountId: ar,
        accountControl: 'AR',
        debit: '800.0000',
        credit: '0',
        partyType: 'CUSTOMER',
        partyId: customerId,
      },
      { accountId: revenue, accountControl: 'NONE', debit: '0', credit: '800.0000' },
    ])
    // Partial receipt: Dr Cash 300 / Cr AR 300.
    await postRaw(t, '2026-07', '2026-07-20', [
      { accountId: cash, accountControl: 'NONE', debit: '300.0000', credit: '0' },
      {
        accountId: ar,
        accountControl: 'AR',
        debit: '0',
        credit: '300.0000',
        partyType: 'CUSTOMER',
        partyId: customerId,
      },
    ])

    const balance = await asTenant(t, (tx) =>
      customerSubledgerBalance(tx, t.tenantId, customerId, '2026-07-31'),
    )
    expect(balance.controlKind).toBe('AR')
    expect(balance.balance).toBe('500.0000')
  })
})
