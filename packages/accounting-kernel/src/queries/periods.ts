import { sql, type RawBuilder } from 'kysely'
import {
  assertIssuedTenantTx,
  recordAudit,
  type FiscalPeriodRow,
  type PeriodStatus,
  type TenantTx,
} from '@finsoft/database'
import { KernelInvariantError, PostingError } from '../errors.ts'

/*
 * The kernel's own fiscal_periods queries: two lock-free reads, and the three
 * period TRANSITIONS (close, reopen, lock).
 *
 * The posting gate itself is packages/database's `findPeriodForDate`, which
 * takes the period row FOR SHARE (LOCK_REGISTRY 5b). These two reads
 * deliberately take NO lock:
 *
 *  - `findPeriodSummaryForDate` fills in the "current open period" a
 *    PERIOD_CLOSED rejection names (journal-voucher.md §10). It runs only on a
 *    path that is about to throw, and a share lock there would be a second,
 *    unregistered row lock for no correctness gain.
 *  - `findPeriodByLabel` resolves a label for a period TRANSITION. A
 *    transition then locks the whole calendar FOR UPDATE (lockTenantCalendar);
 *    taking FOR SHARE on the target first would be a share-to-exclusive
 *    upgrade, which deadlocks two concurrent transitions of the same period.
 *    The transition re-reads the target under that lock and decides from the
 *    locked row, so a stale label read cannot cause a wrong transition.
 */

export interface PeriodSummary {
  readonly id: string
  readonly label: string
  readonly status: PeriodStatus
  readonly version: number
}

export async function findPeriodSummaryForDate(
  tx: TenantTx,
  tenantId: string,
  isoDate: string,
): Promise<PeriodSummary | null> {
  assertIssuedTenantTx(tx)
  const result = await sql<{ id: string; label: string; status: PeriodStatus; version: number }>`
    SELECT id, label, status, version
      FROM fiscal_periods
     WHERE tenant_id = ${tenantId}
       AND period_start <= ${isoDate}::date
       AND period_end   >= ${isoDate}::date
  `.execute(tx)
  return result.rows[0] ?? null
}

export async function findPeriodByLabel(
  tx: TenantTx,
  tenantId: string,
  label: string,
): Promise<PeriodSummary | null> {
  assertIssuedTenantTx(tx)
  const result = await sql<{ id: string; label: string; status: PeriodStatus; version: number }>`
    SELECT id, label, status, version
      FROM fiscal_periods
     WHERE tenant_id = ${tenantId}
       AND label = ${label}
  `.execute(tx)
  return result.rows[0] ?? null
}

/*
 * ---------------------------------------------------------------------------
 * PERIOD TRANSITIONS. periods.md §4, §4.1, §7, ADR-0012.
 *
 * Moved here from packages/database (T3 Council, Arch 1/2/5, Acct F3/R3): a
 * transition decides which dates can receive a posting — accounting truth —
 * so its body belongs to the kernel, not to the general-purpose database
 * surface every module's infrastructure layer may import. `createFiscalYear`
 * stays on @finsoft/database/provisioning (periods.md §3: master data at
 * tenant creation, not a transition).
 *
 * Each transition, inside the caller's transaction:
 *  1. lock EVERY period of the tenant FOR UPDATE, ascending period_start
 *     (LOCK_REGISTRY "fiscal_periods transitions"). Transitions of a tenant
 *     are strictly serial, and a posting's FOR SHARE on its period
 *     (findPeriodForDate) blocks against this lock, so no posting can commit
 *     into a period between the check below and the UPDATE (periods.md §7);
 *  2. read the target under that lock and decide from THAT row. No
 *     caller-supplied version: the caller names a period by label, and a
 *     transition that committed before step 1 is seen here as the period's
 *     real status and answered with its typed code (closing an already
 *     CLOSED period is PERIOD_CLOSED) — never an untyped "modified
 *     concurrently" error;
 *  3. the order check (§4 / §4.1), restated for a typed rejection. Migration
 *     011's transition trigger remains the database's own backstop;
 *  4. the UPDATE, predicated on the version read in step 2. We hold the row
 *     lock, so a mismatch is a kernel defect (KernelInvariantError), not a
 *     user condition;
 *  5. the audit record, in the same transaction (rule 9).
 *
 * Every refusal is a PostingError carrying periods.md §9's code, thrown
 * before any write.
 * ---------------------------------------------------------------------------
 */

