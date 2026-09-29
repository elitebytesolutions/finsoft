/*
 * `@finsoft/database/provisioning` — a separate, narrow entrypoint.
 *
 * `createAuditChainAnchor` is not exported from the package root
 * (`@finsoft/database`, index.ts). It is a privileged, one-time-per-tenant
 * operation — the seq=0 anchor, written under the terminal advisory lock
 * (LOCK_REGISTRY.md position 6), in the SAME transaction as the tenant's own
 * `tenants` row, before that tenant is generally visible (ADR-0020 §5). It
 * has exactly one legitimate caller: whatever creates a tenant. Exporting it
 * from the same surface as `recordAudit`/`withTenant`/`listAuditEvents`
 * invites it to be called from an ordinary request handler "just to be
 * safe" — which would take the terminal lock and write a row outside the
 * one place ADR-0020 §5 sanctions it.
 *
 * `packages/database/src/testing/harness.ts`'s `createTenantFixture` imports
 * directly from `./audit/anchor.ts`, not through this file — it is inside
 * the package, not a consumer of its public surface.
 *
 * M1-X, Council S3: `tools/seed/demo-tenants.mjs` is the first real
 * (non-test) caller. Every query body it needs lives here, as a named
 * export taking parameters and returning rows or ids — Architecture seat
 * ruling (docs/briefs/M1-R-rbac.md, extended here the same way): this
 * package holds no business rules. It does not decide idempotency (create
 * vs. reuse), does not resolve a password, and does not know which role
 * codes exist beyond what its caller passes in — it establishes tenant
 * context and runs the query, nothing more. The seed script owns every
 * decision; this file owns the mechanism.
 */

import { sql } from 'kysely'
import { createAuditChainAnchor } from './audit/anchor.ts'
import { insertSeededRoles, type RoleSeed } from './rbac/seed-roles.ts'
import { TenantContext } from './tenant-context.ts'
import { withGlobal, withTenant } from './transaction.ts'

export { createAuditChainAnchor }

export interface ProvisioningTenantRow {
  readonly id: string
  readonly status: string
}

/** A tenant by its code, or undefined if none exists. `tenants` is global — no tenant context needed. */
export async function findTenantByCode(code: string): Promise<ProvisioningTenantRow | undefined> {
  return withGlobal((tx) =>
    tx.selectFrom('tenants').select(['id', 'status']).where('code', '=', code).executeTakeFirst(),
  )
}

/**
 * Every tenant code currently in the database — for a pre-flight safety
 * check (M1-X, Council S1), never for anything scoped to one tenant. Not a
 * tenant-owned read: `tenants` itself has no RLS (ADR-0004:77 / ADR-0023 §1).
 */
export async function listAllTenantCodes(): Promise<readonly string[]> {
  const rows = await withGlobal((tx) => tx.selectFrom('tenants').select('code').execute())
  return rows.map((row) => row.code)
}

/**
 * Create a tenant and its audit chain anchor, in the SAME transaction
 * (ADR-0020 §5). Returns the new tenant's id. Does not check whether a
 * tenant with this code already exists — `tenants.code`'s own uniqueness
 * constraint is the backstop; the caller decides whether to check first.
 */
export async function createTenant(code: string, name: string): Promise<string> {
  return withGlobal(async (tx) => {
    const row = await tx
      .insertInto('tenants')
      .values({ code, name })
      .returning('id')
      .executeTakeFirstOrThrow()
    await createAuditChainAnchor(tx, row.id)
    return row.id
  })
}

export interface ProvisionedOwnerRow {
  readonly id: string
  readonly status: string
}

/**
 * The tenant's provisioned owner — the one row per tenant with
 * `created_by IS NULL` (migration 002's partial unique index) — or
 * undefined if none exists yet.
 */
export async function findProvisionedOwner(
  tenantId: string,
): Promise<ProvisionedOwnerRow | undefined> {
  return TenantContext.run({ tenantId, userId: null }, () =>
    withTenant((tx) =>
      tx
        .selectFrom('users')
        .select(['id', 'status'])
        .where('tenant_id', '=', tenantId)
        .where('created_by', 'is', null)
        .executeTakeFirst(),
    ),
  )
}

/**
 * Create the tenant's provisioned owner (the one row whose `created_by`/
 * `updated_by` stay NULL), seed the system roles authored by that owner
 * (skipped if the tenant already has any role — `insertSeededRoles` is
 * documented as deliberately non-idempotent), and assign the named owner
 * role. All in ONE transaction: if any step fails, none of it commits, so a
 * retry never finds a half-provisioned tenant. `roleSeeds` and `ownerRoleCode`
 * are supplied by the caller — this package does not know the RBAC catalogue
 * (`packages/permissions`'s job).
 */
export async function createProvisionedOwnerWithRoles(
  tenantId: string,
  email: string,
  fullName: string,
  passwordHash: string,
  roleSeeds: readonly RoleSeed[],
  ownerRoleCode: string,
): Promise<string> {
  return TenantContext.run({ tenantId, userId: null }, () =>
    withTenant(async (tx) => {
      const owner = await tx
        .insertInto('users')
        .values({
          tenant_id: tenantId,
          email,
          full_name: fullName,
          status: 'ACTIVE',
          password_hash: passwordHash,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      const anyRole = await tx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst()

      if (!anyRole) {
        await TenantContext.run({ tenantId, userId: owner.id }, () =>
          insertSeededRoles(tx, tenantId, roleSeeds),
        )
      }

      const ownerRole = await tx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('code', '=', ownerRoleCode)
        .executeTakeFirstOrThrow()

      await tx
        .insertInto('user_roles')
        .values({
          tenant_id: tenantId,
          user_id: owner.id,
          role_id: ownerRole.id,
          created_by: owner.id,
          updated_by: owner.id,
        })
        .execute()

      return owner.id
    }),
  )
}

export interface ProvisioningMemberRow {
  readonly id: string
}

/** A non-owner member by (tenant, email), or undefined if none exists. Case-insensitive, matching `users_tenant_email_key`. */
export async function findMemberByEmail(
  tenantId: string,
  actorUserId: string,
  email: string,
): Promise<ProvisioningMemberRow | undefined> {
  return TenantContext.run({ tenantId, userId: actorUserId }, () =>
    withTenant((tx) =>
      tx
        .selectFrom('users')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where(sql<boolean>`lower(email) = ${email.toLowerCase()}`)
        .executeTakeFirst(),
    ),
  )
}

/**
 * Create a non-owner member (`created_by`/`updated_by` = `actorUserId`) and
 * assign it the named role, in one transaction.
 */
export async function createMemberWithRole(
  tenantId: string,
  actorUserId: string,
  email: string,
  fullName: string,
  passwordHash: string,
  roleCode: string,
): Promise<void> {
  await TenantContext.run({ tenantId, userId: actorUserId }, () =>
    withTenant(async (tx) => {
      const user = await tx
        .insertInto('users')
        .values({
          tenant_id: tenantId,
          email,
          full_name: fullName,
          status: 'ACTIVE',
          password_hash: passwordHash,
          created_by: actorUserId,
          updated_by: actorUserId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      const role = await tx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('code', '=', roleCode)
        .executeTakeFirstOrThrow()

      await tx
        .insertInto('user_roles')
        .values({
          tenant_id: tenantId,
          user_id: user.id,
          role_id: role.id,
          created_by: actorUserId,
          updated_by: actorUserId,
        })
        .execute()
    }),
  )
}
