import { sql } from 'kysely'
import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'
import { calendarDate, sqlDate } from './calendar-date.ts'

/*
 * Read-only query bodies behind the account ledger, trial balance and
 * customer subledger. docs/posting-rules/ledger-and-trial-balance.md.
 *
 * Every query here reads journal_lines/journal_entries directly — "No cached
 * balance exists in M2" (ledger-and-trial-balance.md §1) — and includes
 * BOTH statuses (POSTED and REVERSED): "the reversed original and its
 * reversal are both real postings and net to zero" (§1). No query in this
 * file filters on status; that is the point, not an omission.
 *
 * Amounts leave this module as decimal STRINGS (ADR-0011). Summation and
 * sign presentation happen in packages/reporting, using @finsoft/validation
 * — this file's job is the SQL, not the arithmetic.
 */

export interface LedgerLineRow {
  readonly lineId: string
  readonly lineNumber: number
  readonly createdAt: string
  readonly occurredAt: string
  readonly entryId: string
  readonly entryNumber: string
  readonly entryStatus: 'POSTED' | 'REVERSED'
  readonly narration: string
  readonly sourceType: string
  readonly sourceId: string
  readonly reversalOf: string | null
  readonly reversedBy: string | null
  readonly debit: string
  readonly credit: string
  readonly partyId: string | null
}

function mapLedgerLine(row: {
  line_id: string
  line_number: number
  created_at: string
  occurred_at: unknown
  entry_id: string
  entry_number: string
  entry_status: string
  narration: string
  source_type: string
  source_id: string
  reversal_of: string | null
  reversed_by: string | null
  debit: string
  credit: string
  party_id: string | null
}): LedgerLineRow {
  return {
    lineId: row.line_id,
    lineNumber: row.line_number,
    createdAt: row.created_at,
    occurredAt: calendarDate(row.occurred_at),
    entryId: row.entry_id,
    entryNumber: row.entry_number,
    entryStatus: row.entry_status as 'POSTED' | 'REVERSED',
    narration: row.narration,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reversalOf: row.reversal_of,
    reversedBy: row.reversed_by,
    debit: row.debit,
    credit: row.credit,
    partyId: row.party_id,
  }
}

/**
 * The opening balance for `accountId` as of (but excluding) `from`: the sum
 * of every line dated strictly before `from` (ledger-and-trial-balance.md
 * §2). Returned as a raw `{debit, credit}` pair — packages/reporting nets
 * them into a single signed figure via `Money`.
 */
export async function accountOpeningBalance(
  tx: TenantTx,
  tenantId: string,
  accountId: string,
  from: string,
  partyId: string | null,
): Promise<{ debit: string; credit: string }> {
  assertIssuedTenantTx(tx)

  let query = tx
    .selectFrom('journal_lines as jl')
    .innerJoin('journal_entries as je', (join) =>
      join.onRef('je.id', '=', 'jl.entry_id').on('je.tenant_id', '=', tenantId),
    )
    .where('jl.tenant_id', '=', tenantId)
    .where('jl.account_id', '=', accountId)
    .where('je.occurred_at', '<', sqlDate(from))

  if (partyId !== null) query = query.where('jl.party_id', '=', partyId)

  const row = await query
    .select((eb) => [
      eb.fn.sum<string>('jl.debit').as('debit'),
      eb.fn.sum<string>('jl.credit').as('credit'),
    ])
    .executeTakeFirstOrThrow()

  return { debit: row.debit ?? '0', credit: row.credit ?? '0' }
}

/**
 * The sum of every line for `accountId` dated `>= from` up to and including
 * `through` (a keyset position: occurred_at, created_at, entry_number,
 * line_number — the same tuple accountLedgerLines paginates on). Combined
 * with `accountOpeningBalance(from)` by packages/reporting, this recomputes
 * a resumed page's carry-forward balance SERVER-SIDE from the cursor's
 * POSITION alone.
 *
 * M2-B Council ruling, 2026-09-29 (Architecture/Accounting/Security, all
 * three seats): the client must never supply a financial number. The
 * previous shape trusted an opaque `closingBalance` round-tripped through
 * the cursor; a forged or stale one would have silently produced a wrong
 * running balance on every subsequent row of a resumed page. This function
 * is what replaces that trust with a real query.
 */