interface PeriodDbRow {
  id: string
  tenant_id: string
  fiscal_year: number
  period_index: number
  period_start: string
  period_end: string
  label: string
  status: PeriodStatus
  version: number
}

function toFiscalPeriodRow(row: PeriodDbRow): FiscalPeriodRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fiscalYear: row.fiscal_year,
    periodIndex: row.period_index,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    label: row.label,
    status: row.status,
    version: row.version,
  }
}

// Dates leave the database as ISO text: no JS Date, no timezone shift.
const PERIOD_COLUMNS = sql`
  id, tenant_id, fiscal_year, period_index,
  to_char(period_start, 'YYYY-MM-DD') AS period_start,
  to_char(period_end,   'YYYY-MM-DD') AS period_end,
  label, status, version
`

/** Step 1, then step 2: the whole calendar FOR UPDATE, then the target as it stands under it. */
async function lockedTarget(
  tx: TenantTx,
  tenantId: string,
  periodId: string,
): Promise<PeriodDbRow> {
  await sql`
    SELECT id FROM fiscal_periods
     WHERE tenant_id = ${tenantId}
     ORDER BY period_start
       FOR UPDATE
  `.execute(tx)
  const result = await sql<PeriodDbRow>`
    SELECT ${PERIOD_COLUMNS}
      FROM fiscal_periods
     WHERE tenant_id = ${tenantId} AND id = ${periodId}
  `.execute(tx)
  const row = result.rows[0]
  if (!row) {
    throw new PostingError('PERIOD_NOT_FOUND', `No fiscal period ${periodId}.`, { periodId })
  }
  return row
}

async function countPeriodsWhere(
  tx: TenantTx,
  tenantId: string,
  predicate: RawBuilder<unknown>,
): Promise<number> {
  const result = await sql<{ count: string }>`
    SELECT count(*)::text AS count
      FROM fiscal_periods
     WHERE tenant_id = ${tenantId} AND ${predicate}
  `.execute(tx)
  return Number(result.rows[0]?.count ?? '0')
}

function transitioned(rows: readonly PeriodDbRow[], target: PeriodDbRow): FiscalPeriodRow {
  const row = rows[0]
  if (!row) {
    throw new KernelInvariantError(
      `fiscal_periods ${target.id} (${target.label}) changed version while this transaction ` +
        'held it FOR UPDATE — impossible unless the calendar lock was not taken.',
    )
  }
  return toFiscalPeriodRow(row)
}

function refuse(code: 'PERIOD_LOCKED' | 'PERIOD_CLOSED' | 'PERIOD_NOT_CLOSED', row: PeriodDbRow) {
  return new PostingError(code, `Period ${row.label} is ${row.status}.`, {
    period: row.label,
    status: row.status,
  })
}

/** CLOSE: OPEN -> CLOSED. Every earlier period must already be CLOSED or LOCKED (§4). */
export async function closePeriodTransition(
  tx: TenantTx,
  tenantId: string,
  periodId: string,
  actorUserId: string,
): Promise<FiscalPeriodRow> {
  assertIssuedTenantTx(tx)
  const current = await lockedTarget(tx, tenantId, periodId)
  if (current.status === 'LOCKED') throw refuse('PERIOD_LOCKED', current)
  // periods.md §9 has no separate "already closed" code; the state is the answer.
  if (current.status === 'CLOSED') throw refuse('PERIOD_CLOSED', current)

  const earlierOpen = await countPeriodsWhere(
    tx,
    tenantId,
    sql`period_start < ${current.period_start}::date AND status = 'OPEN'`,
  )
  if (earlierOpen > 0) {
    throw new PostingError(
      'PERIOD_CLOSE_OUT_OF_ORDER',
      `Period ${current.label} cannot close while an earlier period is OPEN.`,
      { period: current.label },
    )
  }

  const updated = await sql<PeriodDbRow>`
    UPDATE fiscal_periods
       SET status = 'CLOSED', closed_at = now(), closed_by = ${actorUserId},
           updated_by = ${actorUserId}, version = ${current.version + 1}
     WHERE tenant_id = ${tenantId} AND id = ${periodId} AND version = ${current.version}
    RETURNING ${PERIOD_COLUMNS}
  `.execute(tx)
  const row = transitioned(updated.rows, current)

  await recordAudit(tx, {
    actorUserId,
    action: 'PERIOD_CLOSED',
    entityType: 'fiscal_periods',
    entityId: periodId,
    beforeJson: { status: 'OPEN' },
    afterJson: { status: 'CLOSED' },
  })
  return row
}

