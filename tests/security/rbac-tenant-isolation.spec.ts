import { withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  scalarOn,
  sqlstate,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { resolvePermissions, seedSystemRoles } from '@finsoft/permissions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * RBAC tenant isolation, adversarial. Migration 008, ARCHITECTURE §8,
 * NON_NEGOTIABLES rules 7, 8, 18. Same discipline as
 * tests/security/tenant-isolation.spec.ts: raw SQL against finsoft_app,
 * because rule 8 is a claim about what the database returns to the
 * restricted application role, not about what a repository happens to add
 * to a WHERE clause.
 */

let alpha: TenantFixture
let beta: TenantFixture

beforeAll(async () => {
  await prepareTestDatabase()
  alpha = await createTenantFixture('RTA')
  beta = await createTenantFixture('RTB')

  await Promise.all([
    runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) => seedSystemRoles(tx, alpha.tenantId)),
    ),
    runAs({ tenantId: beta.tenantId, userId: beta.ownerId }, () =>
      withTenant((tx) => seedSystemRoles(tx, beta.tenantId)),
    ),
  ])
}, 60_000)

afterAll(teardownTestDatabase)

const asAlpha = <T>(fn: () => Promise<T>): Promise<T> =>
  runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, fn)
const asBeta = <T>(fn: () => Promise<T>): Promise<T> =>
  runAs({ tenantId: beta.tenantId, userId: beta.ownerId }, fn)

describe('a role granted in tenant A is invisible in tenant B', () => {
  it('a bare SELECT * FROM roles run as tenant B never returns an alpha row', async () => {
    const rows = await asBeta(() =>
      withTenant((tx) => rawOn<{ id: string; tenant_id: string }>(tx, 'select * from roles')),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.tenant_id === beta.tenantId)).toBe(true)
  })

  it("cannot look up alpha's Owner role by id from tenant B's context", async () => {
    const ownerRoleId = await asAlpha(() =>
      withTenant((tx) =>
        scalarOn<string>(tx, `select id from roles where tenant_id = $1 and code = 'owner'`, [
          alpha.tenantId,
        ]),
      ),
    )
    expect(ownerRoleId).toBeDefined()

    const found = await asBeta(() =>
      withTenant((tx) =>
        scalarOn<number>(tx, 'select count(*)::int from roles where id = $1', [ownerRoleId]),
      ),
    )
    expect(found).toBe(0)
  })
})

describe('a role assignment across tenants is impossible', () => {
  it("refuses assigning alpha's role to beta's user (composite FK on role_id)", async () => {
    const alphaOwnerRoleId = await asAlpha(() =>
      withTenant((tx) =>
        scalarOn<string>(tx, `select id from roles where tenant_id = $1 and code = 'owner'`, [
          alpha.tenantId,
        ]),
      ),
    )

    // Attempted as tenant B: RLS's WITH CHECK stamps tenant_id = beta on the
    // new row regardless of what is supplied, so the row claims
    // (tenant_id=beta, user_id=beta.ownerId, role_id=<alpha's role>). The
    // composite FK on (tenant_id, role_id) -> roles(tenant_id, id) requires
    // a role that exists under tenant_id=beta with that id — it does not,
    // because that id belongs to alpha.
    const attempt = asBeta(() =>
      withTenant((tx) =>
        rawOn(
          tx,
          `insert into user_roles (tenant_id, user_id, role_id, created_by, updated_by)
           values ($1, $2, $3, $4, $4)`,
          [beta.tenantId, beta.ownerId, alphaOwnerRoleId, beta.ownerId],
        ),
      ),
    )

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => sqlstate(error) === '23503',
      'expected SQLSTATE 23503, foreign key violation on the composite (tenant_id, role_id) key',
    )
  })

  it("refuses assigning beta's user to alpha's role by smuggling the tenant column (WITH CHECK)", async () => {
    const alphaOwnerRoleId = await asAlpha(() =>
      withTenant((tx) =>
        scalarOn<string>(tx, `select id from roles where tenant_id = $1 and code = 'owner'`, [
          alpha.tenantId,
        ]),
      ),
    )

    // Attempted as tenant A, naming beta's tenant_id explicitly: the WITH
    // CHECK clause refuses a row whose tenant_id does not match the session
    // tenant, before the composite FK is ever evaluated.
    const attempt = asAlpha(() =>
      withTenant((tx) =>
        rawOn(
          tx,
          `insert into user_roles (tenant_id, user_id, role_id, created_by, updated_by)
           values ($1, $2, $3, $4, $4)`,
          [beta.tenantId, beta.ownerId, alphaOwnerRoleId, alpha.ownerId],
        ),
      ),
    )

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => sqlstate(error) === '42501',
      'expected SQLSTATE 42501, new row violates row-level security policy (WITH CHECK)',
    )
  })

  it("beta cannot grant alpha's user any permission by referencing alpha's role from a beta grant", async () => {
    const alphaOwnerRoleId = await asAlpha(() =>
      withTenant((tx) =>
        scalarOn<string>(tx, `select id from roles where tenant_id = $1 and code = 'owner'`, [
          alpha.tenantId,
        ]),
      ),
    )

    const attempt = asBeta(() =>
      withTenant((tx) =>
        rawOn(
          tx,
          `insert into role_permissions (tenant_id, role_id, permission_code, created_by, updated_by)
           values ($1, $2, $3, $4, $4)`,
          [beta.tenantId, alphaOwnerRoleId, 'admin.user_manage', beta.ownerId],
        ),
      ),
    )

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => sqlstate(error) === '23503',
      'expected SQLSTATE 23503, foreign key violation on the composite (tenant_id, role_id) key',
    )
  })
})

describe('Viewer cannot pass a voucher.post check', () => {
  it('resolvePermissions for a Viewer-only user never contains voucher.post', async () => {
    const viewerId = await asAlpha(() =>
      withTenant(async (tx) => {
        const user = await tx
          .insertInto('users')
          .values({
            tenant_id: alpha.tenantId,
            email: `viewer.security@example.test`,
            full_name: 'Security Viewer',
            status: 'ACTIVE',
            password_hash: 'test-hash-not-real',
            created_by: alpha.ownerId,
            updated_by: alpha.ownerId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()

        const role = await tx
          .selectFrom('roles')
          .select('id')
          .where('tenant_id', '=', alpha.tenantId)
          .where('code', '=', 'viewer')
          .executeTakeFirstOrThrow()

        await tx
          .insertInto('user_roles')
          .values({
            tenant_id: alpha.tenantId,
            user_id: user.id,
            role_id: role.id,
            created_by: alpha.ownerId,
            updated_by: alpha.ownerId,
          })
          .execute()

        return user.id
      }),
    )

    const granted = await asAlpha(() => withTenant((tx) => resolvePermissions(tx, viewerId)))

    expect(granted.has('voucher.post')).toBe(false)
    expect(granted.has('voucher.view')).toBe(true)
  })
})
