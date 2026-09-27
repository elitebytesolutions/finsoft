import { withGlobal, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  scalarOn,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { resolvePermissions, seedSystemRoles, type PermissionCode } from '@finsoft/permissions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * RBAC: migration 008_create_rbac.sql, packages/permissions.
 *
 * Two kinds of assertion, in the two sections below:
 *
 *   1. Exact-ACL grants — "a privilege statement's success is not evidence
 *      that it did anything" (migration 005's lesson). These ask PostgreSQL
 *      the effective question with has_table_privilege/has_column_privilege
 *      rather than reading GRANT statements back out of the migration file.
 *
 *   2. resolvePermissions/seedSystemRoles, exercised against a real tenant —
 *      the catalogue-to-database round trip a unit test over the TypeScript
 *      alone cannot prove.
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

/* ================================================================ *
 * 1. Exact-ACL grants
 * ================================================================ */

describe('what finsoft_app and readonly_support may do to the RBAC tables', () => {
  const may = (role: string, table: string, priv: string): Promise<boolean | undefined> =>
    withGlobal((tx) =>
      scalarOn<boolean>(tx, 'select has_table_privilege($1, $2, $3)', [role, table, priv]),
    )

  const mayColumn = (
    role: string,
    table: string,
    column: string,
    priv: string,
  ): Promise<boolean | undefined> =>
    withGlobal((tx) =>
      scalarOn<boolean>(tx, 'select has_column_privilege($1, $2, $3, $4)', [
        role,
        table,
        column,
        priv,
      ]),
    )

  for (const table of ['roles', 'role_permissions', 'user_roles']) {
    it(`holds no table-wide UPDATE on ${table}`, async () => {
      expect(await may('finsoft_app', table, 'UPDATE')).toBe(false)
    })

    it(`holds no table-wide INSERT on ${table}`, async () => {
      // Table-wide INSERT would let a caller name id/created_at/version and
      // override every DEFAULT (migration 005's lesson, restated here).
      expect(await may('finsoft_app', table, 'INSERT')).toBe(false)
    })

    it(`holds no DELETE on ${table}`, async () => {
      expect(await may('finsoft_app', table, 'DELETE')).toBe(false)
    })

    it(`gives readonly_support SELECT and nothing else on ${table}`, async () => {
      expect(await may('readonly_support', table, 'SELECT')).toBe(true)
      expect(await may('readonly_support', table, 'INSERT')).toBe(false)
      expect(await may('readonly_support', table, 'UPDATE')).toBe(false)
      expect(await may('readonly_support', table, 'DELETE')).toBe(false)
    })
  }

  it('cannot rename a role into a system one, or change tenant/authorship', async () => {
    expect(await mayColumn('finsoft_app', 'roles', 'code', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'roles', 'is_system', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'roles', 'tenant_id', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'roles', 'created_by', 'UPDATE')).toBe(false)

    expect(await mayColumn('finsoft_app', 'roles', 'name', 'UPDATE')).toBe(true)
    expect(await mayColumn('finsoft_app', 'roles', 'status', 'UPDATE')).toBe(true)
  })

  it('can only revoke a permission grant, never rewrite what it grants', async () => {
    expect(await mayColumn('finsoft_app', 'role_permissions', 'role_id', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'role_permissions', 'permission_code', 'UPDATE')).toBe(
      false,
    )
    expect(await mayColumn('finsoft_app', 'role_permissions', 'revoked_at', 'UPDATE')).toBe(true)
    expect(await mayColumn('finsoft_app', 'role_permissions', 'revoked_by', 'UPDATE')).toBe(true)
  })

  it('can only revoke a role assignment, never rewrite who or what it assigns', async () => {
    expect(await mayColumn('finsoft_app', 'user_roles', 'user_id', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'user_roles', 'role_id', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'user_roles', 'revoked_at', 'UPDATE')).toBe(true)
    expect(await mayColumn('finsoft_app', 'user_roles', 'revoked_by', 'UPDATE')).toBe(true)
  })
})

/* ================================================================ *
 * 2. seedSystemRoles / resolvePermissions
 * ================================================================ */

async function seedTenant(): Promise<TenantFixture> {
  const tenant = await createTenantFixture('RBAC')
  await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant((tx) => seedSystemRoles(tx, tenant.tenantId)),
  )
  return tenant
}

