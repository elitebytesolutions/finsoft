import { withGlobal, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  scalarOn,
  sqlstate,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { resolvePermissions, seedSystemRoles, type PermissionCode } from '@finsoft/permissions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * RBAC: migration 008_create_rbac.sql, packages/permissions.
 *
 * Three kinds of assertion, in the sections below:
 *
 *   1. EXACT-SET ACL grants (DB-C4) — "a privilege statement's success is
 *      not evidence that it did anything" (migration 005's lesson). Rather
 *      than spot-checking a few named columns, this enumerates every column
 *      of every table and every relevant grantee (finsoft_app,
 *      readonly_support, PUBLIC) and asserts the LITERAL set PostgreSQL
 *      reports — has_column_privilege for column grants, the exploded
 *      relacl for table-level grants — matches what the migration intends,
 *      column by column.
 *
 *   2. Transition-trigger negatives — every rule the migration's comments
 *      claim (revocation is terminal, identity is immutable, version must
 *      increase, cross-tenant authorship is impossible) reproduced as a
 *      failing write, not merely asserted in prose.
 *
 *   3. seedSystemRoles/resolvePermissions, exercised against a real tenant —
 *      the catalogue-to-database round trip a unit test over the TypeScript
 *      alone cannot prove — including the permission_version cascade and
 *      SEC-C4's user-status gate.
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

/* ================================================================ *
 * 1. Exact-set ACL grants (DB-C4)
 * ================================================================ */

const TABLES = ['roles', 'role_permissions', 'user_roles'] as const

async function columnsOf(table: string): Promise<string[]> {
  const rows = await withGlobal((tx) =>
    rawOn<{ column_name: string }>(
      tx,
      `select a.attname as column_name
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
        where c.relname = $1 and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [table],
    ),
  )
  return rows.map((r) => r.column_name)
}

async function mayColumn(
  role: string,
  table: string,
  column: string,
  priv: string,
): Promise<boolean> {
  const value = await withGlobal((tx) =>
    scalarOn<boolean>(tx, 'select has_column_privilege($1, $2, $3, $4)', [
      role,
      table,
      column,
      priv,
    ]),
  )
  return value === true
}

/** The exact set of columns `role` may exercise `priv` on, computed column by column. */
async function columnPrivilegeSet(role: string, table: string, priv: string): Promise<Set<string>> {
  const columns = await columnsOf(table)
  const granted = await Promise.all(columns.map((c) => mayColumn(role, table, c, priv)))
  return new Set(columns.filter((_, i) => granted[i]))
}

/**
 * The exact (grantee, privilege) set PostgreSQL's own table-level ACL
 * reports, straight from pg_class.relacl — not has_table_privilege, which
 * answers "may this role do X" but not "who exactly holds a grant".
 */
async function tableAcl(table: string): Promise<Set<string>> {
  const rows = await withGlobal((tx) =>
    rawOn<{ grantee: string; privilege_type: string }>(
      tx,
      `select case when acl.grantee = 0 then 'PUBLIC' else acl.grantee::regrole::text end as grantee,
              acl.privilege_type
         from pg_class c
        cross join lateral aclexplode(c.relacl) acl
        where c.relname = $1`,
      [table],
    ),
  )
  return new Set(rows.map((r) => `${r.grantee}:${r.privilege_type}`))
}

const grantsOf = (acl: Set<string>, grantee: string): string[] =>
  [...acl]
    .filter((entry) => entry.startsWith(`${grantee}:`))
    .map((entry) => entry.slice(grantee.length + 1))
    .sort()

/**
 * PUBLIC's exact column-level ACL, read directly from pg_attribute.attacl —
 * not has_column_privilege, which does not accept 'PUBLIC' as a role
 * argument (it names an actual role, not the ACL pseudo-role keyword).
 */
async function publicColumnGrants(table: string): Promise<string[]> {
  const rows = await withGlobal((tx) =>
    rawOn<{ column_name: string; privilege_type: string }>(
      tx,
      `select a.attname as column_name, acl.privilege_type
         from (
           select att.attname, att.attacl
             from pg_attribute att
             join pg_class c on c.oid = att.attrelid
            where c.relname = $1
              and att.attnum > 0
              and not att.attisdropped
              -- Filtered here, BEFORE the lateral join: aclexplode raises on
              -- a null argument, and a WHERE clause at the outer level would
              -- filter the JOIN's OUTPUT, not gate whether it runs.
              and att.attacl is not null
         ) a
        cross join lateral aclexplode(a.attacl) acl
        where acl.grantee = 0`,
      [table],
    ),
  )
  return rows.map((r) => `${r.column_name}:${r.privilege_type}`)
}

/** Columns every table in this migration carries. INSERT/UPDATE sets below name a subset of these. */
const MANDATORY = [
  'id',
  'tenant_id',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'version',
]

const EXPECTED = {
  roles: {
    columns: [...MANDATORY, 'code', 'name', 'is_system', 'status'].sort(),
    insert: ['tenant_id', 'code', 'name', 'is_system', 'created_by', 'updated_by'],
    update: ['name', 'status', 'updated_at', 'updated_by', 'version'],
  },
  role_permissions: {
    columns: [...MANDATORY, 'role_id', 'permission_code', 'revoked_at', 'revoked_by'].sort(),
    insert: ['tenant_id', 'role_id', 'permission_code', 'created_by', 'updated_by'],
    update: ['revoked_at', 'revoked_by', 'updated_at', 'updated_by', 'version'],
  },
  user_roles: {
    columns: [...MANDATORY, 'user_id', 'role_id', 'revoked_at', 'revoked_by'].sort(),
    insert: ['tenant_id', 'user_id', 'role_id', 'created_by', 'updated_by'],
    update: ['revoked_at', 'revoked_by', 'updated_at', 'updated_by', 'version'],
  },
} as const

describe('exact-set ACL on the RBAC tables (DB-C4)', () => {
  for (const table of TABLES) {
    const spec = EXPECTED[table]

    it(`${table}: has exactly the migration's column set`, async () => {
      expect((await columnsOf(table)).sort()).toEqual(spec.columns)
    })

    it(`${table}: finsoft_app may INSERT exactly the DEFAULT-excluded columns`, async () => {
      const actual = await columnPrivilegeSet('finsoft_app', table, 'INSERT')
      expect([...actual].sort()).toEqual([...spec.insert].sort())
      // Named explicitly, because these are the columns a caller must never
      // be able to smuggle a value into: nothing is born revoked, and id,
      // created_at, updated_at, version and (for roles) status are the
      // database's to default.
      for (const forbidden of ['id', 'created_at', 'updated_at', 'version']) {
        expect(actual.has(forbidden), `${table}.${forbidden} must not be INSERT-able`).toBe(false)
      }
      if (spec.columns.includes('revoked_at')) {
        expect(actual.has('revoked_at'), `${table}.revoked_at must not be INSERT-able`).toBe(false)
        expect(actual.has('revoked_by'), `${table}.revoked_by must not be INSERT-able`).toBe(false)
      }
    })

    it(`${table}: finsoft_app may UPDATE exactly the mutable columns`, async () => {
      const actual = await columnPrivilegeSet('finsoft_app', table, 'UPDATE')
      expect([...actual].sort()).toEqual([...spec.update].sort())
    })

    it(`${table}: finsoft_app may SELECT every column, INSERT/UPDATE nothing else`, async () => {
      const select = await columnPrivilegeSet('finsoft_app', table, 'SELECT')
      expect([...select].sort()).toEqual(spec.columns)
    })

    it(`${table}: finsoft_app holds no table-level DELETE (rule 4)`, async () => {
      // DELETE has no column granularity in PostgreSQL's ACL model — it is
      // asked of has_table_privilege, never has_column_privilege, which
      // rejects DELETE as an unrecognized column privilege type outright.
      const granted = await withGlobal((tx) =>
        scalarOn<boolean>(tx, 'select has_table_privilege($1, $2, $3)', [
          'finsoft_app',
          table,
          'DELETE',
        ]),
      )
      expect(granted).toBe(false)
    })

    it(`${table}: readonly_support may SELECT every column and nothing else`, async () => {
      const select = await columnPrivilegeSet('readonly_support', table, 'SELECT')
      expect([...select].sort()).toEqual(spec.columns)

      for (const priv of ['INSERT', 'UPDATE']) {
        const set = await columnPrivilegeSet('readonly_support', table, priv)
        expect([...set], `readonly_support ${priv} on ${table}`).toEqual([])
      }

      const del = await withGlobal((tx) =>
        scalarOn<boolean>(tx, 'select has_table_privilege($1, $2, $3)', [
          'readonly_support',
          table,
          'DELETE',
        ]),
      )
      expect(del).toBe(false)
    })

    it(`${table}: PUBLIC holds no column-level grant at all`, async () => {
      // has_column_privilege does not accept the literal 'PUBLIC' as a role
      // argument (it looks up an actual role by that name); read
      // pg_attribute.attacl directly instead — see publicColumnGrants.
      expect(await publicColumnGrants(table)).toEqual([])
    })

    it(`${table}: the table-level ACL grants finsoft_app and readonly_support SELECT only, nothing to PUBLIC`, async () => {
      // finsoft_migration (the owning, BYPASSRLS migration role) also
      // appears in relacl once ALTER DEFAULT PRIVILEGES is in play — that is
      // the owner's OWN, expected full grant (ADR-0004:59), not asserted
      // here column by column since it is not this migration's concern.
      // What matters, exactly, is the other two grantees and the absence of
      // PUBLIC.
      const acl = await tableAcl(table)
      expect(grantsOf(acl, 'finsoft_app')).toEqual(['SELECT'])
      expect(grantsOf(acl, 'readonly_support')).toEqual(['SELECT'])
      expect(grantsOf(acl, 'PUBLIC')).toEqual([])
    })
  }
})

