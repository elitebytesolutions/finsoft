import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'
import { TenantContext } from '../tenant-context.ts'

/*
 * RBAC queries. ARCHITECTURE §8, migration 008_create_rbac.sql.
 *
 * Query construction is confined to packages/database, the two kernels,
 * packages/reporting and modules/*-/infrastructure — ADR-0013's second import
 * boundary, mechanically enforced by depcruise's `kysely-is-allowlisted`.
 * `packages/permissions` owns the atomic permission catalogue, the system
 * role templates and the guard-facing API, none of which is a Kysely
 * dependency, so the SQL lives here and `packages/permissions` calls it.
 * Recorded as an Architecture seat ruling in docs/briefs/M1-R-rbac.md.
 */

/**
 * Every permission code a user currently, actively holds, in the
 * transaction's tenant.
 *
 * "Actively" means all three of:
 *   - the role assignment (`user_roles`) is not revoked
 *   - the role itself (`roles`) is ACTIVE, not retired
 *   - the permission grant on that role (`role_permissions`) is not revoked
 *
 * Filtered on `ur.tenant_id` explicitly, in addition to RLS underneath —
 * ARCHITECTURE §6's repository-layer habit of not relying on the backstop
 * alone, and what keeps the planner on the tenant_id-leading indexes
 * (`user_roles_user_idx`, `role_permissions_role_idx`).
 *
 * Codes are returned as plain strings, not narrowed to a catalogue type: this
 * package does not know the catalogue. `packages/permissions` is where a code
 * this function returns is checked against what currently exists.
 */
export async function selectEffectivePermissionCodes(
  tx: TenantTx,
  userId: string,
): Promise<string[]> {
  assertIssuedTenantTx(tx)
  const tenantId = TenantContext.require().tenantId

  const rows = await tx
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', (join) =>
      join.onRef('r.tenant_id', '=', 'ur.tenant_id').onRef('r.id', '=', 'ur.role_id'),
    )
    .innerJoin('role_permissions as rp', (join) =>
      join.onRef('rp.tenant_id', '=', 'ur.tenant_id').onRef('rp.role_id', '=', 'ur.role_id'),
    )
    .select('rp.permission_code')
    .distinct()
    .where('ur.tenant_id', '=', tenantId)
    .where('ur.user_id', '=', userId)
    .where('ur.revoked_at', 'is', null)
    .where('r.status', '=', 'ACTIVE')
    .where('rp.revoked_at', 'is', null)
    .execute()

  return rows.map((row) => row.permission_code)
}
