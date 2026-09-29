import { sql } from 'kysely'
import { assertIssuedTenantTx, type TenantTx } from '@finsoft/database'

/*
 * Read-only assertion queries for the golden runner and the
 * FinancialInvariantSuite. Deliberately written here, independently of
 * packages/database/src/accounting and packages/reporting: a check that
 * reused the query it is checking would agree with it by construction.
 *
 * All amounts come back as numeric text (ADR-0011) and are compared as
 * strings or through Money — never as JS numbers. Counts are compared as
 * integers, which is what they are.
 */

export async function countJournalEntries(tx: TenantTx, tenantId: string): Promise<number> {
  assertIssuedTenantTx(tx)
  const row = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM journal_entries WHERE tenant_id = ${tenantId}
  `.execute(tx)
  return Number(row.rows[0]?.count ?? '0')
}

/** Audit records for the tenant; `action` narrows to one action. */
export async function countAuditRecords(
  tx: TenantTx,
  tenantId: string,
  action?: string,
): Promise<number> {
  assertIssuedTenantTx(tx)
  const row =
    action === undefined
      ? await sql<{ count: string }>`
          SELECT count(*)::text AS count FROM audit_log WHERE tenant_id = ${tenantId}
        `.execute(tx)
      : await sql<{ count: string }>`
          SELECT count(*)::text AS count FROM audit_log WHERE tenant_id = ${tenantId} AND action = ${action}
        `.execute(tx)
  return Number(row.rows[0]?.count ?? '0')
}

export interface MovementRow {
  readonly code: string
  readonly debit: string
  readonly credit: string
}

/** Σ debit / Σ credit per account for entries dated in [from, to]. Accounts with no line are absent. */
export async function accountMovement(
  tx: TenantTx,
  tenantId: string,
  from: string,
  to: string,
): Promise<readonly MovementRow[]> {
  assertIssuedTenantTx(tx)
  const result = await sql<MovementRow>`
    SELECT a.code, sum(jl.debit)::text AS debit, sum(jl.credit)::text AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
      JOIN accounts a         ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
     WHERE jl.tenant_id = ${tenantId}
       AND je.occurred_at BETWEEN ${from}::date AND ${to}::date
     GROUP BY a.code
     ORDER BY a.code
  `.execute(tx)
  return result.rows
}

/**
 * Invariant 1 detector: every entry of the tenant whose lines do not balance
 * exactly, or that has fewer than two lines. Empty = holds.
 */
export async function unbalancedEntries(
  tx: TenantTx,
  tenantId: string,
): Promise<readonly { entry_number: string; debit: string; credit: string; lines: string }[]> {
  assertIssuedTenantTx(tx)
  const result = await sql<{ entry_number: string; debit: string; credit: string; lines: string }>`
    SELECT je.entry_number,
           coalesce(sum(jl.debit), 0)::text  AS debit,
           coalesce(sum(jl.credit), 0)::text AS credit,
           count(jl.id)::text                AS lines
      FROM journal_entries je
      LEFT JOIN journal_lines jl ON jl.tenant_id = je.tenant_id AND jl.entry_id = je.id
     WHERE je.tenant_id = ${tenantId}
     GROUP BY je.id, je.entry_number
    HAVING coalesce(sum(jl.debit), 0) <> coalesce(sum(jl.credit), 0) OR count(jl.id) < 2
  `.execute(tx)
  return result.rows
}

/**
 * Invariant 2 detector: for every fiscal period of the tenant, the trial
 * balance up to that period's last day. Rows where Σ debit <> Σ credit.
 */
export async function unbalancedTrialBalances(
  tx: TenantTx,
  tenantId: string,
): Promise<readonly { label: string; debit: string; credit: string }[]> {
  assertIssuedTenantTx(tx)
  const result = await sql<{ label: string; debit: string; credit: string }>`
    SELECT fp.label,
           coalesce(sum(jl.debit), 0)::text  AS debit,
           coalesce(sum(jl.credit), 0)::text AS credit
      FROM fiscal_periods fp
      LEFT JOIN journal_entries je ON je.tenant_id = fp.tenant_id AND je.occurred_at <= fp.period_end
      LEFT JOIN journal_lines jl   ON jl.tenant_id = je.tenant_id AND jl.entry_id = je.id
     WHERE fp.tenant_id = ${tenantId}
     GROUP BY fp.id, fp.label
    HAVING coalesce(sum(jl.debit), 0) <> coalesce(sum(jl.credit), 0)
  `.execute(tx)
  return result.rows
}

/**
 * Invariant 6 detector, per (reversal pair, account, party):
 * Σ(E.debit − E.credit) + Σ(R.debit − R.credit), where it is not zero; plus
 * pairs whose line counts differ, or whose E is not marked REVERSED by R.
 */
export async function reversalResiduals(
  tx: TenantTx,
  tenantId: string,
): Promise<
  readonly {
    original: string
    reversal: string
    code: string
    party_id: string | null
    residual: string
  }[]
> {
  assertIssuedTenantTx(tx)
  const result = await sql<{
    original: string
    reversal: string
    code: string
    party_id: string | null
    residual: string
  }>`
    WITH pairs AS (
      SELECT e.id AS e_id, r.id AS r_id, e.entry_number AS original, r.entry_number AS reversal
        FROM journal_entries r
        JOIN journal_entries e ON e.tenant_id = r.tenant_id AND e.id = r.reversal_of
       WHERE r.tenant_id = ${tenantId}
    )
    SELECT p.original, p.reversal, a.code, jl.party_id::text AS party_id,
           sum(jl.debit - jl.credit)::text AS residual
      FROM pairs p
      JOIN journal_lines jl ON jl.tenant_id = ${tenantId} AND jl.entry_id IN (p.e_id, p.r_id)
      JOIN accounts a       ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
     GROUP BY p.original, p.reversal, a.code, jl.party_id
    HAVING sum(jl.debit - jl.credit) <> 0
    UNION ALL
    SELECT p.original, p.reversal, '(shape)', NULL,
           'line counts ' || (SELECT count(*) FROM journal_lines WHERE tenant_id = ${tenantId} AND entry_id = p.e_id)
           || ' vs ' || (SELECT count(*) FROM journal_lines WHERE tenant_id = ${tenantId} AND entry_id = p.r_id)
           || ', original status ' || e.status
      FROM pairs p
      JOIN journal_entries e ON e.tenant_id = ${tenantId} AND e.id = p.e_id
     WHERE e.status <> 'REVERSED' OR e.reversed_by IS DISTINCT FROM p.r_id
        OR (SELECT count(*) FROM journal_lines WHERE tenant_id = ${tenantId} AND entry_id = p.e_id)
        <> (SELECT count(*) FROM journal_lines WHERE tenant_id = ${tenantId} AND entry_id = p.r_id)
  `.execute(tx)
  return result.rows
}

/** Per-account residual of every reversal pair, including the zero ones (P07's invariant6 assertion). */
export async function reversalPairResidualByAccount(
  tx: TenantTx,
  tenantId: string,
): Promise<ReadonlyMap<string, string>> {
  assertIssuedTenantTx(tx)
  const result = await sql<{ code: string; residual: string }>`
    SELECT a.code, sum(jl.debit - jl.credit)::text AS residual
      FROM journal_entries r
      JOIN journal_lines jl ON jl.tenant_id = r.tenant_id AND jl.entry_id IN (r.id, r.reversal_of)
      JOIN accounts a       ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
     WHERE r.tenant_id = ${tenantId} AND r.reversal_of IS NOT NULL
     GROUP BY a.code
  `.execute(tx)
  return new Map(result.rows.map((row) => [row.code, row.residual]))
}

/** Entry numbers issued to the tenant in one series, in order. */
export async function entryNumbersInSeries(
  tx: TenantTx,
  tenantId: string,
  series: string,
): Promise<readonly string[]> {
  assertIssuedTenantTx(tx)
  const result = await sql<{ entry_number: string }>`
    SELECT entry_number FROM journal_entries
     WHERE tenant_id = ${tenantId} AND entry_number LIKE ${`${series}-%`}
     ORDER BY entry_number
  `.execute(tx)
  return result.rows.map((row) => row.entry_number)
}
