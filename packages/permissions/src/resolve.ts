import { selectEffectivePermissionCodes, type TenantTx } from '@finsoft/database'
import { isPermissionCode, type PermissionCode } from './catalog.ts'

/*
 * The permission set a user actually holds, right now, from the database.
 * Rule 18: every permission is checked server-side; the JWT's permission
 * claim (ADR-0009) is an optimism for the client, never the authority.
 *
 * The query body lives in packages/database/src/rbac/resolve-permissions.ts
 * — this package is not on depcruise's kysely-is-allowlisted list
 * (Architecture seat ruling, docs/briefs/M1-R-rbac.md) — this function is
 * the catalogue-aware layer on top of it: a code the database returns that
 * is no longer in the catalogue (a retired permission, still sitting on an
 * old role_permissions row) is dropped rather than surfaced, because
 * ARCHITECTURE §8 is unambiguous that "a permission that is not in the
 * catalogue does not exist".
 */
export async function resolvePermissions(
  tx: TenantTx,
  userId: string,
): Promise<Set<PermissionCode>> {
  const codes = await selectEffectivePermissionCodes(tx, userId)
  return new Set(codes.filter(isPermissionCode))
}
