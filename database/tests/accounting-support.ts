import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { withTenant, type TenantTx } from '@finsoft/database'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import {
  createTenantFixture,
  rawOn,
  runAs,
  scalarOn,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'

/*
 * Fixtures shared by the accounting-core specs (migrations 010-013).
 *
 * Journal rows are written here with RAW SQL as finsoft_app, deliberately
 * NOT through packages/accounting-kernel: these files test what the
 * DATABASE refuses, independently of whether the kernel would ever have
 * sent the row. A kernel pre-check that masked a missing constraint would
 * make these tests pass for the wrong reason.
 */

export interface LedgerTenant extends TenantFixture {
  /** Account id by COA/standard-v1 code (1200 = AR control, 2100 = AP control, 1110 = cash, ...). */
  readonly accounts: ReadonlyMap<string, string>
  /** FY2027 period id by label ('2026-07' .. '2027-06'). */
  readonly periods: ReadonlyMap<string, string>
}

/** A tenant with the standard chart and FY2027 (1 Jul 2026 - 30 Jun 2027). */
export async function createLedgerTenant(label: string): Promise<LedgerTenant> {
  const fixture = await createTenantFixture(label)
  return runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant(async (tx) => {
      const accounts = await seedChartOfAccounts(tx, fixture.tenantId)
      const periods = await createFiscalYear(tx, fixture.tenantId, 2027)
      return {
        ...fixture,
        accounts,
        periods: new Map(periods.map((p) => [p.label, p.id])),
      }
    }),
  )
}

export function asTenant<T>(t: TenantFixture, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return runAs({ tenantId: t.tenantId, userId: t.ownerId }, () => withTenant(fn))
}

export function account(t: LedgerTenant, code: string): string {
  const id = t.accounts.get(code)
  if (!id) throw new Error(`fixture: no account ${code}`)
  return id
}

export function period(t: LedgerTenant, label: string): string {
  const id = t.periods.get(label)
  if (!id) throw new Error(`fixture: no period ${label}`)
  return id
}

export async function registerPartyRaw(
  tx: TenantTx,
  t: TenantFixture,
  partyType: 'CUSTOMER' | 'VENDOR',
): Promise<string> {
  const id = await scalarOn<string>(
    tx,
    `insert into parties (tenant_id, party_type, created_by, updated_by)
     values ($1, $2, $3, $3) returning id`,
    [t.tenantId, partyType, t.ownerId],
  )
  if (!id) throw new Error('fixture: party insert returned no id')
  return id
}

export interface RawEntry {
  readonly periodLabel?: string
  readonly occurredAt?: string
  readonly postingRule?: string
  readonly sourceType?: string
  readonly sourceId?: string
  readonly reversalOf?: string | null
  readonly reversalReason?: string | null
  readonly entryNumber?: string
}

export interface RawLine {
  readonly accountId: string
  readonly accountControl: 'NONE' | 'AR' | 'AP' | 'INVENTORY'
  readonly debit: string
  readonly credit: string
  readonly partyType?: 'CUSTOMER' | 'VENDOR' | null
  readonly partyId?: string | null
}

const FINGERPRINT = 'a'.repeat(64)

/** Insert an entry row only. Returns its id. */
export async function insertEntryRaw(
  tx: TenantTx,
  t: LedgerTenant,
  entry: RawEntry = {},
): Promise<string> {
  const id = await scalarOn<string>(
    tx,
    `insert into journal_entries (
       tenant_id, entry_number, posting_rule, event, occurred_at, fiscal_period_id,
       narration, source_type, source_id, idempotency_key, request_fingerprint,
       reversal_of, reversal_reason, created_by, updated_by)
     values ($1, $2, $3, 'JOURNAL_VOUCHER_POSTED', $4, $5, 'fixture', $6, $7, $8, $9, $10, $11, $12, $12)
     returning id`,
    [
      t.tenantId,
      entry.entryNumber ?? `JV-2027-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      entry.postingRule ?? 'JOURNAL_VOUCHER_POSTED@1',
      entry.occurredAt ?? '2026-08-15',
      period(t, entry.periodLabel ?? '2026-08'),
      entry.sourceType ?? 'journal_voucher',
      entry.sourceId ?? randomUUID(),
      `idem-${unique()}`,
      FINGERPRINT,
      entry.reversalOf ?? null,
      entry.reversalReason ?? null,
      t.ownerId,
    ],
  )
  if (!id) throw new Error('fixture: entry insert returned no id')
  return id
}

export async function insertLinesRaw(
  tx: TenantTx,
  t: TenantFixture,
  entryId: string,
  lines: readonly RawLine[],
): Promise<void> {
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
}

/** A committed, balanced two-line entry: Dr `debitAccount` / Cr `creditAccount`. */
export async function postBalancedRaw(
  t: LedgerTenant,
  debit: RawLine,
  credit: RawLine,
  entry: RawEntry = {},
): Promise<string> {
  return asTenant(t, async (tx) => {
    const entryId = await insertEntryRaw(tx, t, entry)
    await insertLinesRaw(tx, t, entryId, [debit, credit])
    return entryId
  })
}

/** Cash (1110, NONE) / Owner's Capital (3100, NONE), 100.0000. */
export function cashCapital(t: LedgerTenant, amount = '100.0000'): [RawLine, RawLine] {
  return [
    { accountId: account(t, '1110'), accountControl: 'NONE', debit: amount, credit: '0' },
    { accountId: account(t, '3100'), accountControl: 'NONE', debit: '0', credit: amount },
  ]
}

/** finsoft_migration: the owning, BYPASSRLS role. Used to prove a rule is a constraint, not RLS. */
export function migrationClient(): Client {
  const url = process.env['TEST_MIGRATION_DATABASE_URL']
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
  return new Client({ connectionString: url })
}

/** Resolve a promise's rejection to its SQLSTATE, or 'resolved' if it did not reject. */
export async function stateOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return 'resolved'
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code
      return typeof code === 'string' ? code : undefined
    }
    throw error
  }
}