/* ================================================================ *
 * 2. Transition-trigger negatives
 * ================================================================ */

describe('transition enforcement', () => {
  async function seedForTransitionTests(): Promise<{
    tenant: TenantFixture
    roleId: string
    userId: string
    assignmentId: string
    grantId: string
  }> {
    const tenant = await createTenantFixture('RBACT')
    return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        await seedSystemRoles(tx, tenant.tenantId)

        const role = await tx
          .selectFrom('roles')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'viewer')
          .executeTakeFirstOrThrow()

        const user = await tx
          .insertInto('users')
          .values({
            tenant_id: tenant.tenantId,
            email: `transition.${unique()}@example.test`,
            full_name: 'Transition Subject',
            status: 'ACTIVE',
            password_hash: 'test-hash-not-real',
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()

        const assignment = await tx
          .insertInto('user_roles')
          .values({
            tenant_id: tenant.tenantId,
            user_id: user.id,
            role_id: role.id,
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()

        const grant = await tx
          .selectFrom('role_permissions')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('role_id', '=', role.id)
          .where('permission_code', '=', 'customer.view')
          .executeTakeFirstOrThrow()

        return {
          tenant,
          roleId: role.id,
          userId: user.id,
          assignmentId: assignment.id,
          grantId: grant.id,
        }
      }),
    )
  }

  it('roles: rejects renaming a role into a different code', async () => {
    const { tenant, roleId } = await seedForTransitionTests()
    const attempt = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) => rawOn(tx, `update roles set code = 'hijacked' where id = $1`, [roleId])),
    )
    await expect(attempt).rejects.toSatisfy((e: unknown) => sqlstate(e) === '42501')
  })

  it('roles: version must increase on every update', async () => {
    const { tenant, roleId } = await seedForTransitionTests()
    const attempt = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn(
          tx,
          `update roles set status = 'INACTIVE', updated_by = $2, version = version where id = $1`,
          [roleId, tenant.ownerId],
        ),
      ),
    )
    await expect(attempt).rejects.toMatchObject({
      message: expect.stringContaining('version must increase'),
    })
  })

  it('role_permissions: a revocation cannot be cleared', async () => {
    const { tenant, grantId } = await seedForTransitionTests()
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        tx
          .updateTable('role_permissions')
          .set({ revoked_at: new Date(), revoked_by: tenant.ownerId, version: 1 })
          .where('id', '=', grantId)
          .execute(),
      ),
    )

    const attempt = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn(
          tx,
          `update role_permissions set revoked_at = NULL, revoked_by = NULL, version = 2 where id = $1`,
          [grantId],
        ),
      ),
    )
    await expect(attempt).rejects.toMatchObject({
      message: expect.stringContaining('revocation is terminal'),
    })
  })

  it('role_permissions: identity columns (role_id, permission_code) are immutable', async () => {
    /*
     * finsoft_app holds no UPDATE grant on permission_code or role_id at all
     * (DB-C4's exact-ACL section) — the grant's absence is the primary
     * defence here, and the attempt never reaches
     * role_permissions_enforce_transition's own identity check. 42501 is
     * therefore the correct, and stronger, observed failure: unlike a
     * trigger, a column that was never granted cannot be reached by any
     * statement finsoft_app issues, reviewed or not.
     */
    const { tenant, grantId } = await seedForTransitionTests()
    const attempt = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn(
          tx,
          `update role_permissions set permission_code = 'admin.user_manage', version = version + 1 where id = $1`,
          [grantId],
        ),
      ),
    )
    await expect(attempt).rejects.toSatisfy((e: unknown) => sqlstate(e) === '42501')
  })

  it('user_roles: a revocation cannot be re-dated', async () => {
    const { tenant, assignmentId } = await seedForTransitionTests()
    const firstRevoke = new Date(Date.now() - 60_000)
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        tx
          .updateTable('user_roles')
          .set({ revoked_at: firstRevoke, revoked_by: tenant.ownerId, version: 1 })
          .where('id', '=', assignmentId)
          .execute(),
      ),
    )

    const attempt = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn(tx, `update user_roles set revoked_at = now(), version = 2 where id = $1`, [
          assignmentId,
        ]),
      ),
    )
    await expect(attempt).rejects.toMatchObject({
      message: expect.stringContaining('revocation is terminal'),
    })
  })

  it('user_roles: identity columns (user_id, role_id) are immutable', async () => {
    // Same shape as the role_permissions case above: user_id/role_id have no
    // UPDATE grant to finsoft_app at all, so 42501 (grant absence) is the
    // observed, and stronger, defence — the statement never reaches
    // user_roles_enforce_transition's own identity check.
    const { tenant, assignmentId } = await seedForTransitionTests()
    const other = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        tx
          .insertInto('users')
          .values({
            tenant_id: tenant.tenantId,
            email: `other.${unique()}@example.test`,
            full_name: 'Other',
            status: 'INVITED',
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      ),
    )

    const attempt = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn(tx, `update user_roles set user_id = $2, version = version + 1 where id = $1`, [
          assignmentId,
          other.id,
        ]),
      ),
    )
    await expect(attempt).rejects.toSatisfy((e: unknown) => sqlstate(e) === '42501')
  })

  it('user_roles: revoked_by must be a user of the SAME tenant (composite FK)', async () => {
    const { tenant, assignmentId } = await seedForTransitionTests()
    const foreignTenant = await createTenantFixture('RBACX')

    const attempt = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn(
          tx,
          `update user_roles set revoked_at = now(), revoked_by = $2, version = version + 1 where id = $1`,
          [assignmentId, foreignTenant.ownerId],
        ),
      ),
    )
    await expect(attempt).rejects.toSatisfy((e: unknown) => sqlstate(e) === '23503')
  })
})

