import { insertSeededRoles, type TenantTx } from '@finsoft/database'
import { SYSTEM_ROLE_SEEDS } from './system-roles.ts'

/**
 * Seed a freshly provisioned tenant's three system roles (Owner, Accountant,
 * Viewer) and their permission grants.
 *
 * Called once, inside the same `withTenant` block that creates the tenant's
 * provisioned owner — see packages/database/src/rbac/seed-roles.ts for why
 * the acting user must already exist and why this is deliberately not
 * idempotent.
 */
export async function seedSystemRoles(tx: TenantTx, tenantId: string): Promise<void> {
  await insertSeededRoles(tx, tenantId, SYSTEM_ROLE_SEEDS)
}