/** Assign `role` (by code) to `userId`, as the tenant's owner. */
async function assignRole(tenant: TenantFixture, userId: string, roleCode: string): Promise<void> {
  await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant(async (tx) => {
      const role = await tx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', tenant.tenantId)
        .where('code', '=', roleCode)
        .executeTakeFirstOrThrow()

      await tx
        .insertInto('user_roles')
        .values({
          tenant_id: tenant.tenantId,
          user_id: userId,
          role_id: role.id,
          created_by: tenant.ownerId,
          updated_by: tenant.ownerId,
        })
        .execute()
    }),
  )
}

async function createUser(tenant: TenantFixture): Promise<string> {
  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant(async (tx) => {
      const row = await tx
        .insertInto('users')
        .values({
          tenant_id: tenant.tenantId,
          email: `member.${unique()}@example.test`,
          full_name: 'Member',
          status: 'INVITED',
          created_by: tenant.ownerId,
          updated_by: tenant.ownerId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    }),
  )
}

async function permissionsOf(tenant: TenantFixture, userId: string): Promise<Set<PermissionCode>> {
  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant((tx) => resolvePermissions(tx, userId)),
  )
}

async function versionOf(tenant: TenantFixture, userId: string): Promise<number> {
  const row = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant((tx) =>
      tx
        .selectFrom('users')
        .select('version')
        .where('tenant_id', '=', tenant.tenantId)
        .where('id', '=', userId)
        .executeTakeFirstOrThrow(),
    ),
  )
  return row.version
}

describe('seedSystemRoles', () => {
  it('creates exactly Owner, Accountant and Viewer, all is_system', async () => {
    const tenant = await seedTenant()

    const roles = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        tx
          .selectFrom('roles')
          .select(['code', 'is_system', 'status'])
          .where('tenant_id', '=', tenant.tenantId)
          .execute(),
      ),
    )

    expect(roles.map((r) => r.code).sort()).toEqual(['accountant', 'owner', 'viewer'])
    expect(roles.every((r) => r.is_system)).toBe(true)
    expect(roles.every((r) => r.status === 'ACTIVE')).toBe(true)
  })

  it('rejects a second call for the same tenant (23505, not a silent duplicate)', async () => {
    const tenant = await seedTenant()

    const attempt = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) => seedSystemRoles(tx, tenant.tenantId)),
    )

    await expect(attempt).rejects.toMatchObject({ code: '23505' })
  })

  it('gives Owner every MVP permission, Accountant all but admin.user_manage, Viewer three read-only ones', async () => {
    const tenant = await seedTenant()
    const [owner, accountant, viewer] = await Promise.all([
      createUser(tenant),
      createUser(tenant),
      createUser(tenant),
    ])
    await assignRole(tenant, owner, 'owner')
    await assignRole(tenant, accountant, 'accountant')
    await assignRole(tenant, viewer, 'viewer')

    const ownerPerms = await permissionsOf(tenant, owner)
    const accountantPerms = await permissionsOf(tenant, accountant)
    const viewerPerms = await permissionsOf(tenant, viewer)

    expect([...ownerPerms].sort()).toEqual(
      [
        'admin.user_manage',
        'audit.view',
        'customer.create',
        'customer.view',
        'invoice.create',
        'invoice.post',
        'payment.receive',
        'report.financial',
        'voucher.post',
        'voucher.reverse',
        'voucher.view',
      ].sort(),
    )

    expect(accountantPerms.has('admin.user_manage')).toBe(false)
    expect([...accountantPerms].sort()).toEqual(
      [...ownerPerms].filter((c) => c !== 'admin.user_manage').sort(),
    )

    expect([...viewerPerms].sort()).toEqual(['customer.view', 'report.financial', 'voucher.view'])
    expect(viewerPerms.has('voucher.post')).toBe(false)
  })

  it('gives a user with no role assignment an empty set, not an error', async () => {
    const tenant = await seedTenant()
    const nobody = await createUser(tenant)
    expect(await permissionsOf(tenant, nobody)).toEqual(new Set())
  })
})

