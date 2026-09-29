import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'

/*
 * The one tenant setting the posting engine needs that already exists:
 * `tenants.timezone` (migration 001), used to compute "today" for the
 * future-date check and the reversal date rule (periods.md §5, reversal.md
 * §4). `tenants` carries no RLS (it is the one global table login itself
 * must read before a tenant context exists — migration 001's own header),
 * so this is a plain read on the TenantTx, not a `withGlobal` block.
 *
 * `fiscal_year_start_month` is NOT a column on `tenants` — migration 001 is
 * a released file this lane does not own (ADR-0013, forward-only), and the
 * MVP has exactly one fiscal year (periods.md §6). `DEFAULT_FISCAL_YEAR_
 * START_MONTH` below is the hardcoded default every M2 call site uses;
 * making it a real per-tenant column is Wave 2 remainder work, flagged in
 * the M2-A brief as an OBSERVED item rather than worked around here.
 */

export const DEFAULT_FISCAL_YEAR_START_MONTH = 7

export async function findTenantTimezone(tx: TenantTx, tenantId: string): Promise<string> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('tenants')
    .select('timezone')
    .where('id', '=', tenantId)
    .executeTakeFirst()
  if (!row) {
    throw new Error(`findTenantTimezone: tenant ${tenantId} does not exist.`)
  }
  return row.timezone
}