/**
 * REOPEN: CLOSED -> OPEN, with a reason. No LATER period may be CLOSED or
 * LOCKED (§4.1: reopening walks backwards from the most recent close).
 */
export async function reopenPeriodTransition(
  tx: TenantTx,
  tenantId: string,
  periodId: string,
  actorUserId: string,
  reason: string,
): Promise<FiscalPeriodRow> {
  assertIssuedTenantTx(tx)
  const current = await lockedTarget(tx, tenantId, periodId)
  if (current.status === 'LOCKED') throw refuse('PERIOD_LOCKED', current)
  if (current.status === 'OPEN') throw refuse('PERIOD_NOT_CLOSED', current)

  const laterActive = await countPeriodsWhere(
    tx,
    tenantId,
    sql`period_start > ${current.period_start}::date AND status IN ('CLOSED', 'LOCKED')`,
  )
  if (laterActive > 0) {
    throw new PostingError(
      'PERIOD_REOPEN_OUT_OF_ORDER',
      `Period ${current.label} cannot reopen while a later period is CLOSED or LOCKED.`,
      { period: current.label },
    )
  }

  const updated = await sql<PeriodDbRow>`
    UPDATE fiscal_periods
       SET status = 'OPEN', closed_at = NULL, closed_by = NULL,
           reopened_at = now(), reopened_by = ${actorUserId}, reopen_reason = ${reason},
           updated_by = ${actorUserId}, version = ${current.version + 1}
     WHERE tenant_id = ${tenantId} AND id = ${periodId} AND version = ${current.version}
    RETURNING ${PERIOD_COLUMNS}
  `.execute(tx)
  const row = transitioned(updated.rows, current)

  await recordAudit(tx, {
    actorUserId,
    action: 'PERIOD_REOPENED',
    entityType: 'fiscal_periods',
    entityId: periodId,
    beforeJson: { status: 'CLOSED' },
    afterJson: { status: 'OPEN', reason },
  })
  return row
}

/** LOCK: CLOSED -> LOCKED, permanent (ADR-0012). Every earlier period must already be LOCKED. */
export async function lockPeriodTransition(
  tx: TenantTx,
  tenantId: string,
  periodId: string,
  actorUserId: string,
): Promise<FiscalPeriodRow> {
  assertIssuedTenantTx(tx)
  const current = await lockedTarget(tx, tenantId, periodId)
  if (current.status === 'LOCKED') throw refuse('PERIOD_LOCKED', current)
  if (current.status !== 'CLOSED') throw refuse('PERIOD_NOT_CLOSED', current)

  const earlierUnlocked = await countPeriodsWhere(
    tx,
    tenantId,
    sql`period_start < ${current.period_start}::date AND status <> 'LOCKED'`,
  )
  if (earlierUnlocked > 0) {
    throw new PostingError(
      'PERIOD_LOCK_OUT_OF_ORDER',
      `Period ${current.label} cannot lock while an earlier period is not LOCKED.`,
      { period: current.label },
    )
  }

  const updated = await sql<PeriodDbRow>`
    UPDATE fiscal_periods
       SET status = 'LOCKED', locked_at = now(), locked_by = ${actorUserId},
           updated_by = ${actorUserId}, version = ${current.version + 1}
     WHERE tenant_id = ${tenantId} AND id = ${periodId} AND version = ${current.version}
    RETURNING ${PERIOD_COLUMNS}
  `.execute(tx)
  const row = transitioned(updated.rows, current)

  await recordAudit(tx, {
    actorUserId,
    action: 'PERIOD_LOCKED',
    entityType: 'fiscal_periods',
    entityId: periodId,
    beforeJson: { status: 'CLOSED' },
    afterJson: { status: 'LOCKED' },
  })
  return row
}