describe('revocation removes the effective grant', () => {
  it('excludes a revoked user_roles assignment', async () => {
    const tenant = await seedTenant()
    const user = await createUser(tenant)
    await assignRole(tenant, user, 'viewer')
    expect(await permissionsOf(tenant, user)).not.toEqual(new Set())

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        const assignment = await tx
          .selectFrom('user_roles')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('user_id', '=', user)
          .executeTakeFirstOrThrow()

        await tx
          .updateTable('user_roles')
          .set({ revoked_at: new Date(), revoked_by: tenant.ownerId, version: 1 })
          .where('tenant_id', '=', tenant.tenantId)
          .where('id', '=', assignment.id)
          .execute()
      }),
    )

    expect(await permissionsOf(tenant, user)).toEqual(new Set())
  })

  it('excludes a revoked role_permissions grant for every current holder', async () => {
    const tenant = await seedTenant()
    const user = await createUser(tenant)
    await assignRole(tenant, user, 'viewer')
    expect((await permissionsOf(tenant, user)).has('customer.view')).toBe(true)

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        const role = await tx
          .selectFrom('roles')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'viewer')
          .executeTakeFirstOrThrow()

        const grant = await tx
          .selectFrom('role_permissions')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('role_id', '=', role.id)
          .where('permission_code', '=', 'customer.view')
          .executeTakeFirstOrThrow()

        await tx
          .updateTable('role_permissions')
          .set({ revoked_at: new Date(), revoked_by: tenant.ownerId, version: 1 })
          .where('tenant_id', '=', tenant.tenantId)
          .where('id', '=', grant.id)
          .execute()
      }),
    )

    expect((await permissionsOf(tenant, user)).has('customer.view')).toBe(false)
  })
})

describe('permission_version cascade (bumps users.version)', () => {
  it('bumps the affected user on a role grant', async () => {
    const tenant = await seedTenant()
    const user = await createUser(tenant)
    const before = await versionOf(tenant, user)

    await assignRole(tenant, user, 'viewer')

    expect(await versionOf(tenant, user)).toBeGreaterThan(before)
  })

  it('bumps the affected user on a role revocation', async () => {
    const tenant = await seedTenant()
    const user = await createUser(tenant)
    await assignRole(tenant, user, 'viewer')
    const afterGrant = await versionOf(tenant, user)

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        const assignment = await tx
          .selectFrom('user_roles')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('user_id', '=', user)
          .executeTakeFirstOrThrow()

        await tx
          .updateTable('user_roles')
          .set({ revoked_at: new Date(), revoked_by: tenant.ownerId, version: 1 })
          .where('tenant_id', '=', tenant.tenantId)
          .where('id', '=', assignment.id)
          .execute()
      }),
    )

    expect(await versionOf(tenant, user)).toBeGreaterThan(afterGrant)
  })

  it('bumps every current holder of a role when one of its permissions is revoked', async () => {
    const tenant = await seedTenant()
    const [alice, bob] = await Promise.all([createUser(tenant), createUser(tenant)])
    await assignRole(tenant, alice, 'viewer')
    await assignRole(tenant, bob, 'viewer')

    const aliceBefore = await versionOf(tenant, alice)
    const bobBefore = await versionOf(tenant, bob)

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        const role = await tx
          .selectFrom('roles')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'viewer')
          .executeTakeFirstOrThrow()

        const grant = await tx
          .selectFrom('role_permissions')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('role_id', '=', role.id)
          .where('permission_code', '=', 'voucher.view')
          .executeTakeFirstOrThrow()

        await tx
          .updateTable('role_permissions')
          .set({ revoked_at: new Date(), revoked_by: tenant.ownerId, version: 1 })
          .where('tenant_id', '=', tenant.tenantId)
          .where('id', '=', grant.id)
          .execute()
      }),
    )

    expect(await versionOf(tenant, alice)).toBeGreaterThan(aliceBefore)
    expect(await versionOf(tenant, bob)).toBeGreaterThan(bobBefore)
  })

  it('does not corrupt the provisioned owner row, whose created_by is NULL', async () => {
    // The cascade must never write users.updated_by — measured regression
    // for the defect this migration's header documents: an earlier draft
    // stamped updated_by on the cascade and violated
    // users_authorship_pair_or_neither the first time the affected user was
    // a tenant's provisioned owner.
    const tenant = await seedTenant()
    await assignRole(tenant, tenant.ownerId, 'owner')
    expect((await permissionsOf(tenant, tenant.ownerId)).has('admin.user_manage')).toBe(true)
  })
})