/* ================================================================ *
 * 3. seedSystemRoles / resolvePermissions
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

/**
 * ACTIVE by default, with a real password_hash — SEC-C4 requires an ACTIVE
 * user for the positive permission-resolution case, and
 * `users_active_requires_password` requires the hash to go with it. Pass an
 * explicit status to build the negative fixtures.
 */
async function createUser(
  tenant: TenantFixture,
  options: { status?: string } = {},
): Promise<string> {
  const status = options.status ?? 'ACTIVE'
  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant(async (tx) => {
      const row = await tx
        .insertInto('users')
        .values({
          tenant_id: tenant.tenantId,
          email: `member.${unique()}@example.test`,
          full_name: 'Member',
          status,
          password_hash: status === 'ACTIVE' ? 'test-hash-not-real' : null,
          created_by: tenant.ownerId,
          updated_by: tenant.ownerId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    }),
  )
}

/** Activates the tenant's provisioned owner in place, without touching the shared harness. */
async function activateOwner(tenant: TenantFixture): Promise<void> {
  await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant((tx) =>
      tx
        .updateTable('users')
        .set({ status: 'ACTIVE', password_hash: 'test-hash-not-real', version: 1 })
        .where('tenant_id', '=', tenant.tenantId)
        .where('id', '=', tenant.ownerId)
        .execute(),
    ),
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

  it('fails loudly if the tenantId argument does not match the transaction tenant', async () => {
    // DB minor. withTenant scopes every write to TenantContext's tenant; a
    // caller passing a DIFFERENT tenantId here is a bug — this must throw
    // rather than silently seeding the wrong tenant (or the context tenant)
    // depending on which one the query construction happened to use.
    const tenant = await createTenantFixture('RBACY')
    const other = await createTenantFixture('RBACZ')

    const attempt = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) => seedSystemRoles(tx, other.tenantId)),
    )

    await expect(attempt).rejects.toThrow(/does not match the transaction's tenant/)
  })

  it('gives Owner every MVP permission, Accountant all but admin.user_manage and period.reopen, Viewer five read-only ones', async () => {
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
        'account.view',
        'admin.user_manage',
        'audit.view',
        'customer.create',
        'customer.view',
        'invoice.create',
        'invoice.post',
        'payment.receive',
        'period.close',
        'period.reopen',
        'period.view',
        'report.financial',
        'voucher.post',
        'voucher.reverse',
        'voucher.view',
      ].sort(),
    )

    // Council ruling 2026-09-29: reopening a closed period is Owner-only.
    expect(accountantPerms.has('admin.user_manage')).toBe(false)
    expect(accountantPerms.has('period.reopen')).toBe(false)
    expect([...accountantPerms].sort()).toEqual(
      [...ownerPerms].filter((c) => c !== 'admin.user_manage' && c !== 'period.reopen').sort(),
    )

    expect([...viewerPerms].sort()).toEqual([
      'account.view',
      'customer.view',
      'period.view',
      'report.financial',
      'voucher.view',
    ])
    expect(viewerPerms.has('voucher.post')).toBe(false)
    expect(viewerPerms.has('period.close')).toBe(false)
  })

  it('gives a user with no role assignment an empty set, not an error', async () => {
    const tenant = await seedTenant()
    const nobody = await createUser(tenant)
    expect(await permissionsOf(tenant, nobody)).toEqual(new Set())
  })
})

