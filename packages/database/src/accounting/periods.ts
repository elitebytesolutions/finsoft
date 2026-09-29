import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'
import { calendarDate, sqlDate } from './calendar-date.ts'
import { TenantContext } from '../tenant-context.ts'
import { recordAudit } from '../audit/writer.ts'
import { auditRequestId, auditVia, type AuditOrigin } from './audit-origin.ts'

/*
 * Fiscal periods. docs/posting-rules/periods.md, ADR-0012.
 */

export type PeriodStatus = 'OPEN' | 'CLOSED' | 'LOCKED'

export interface FiscalPeriodRow {
  readonly id: string
  readonly tenantId: string
  readonly fiscalYear: number
  readonly periodIndex: number
  /** ISO date string (YYYY-MM-DD). */
  readonly periodStart: string
  readonly periodEnd: string
  readonly label: string
  readonly status: PeriodStatus
  readonly version: number
}

function mapRow(row: {
  id: string
  tenant_id: string
  fiscal_year: number
  period_index: number
  period_start: unknown
  period_end: unknown
  label: string
  status: string
  version: number
}): FiscalPeriodRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fiscalYear: row.fiscal_year,
    periodIndex: row.period_index,
    periodStart: calendarDate(row.period_start),
    periodEnd: calendarDate(row.period_end),
    label: row.label,
    status: row.status as PeriodStatus,
    version: row.version,
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function isoDate(year: number, month1Based: number, day: number): string {
  return `${year}-${pad2(month1Based)}-${pad2(day)}`
}

function daysInMonth(year: number, month1Based: number): number {
  // Day 0 of the FOLLOWING month is the last day of this one.
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate()
}

/**
 * The twelve (fiscalYear, monthStart) pairs a fiscal year beginning in
 * `fiscalYearStartMonth` (1-12, default 7 = July, periods.md §2) and ending
 * in the calendar year `fiscalYear` produces, in chronological order.
 */
function computeMonths(
  fiscalYear: number,
  fiscalYearStartMonth: number,
): readonly { year: number; month: number }[] {
  const months: { year: number; month: number }[] = []
  for (let i = 0; i < 12; i++) {
    const absolute = fiscalYearStartMonth - 1 + i // 0-based, may exceed 11
    const year = fiscalYear - 1 + Math.floor(absolute / 12)
    const month = (absolute % 12) + 1
    months.push({ year, month })
  }
  return months
}

/**
 * Create the twelve monthly periods of fiscal year `fiscalYear` (labelled by
 * the year it ENDS, periods.md §2), all OPEN.
 *
 * Deliberately not idempotent, same precedent as `insertSeededRoles` and
 * `seedChartOfAccounts`: `fiscal_periods_tenant_fy_index_key` and the
 * no-overlap exclusion constraint (migration 011) both reject a second call
 * for the same fiscal year. A caller wanting idempotence (the backfill CLI)
 * checks first with `hasFiscalYear`.
 *
 * Writes one audit record (periods.md §3: "master data, not a posting").
 */
export async function createFiscalYear(
  tx: TenantTx,
  tenantId: string,
  fiscalYear: number,
  fiscalYearStartMonth = 7,
  origin?: AuditOrigin,
): Promise<readonly FiscalPeriodRow[]> {
  assertIssuedTenantTx(tx)

  const context = TenantContext.require()
  if (context.tenantId !== tenantId) {
    throw new Error(
      `createFiscalYear: tenantId argument (${tenantId}) does not match the transaction's ` +
        `tenant (${context.tenantId}).`,
    )
  }
  const actor = context.userId
  if (actor === null) {
    throw new Error(
      'createFiscalYear: no acting user in context. Periods are created under an already-' +
        'created provisioned owner, never with no author (rule 9).',
    )
  }

  // Validated before any write, so a bad origin fails with nothing inserted.
  const auditRequest = auditRequestId(origin)
  const auditLabel = auditVia(origin)

  const months = computeMonths(fiscalYear, fiscalYearStartMonth)
  const created: FiscalPeriodRow[] = []

  for (let i = 0; i < months.length; i++) {
    const { year, month } = months[i]!
    const periodStart = isoDate(year, month, 1)
    const periodEnd = isoDate(year, month, daysInMonth(year, month))
    const label = `${year}-${pad2(month)}`

    const row = await tx
      .insertInto('fiscal_periods')
      .values({
        tenant_id: tenantId,
        fiscal_year: fiscalYear,
        period_index: i + 1,
        period_start: periodStart,
        period_end: periodEnd,
        label,
        created_by: actor,
        updated_by: actor,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    created.push(mapRow(row))
  }

  await recordAudit(tx, {
    actorUserId: actor,
    action: 'FISCAL_YEAR_CREATED',
    entityType: 'fiscal_periods',
    entityId: null,
    beforeJson: null,
    afterJson: {
      fiscalYear: String(fiscalYear),
      periodCount: String(created.length),
      ...auditLabel,
    },
    ip: null,
    requestId: auditRequest,
  })

  return created
}

/** Whether `tenantId` already has periods for `fiscalYear`. Idempotency guard for the backfill CLI. */
export async function hasFiscalYear(
  tx: TenantTx,
  tenantId: string,
  fiscalYear: number,
): Promise<boolean> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('fiscal_periods')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('tenant_id', '=', tenantId)
    .where('fiscal_year', '=', fiscalYear)
    .executeTakeFirstOrThrow()
  return Number(row.count) > 0
}

/**
 * The single period whose [period_start, period_end] contains `date` (an
 * ISO YYYY-MM-DD string), or null (PERIOD_NOT_FOUND — the kernel's call).
 *
 * LOCKS the row `FOR SHARE` (docs/LOCK_REGISTRY.md position 5b). This is the
 * posting path's period read, and taking the lock HERE — before numbering
 * (5c) and before the journal_entries INSERT whose trigger re-reads the same
 * row FOR SHARE — is what makes the registered order true: period, then
 * counter, then the terminal audit lock. A close (FOR UPDATE) of this period
 * waits for this transaction; the status returned cannot go stale before the
 * insert. Do not use this for display-only reads.
 */
export async function findPeriodForDate(
  tx: TenantTx,
  tenantId: string,
  date: string,
): Promise<FiscalPeriodRow | null> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('fiscal_periods')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('period_start', '<=', sqlDate(date))
    .where('period_end', '>=', sqlDate(date))
    .forShare()
    .executeTakeFirst()
  return row ? mapRow(row) : null
}

export async function findPeriodById(
  tx: TenantTx,
  tenantId: string,
  periodId: string,
): Promise<FiscalPeriodRow | null> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('fiscal_periods')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', periodId)
    .executeTakeFirst()
  return row ? mapRow(row) : null
}

/**
 * Every fiscal period of the caller's tenant, chronological order
 * (fiscal_year, then period_index — contiguous by construction,
 * periods.md §1). GET /api/periods' one query.
 */
export async function listPeriods(
  tx: TenantTx,
  tenantId: string,
): Promise<readonly FiscalPeriodRow[]> {
  assertIssuedTenantTx(tx)
  const rows = await tx
    .selectFrom('fiscal_periods')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('fiscal_year')
    .orderBy('period_index')
    .execute()
  return rows.map(mapRow)
}