export async function accountLedgerBalanceThrough(
  tx: TenantTx,
  tenantId: string,
  accountId: string,
  from: string,
  through: LedgerCursor,
  partyId: string | null,
): Promise<{ debit: string; credit: string }> {
  assertIssuedTenantTx(tx)

  let query = tx
    .selectFrom('journal_lines as jl')
    .innerJoin('journal_entries as je', (join) =>
      join.onRef('je.id', '=', 'jl.entry_id').on('je.tenant_id', '=', tenantId),
    )
    .where('jl.tenant_id', '=', tenantId)
    .where('jl.account_id', '=', accountId)
    .where('je.occurred_at', '>=', sqlDate(from))
    .where(
      sql<boolean>`(je.occurred_at, je.created_at, je.entry_number, jl.line_number) <= (${through.occurredAt}::date, ${through.createdAt}::timestamptz, ${through.entryNumber}, ${through.lineNumber})`,
    )

  if (partyId !== null) query = query.where('jl.party_id', '=', partyId)

  const row = await query
    .select((eb) => [
      eb.fn.sum<string>('jl.debit').as('debit'),
      eb.fn.sum<string>('jl.credit').as('credit'),
    ])
    .executeTakeFirstOrThrow()

  return { debit: row.debit ?? '0', credit: row.credit ?? '0' }
}

/** Hard ceiling on one ledger page. A caller asking for more gets this many. */
export const LEDGER_PAGE_MAX = 500

/**
 * Keyset cursor: the last row of the previous page. Opaque to callers in
 * spirit — pass back `LedgerPage.next` unchanged.
 */
export interface LedgerCursor {
  readonly occurredAt: string
  readonly createdAt: string
  readonly entryNumber: string
  readonly lineNumber: number
}

export interface LedgerPage {
  readonly rows: readonly LedgerLineRow[]
  /** Null when this page is the last. */
  readonly next: LedgerCursor | null
}

/**
 * One page of the lines of `accountId` within `[from, to]`, in ledger order
 * (ledger-and-trial-balance.md §2: occurred_at, then created_at, then entry
 * number — and line_number as the final tie-break, since one entry may put
 * two lines on the same account). Keyset-paginated with a hard maximum of
 * LEDGER_PAGE_MAX rows: an account ledger over a year is unbounded in size,
 * and an unbounded result set on a list read is rejected outright.
 */