describe('SEC-C4: a non-ACTIVE user resolves to no permissions', () => {
  it.each(['SUSPENDED', 'DISABLED', 'INVITED'])(
    'a %s user with an active Viewer role assignment still resolves to an empty set',
    async (status) => {
      const tenant = await seedTenant()
      const user = await createUser(tenant, { status })
      await assignRole(tenant, user, 'viewer')

      expect(await permissionsOf(tenant, user)).toEqual(new Set())
    },
  )

  it('the same tenant, an ACTIVE Viewer, resolves normally (the positive control)', async () => {
    const tenant = await seedTenant()
    const user = await createUser(tenant) // ACTIVE by default
    await assignRole(tenant, user, 'viewer')

    expect((await permissionsOf(tenant, user)).has('customer.view')).toBe(true)
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

  it('excludes every permission of a role that is deactivated (DB-C1)', async () => {
    const tenant = await seedTenant()
    const user = await createUser(tenant)
    await assignRole(tenant, user, 'viewer')
    expect(await permissionsOf(tenant, user)).not.toEqual(new Set())

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        const role = await tx
          .selectFrom('roles')
          .select(['id', 'version'])
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'viewer')
          .executeTakeFirstOrThrow()

        await tx
          .updateTable('roles')
          .set({ status: 'INACTIVE', version: role.version + 1 })
          .where('tenant_id', '=', tenant.tenantId)
          .where('id', '=', role.id)
          .execute()
      }),
    )

    expect(await permissionsOf(tenant, user)).toEqual(new Set())
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

  it('bumps every current holder when the role itself is deactivated (DB-C1)', async () => {
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
          .select(['id', 'version'])
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'viewer')
          .executeTakeFirstOrThrow()

        await tx
          .updateTable('roles')
          .set({ status: 'INACTIVE', version: role.version + 1 })
          .where('tenant_id', '=', tenant.tenantId)
          .where('id', '=', role.id)
          .execute()
      }),
    )

    expect(await versionOf(tenant, alice)).toBeGreaterThan(aliceBefore)
    expect(await versionOf(tenant, bob)).toBeGreaterThan(bobBefore)
  })

  it('does not bump anyone when a role update leaves status unchanged', async () => {
    const tenant = await seedTenant()
    const user = await createUser(tenant)
    await assignRole(tenant, user, 'viewer')
    const before = await versionOf(tenant, user)

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        const role = await tx
          .selectFrom('roles')
          .select(['id', 'version'])
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'viewer')
          .executeTakeFirstOrThrow()

        // Renaming, not deactivating: WHEN (OLD.status IS DISTINCT FROM
        // NEW.status) must not fire.
        await tx
          .updateTable('roles')
          .set({ name: 'Viewer (renamed)', version: role.version + 1 })
          .where('tenant_id', '=', tenant.tenantId)
          .where('id', '=', role.id)
          .execute()
      }),
    )

    expect(await versionOf(tenant, user)).toBe(before)
  })

  it('does not corrupt the provisioned owner row, whose created_by is NULL', async () => {
    // The cascade must never write users.updated_by — measured regression
    // for the defect this migration's header documents: an earlier draft
    // stamped updated_by on the cascade and violated
    // users_authorship_pair_or_neither the first time the affected user was
    // a tenant's provisioned owner.
    const tenant = await seedTenant()
    await activateOwner(tenant)
    await assignRole(tenant, tenant.ownerId, 'owner')
    expect((await permissionsOf(tenant, tenant.ownerId)).has('admin.user_manage')).toBe(true)
  })
})
