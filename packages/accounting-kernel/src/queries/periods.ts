import { sql } from 'kysely'
import { assertIssuedTenantTx, type PeriodStatus, type TenantTx } from '@finsoft/database'

/*
 * Lock-free period reads the kernel needs besides the posting gate.
 *
 * The posting gate itself is packages/database's `findPeriodForDate`, which
 * takes the period row FOR SHARE (LOCK_REGISTRY 5b). These two deliberately
 * take NO lock:
 *
 *  - `findPeriodSummaryForDate` fills in the "current open period" a
 *    PERIOD_CLOSED rejection names (journal-voucher.md §10). It runs only on a
 *    path that is about to throw, and a share lock there would be a second,
 *    unregistered row lock for no correctness gain.
 *  - `findPeriodByLabel` resolves a label for a period TRANSITION. A
 *    transition then locks the whole calendar FOR UPDATE (lockTenantCalendar);
 *    taking FOR SHARE on the target first would be a share-to-exclusive
 *    upgrade, which deadlocks two concurrent transitions of the same period.
 *    The transition's optimistic `version` predicate catches a stale read.
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