export async function accountLedgerLines(
  tx: TenantTx,
  tenantId: string,
  accountId: string,
  from: string,
  to: string,
  partyId: string | null,
  page: { readonly limit: number; readonly after: LedgerCursor | null },
): Promise<LedgerPage> {
  assertIssuedTenantTx(tx)
  const limit = Math.max(1, Math.min(Math.trunc(page.limit), LEDGER_PAGE_MAX))

  let query = tx
    .selectFrom('journal_lines as jl')
    .innerJoin('journal_entries as je', (join) =>
      join.onRef('je.id', '=', 'jl.entry_id').on('je.tenant_id', '=', tenantId),
    )
    .where('jl.tenant_id', '=', tenantId)
    .where('jl.account_id', '=', accountId)
    .where('je.occurred_at', '>=', sqlDate(from))
    .where('je.occurred_at', '<=', sqlDate(to))

  if (partyId !== null) query = query.where('jl.party_id', '=', partyId)

  if (page.after !== null) {
    const a = page.after
    query = query.where(
      sql<boolean>`(je.occurred_at, je.created_at, je.entry_number, jl.line_number) > (${a.occurredAt}::date, ${a.createdAt}::timestamptz, ${a.entryNumber}, ${a.lineNumber})`,
    )
  }

  const rows = await query
    .select([
      'jl.id as line_id',
      'jl.line_number as line_number',
      // Microsecond-exact, UTC, as text: a JS Date would truncate to
      // milliseconds and the keyset cursor would skip or repeat rows.
      sql<string>`to_char(je.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'created_at',
      ),
      'je.occurred_at as occurred_at',
      'je.id as entry_id',
      'je.entry_number as entry_number',
      'je.status as entry_status',
      'je.narration as narration',
      'je.source_type as source_type',
      'je.source_id as source_id',
      'je.reversal_of as reversal_of',
      'je.reversed_by as reversed_by',
      'jl.debit as debit',
      'jl.credit as credit',
      'jl.party_id as party_id',
    ])
    .orderBy('je.occurred_at')
    .orderBy('je.created_at')
    .orderBy('je.entry_number')
    .orderBy('jl.line_number')
    .limit(limit + 1)
    .execute()

  const mapped = rows.slice(0, limit).map(mapLedgerLine)
  const last = mapped.at(-1)
  const next =
    rows.length > limit && last !== undefined
      ? {
          occurredAt: last.occurredAt,
          createdAt: last.createdAt,
          entryNumber: last.entryNumber,
          lineNumber: last.lineNumber,
        }
      : null
  return { rows: mapped, next }
}

export interface TrialBalanceRow {
  readonly accountId: string
  readonly code: string
  readonly name: string
  readonly type: string
  readonly debit: string
  readonly credit: string
}

/**
 * Every POSTABLE account with at least one line dated on or before `asOf`,
 * summed from journal_lines directly (ledger-and-trial-balance.md §3). Sign
 * presentation (which column the net balance falls into) is
 * packages/reporting's job — this returns the raw sums.
 */
export async function trialBalanceRawSums(
  tx: TenantTx,
  tenantId: string,
  asOf: string,
): Promise<readonly TrialBalanceRow[]> {
  assertIssuedTenantTx(tx)

  const rows = await tx
    .selectFrom('journal_lines as jl')
    .innerJoin('journal_entries as je', (join) =>
      join.onRef('je.id', '=', 'jl.entry_id').on('je.tenant_id', '=', tenantId),
    )
    .innerJoin('accounts as a', (join) =>
      join.onRef('a.id', '=', 'jl.account_id').on('a.tenant_id', '=', tenantId),
    )
    .where('jl.tenant_id', '=', tenantId)
    .where('je.occurred_at', '<=', sqlDate(asOf))
    .groupBy(['a.id', 'a.code', 'a.name', 'a.type'])
    .select((eb) => [
      'a.id as account_id',
      'a.code as code',
      'a.name as name',
      'a.type as type',
      eb.fn.sum<string>('jl.debit').as('debit'),
      eb.fn.sum<string>('jl.credit').as('credit'),
    ])
    .orderBy('a.code')
    .execute()

  return rows.map((row) => ({
    accountId: row.account_id,
    code: row.code,
    name: row.name,
    type: row.type,
    debit: row.debit ?? '0',
    credit: row.credit ?? '0',
  }))
}

/**
 * `Σ (debit - credit)` on the AR_CONTROL (or, from Wave 6, AP_CONTROL) line
 * of `partyId`, up to and including `asOf` — the GL half of Invariant 9's
 * reconciliation (customer-receipt.md §8). Both POSTED and REVERSED entries
 * are included, exactly as every other read in this file.
 */
export async function partyControlBalance(
  tx: TenantTx,
  tenantId: string,
  controlKind: 'AR' | 'AP',
  partyId: string,
  asOf: string,
): Promise<{ debit: string; credit: string }> {
  assertIssuedTenantTx(tx)

  const row = await tx
    .selectFrom('journal_lines as jl')
    .innerJoin('journal_entries as je', (join) =>
      join.onRef('je.id', '=', 'jl.entry_id').on('je.tenant_id', '=', tenantId),
    )
    // ADR-0026: the line carries its account's control kind and its party
    // type, so no join to accounts. Access path: journal_lines_tenant_party_
    // account_idx (tenant_id, party_id, account_id) WHERE party_id IS NOT
    // NULL — ADR-0026 Compliance 8; party_type/account_control are residual
    // filters on one party's rows.
    .where('jl.tenant_id', '=', tenantId)
    .where('jl.party_type', '=', controlKind === 'AR' ? 'CUSTOMER' : 'VENDOR')
    .where('jl.party_id', '=', partyId)
    .where('jl.account_control', '=', controlKind)
    .where('je.occurred_at', '<=', sqlDate(asOf))
    .select((eb) => [
      eb.fn.sum<string>('jl.debit').as('debit'),
      eb.fn.sum<string>('jl.credit').as('credit'),
    ])
    .executeTakeFirstOrThrow()

  return { debit: row.debit ?? '0', credit: row.credit ?? '0' }
}
