import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'
import { TenantContext } from '../tenant-context.ts'

/*
 * Seeding a tenant's system roles. ARCHITECTURE §8, migration
 * 008_create_rbac.sql. See resolve-permissions.ts for why this lives here
 * rather than in packages/permissions.
 */

/** A role and the permission codes it grants, agnostic of what those codes mean. */
export interface RoleSeed {
  readonly code: string
  readonly name: string
  readonly isSystem: boolean
  readonly permissions: readonly string[]
}

/**
 * Insert `seeds` as roles of `tenantId`, each with its role_permissions rows.
 *
 * Called once, at tenant provisioning, inside the same `withTenant` block
 * that establishes the tenant's provisioned owner — the acting user for
 * `created_by`/`updated_by` is read from `TenantContext`, exactly as
 * `BaseRepository` does, and must already be that owner's id. There is no
 * "no author" case here the way there is for `users`: by the time roles are
 * seeded, the owner who authors them already exists.
 *
 * Deliberately not idempotent. `roles_tenant_code_key` is UNIQUE per tenant,
 * so a second call for the same tenant raises `23505` rather than silently
 * duplicating or silently doing nothing — provisioning calls this exactly
 * once, and a second call is a caller bug worth surfacing loudly.
 */
export async function insertSeededRoles(
  tx: TenantTx,
  tenantId: string,
  seeds: readonly RoleSeed[],
): Promise<void> {
  assertIssuedTenantTx(tx)

  const context = TenantContext.require()
  if (context.tenantId !== tenantId) {
    throw new Error(
      `insertSeededRoles: tenantId argument (${tenantId}) does not match the transaction's ` +
        `tenant (${context.tenantId}). withTenant scopes every write to the context tenant; a ` +
        'caller passing a different id here is a bug, not a request to seed a different tenant.',
    )
  }

  const actor = context.userId
  if (actor === null) {
    throw new Error(
      'insertSeededRoles: no acting user in context. System roles are seeded under the ' +
        "tenant's already-created provisioned owner, never with no author (rule 9).",
    )
  }

  for (const seed of seeds) {
    const role = await tx
      .insertInto('roles')
      .values({
        tenant_id: tenantId,
        code: seed.code,
        name: seed.name,
        is_system: seed.isSystem,
        created_by: actor,
        updated_by: actor,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    if (seed.permissions.length === 0) continue

    await tx
      .insertInto('role_permissions')
      .values(
        seed.permissions.map((code) => ({
          tenant_id: tenantId,
          role_id: role.id,
          permission_code: code,
          created_by: actor,
          updated_by: actor,
        })),
      )
      .execute()
  }
}
