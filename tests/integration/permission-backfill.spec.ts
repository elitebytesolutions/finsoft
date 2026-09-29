import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  migrateTestDatabase,
  prepareTestDatabase,
  REPO_ROOT,
  runAs,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { insertSeededRoles } from '@finsoft/database'
import { PERMISSION_CODES, type PermissionCode } from '@finsoft/permissions'
import { SYSTEM_ROLE_SEEDS } from '@finsoft/permissions'

/*
 * database/migrations/014_add_account_and_period_permissions.sql, run as the
 * REAL migrator role — finsoft_migration, BYPASSRLS — against two tenants
 * seeded in the pre-014 state. Security seat requirement, 2026-09-29: the
 * existing coverage (tests/integration/accounting-api.spec.ts's "Permission
 * backfill" describe block) ran the statement as finsoft_app inside
 * withTenant, where RLS already hides every other tenant — so it could not
 * have caught a join bug that let one tenant's grant reach another tenant's
 * role. finsoft_migration has no such backstop: the migration's own
 * `r.tenant_id` join is the ONLY thing separating tenants, and this file
 * proves it holds under the actual privilege level the real migration runs
 * with, not a narrower one a test happened to use.
 */

/**
 * The four codes the M2-B Council ruling (2026-09-29) added. Migration 014
 * backfills exactly these; everything else in SYSTEM_ROLE_SEEDS already
 * existed before it. Deriving the PRE-014 seed from SYSTEM_ROLE_SEEDS minus
 * this set (rather than a second hardcoded list) means this file's fixture
 * can never silently drift from the catalogue it is testing against.
 */
const NEW_CODES: readonly PermissionCode[] = [
  'account.view',
  'period.view',
  'period.close',
  'period.reopen',
]

const PRE_014_SEEDS = SYSTEM_ROLE_SEEDS.map((seed) => ({
  ...seed,
  permissions: seed.permissions.filter((code) => !NEW_CODES.includes(code as PermissionCode)),
}))

/** finsoft_migration: BYPASSRLS, the role that actually applies every migration. */
async function asMigrationRole<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const url = process.env['TEST_MIGRATION_DATABASE_URL']
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const MIGRATION_014_SQL = readFileSync(
  join(REPO_ROOT, 'database/migrations/014_add_account_and_period_permissions.sql'),
  'utf8',
)

/** Seeds `tenant` with the PRE-014 system roles — i.e. "a tenant created before 014". */
async function seedPre014Tenant(tenant: TenantFixture): Promise<void> {
  await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant(async (tx) => {
      await tx
        .updateTable('users')
        .set({ status: 'ACTIVE', password_hash: 'test-hash-not-real', version: 1 })
        .where('tenant_id', '=', tenant.tenantId)
        .where('id', '=', tenant.ownerId)
        .execute()
      await insertSeededRoles(tx, tenant.tenantId, PRE_014_SEEDS)
    }),
  )
}

interface GrantRow {
  tenant_id: string
  role_code: string
  permission_code: string
  role_tenant_id: string
  created_by_tenant_id: string
}

/** Every currently-active grant, across ALL tenants, read via the migration role (no RLS). */
async function allActiveGrants(client: Client): Promise<GrantRow[]> {
  const { rows } = await client.query<GrantRow>(
    `SELECT
       rp.tenant_id           AS tenant_id,
       r.code                 AS role_code,
       rp.permission_code     AS permission_code,
       r.tenant_id            AS role_tenant_id,
       u.tenant_id            AS created_by_tenant_id
     FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     JOIN users u ON u.id = rp.created_by
     WHERE rp.revoked_at IS NULL
       AND r.is_system
     ORDER BY r.tenant_id, r.code, rp.permission_code`,
  )
  return rows
}

function grantsForTenant(rows: readonly GrantRow[], tenantId: string): GrantRow[] {
  return rows.filter((r) => r.tenant_id === tenantId)
}

function permissionsByRole(rows: readonly GrantRow[]): Record<string, string[]> {
  const byRole: Record<string, string[]> = {}
  for (const row of rows) {
    ;(byRole[row.role_code] ??= []).push(row.permission_code)
  }
  return byRole
}

let alpha: TenantFixture
let beta: TenantFixture

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()

  alpha = await createTenantFixture('PBFA')
  beta = await createTenantFixture('PBFB')
  await seedPre014Tenant(alpha)
  await seedPre014Tenant(beta)
}, 120_000)

afterAll(async () => {
  await teardownTestDatabase()
})

describe('migration 014, run as finsoft_migration (BYPASSRLS) against >=2 pre-014 tenants', () => {
  it('backfills both tenants to exactly SYSTEM_ROLE_SEEDS, with no cross-tenant leak', async () => {
    await asMigrationRole((client) => client.query(MIGRATION_014_SQL))

    const all = await asMigrationRole((client) => allActiveGrants(client))

    for (const tenant of [alpha, beta]) {
      const rows = grantsForTenant(all, tenant.tenantId)
      const byRole = permissionsByRole(rows)

      for (const seed of SYSTEM_ROLE_SEEDS) {
        expect(byRole[seed.code]?.sort(), `${tenant.tenantId} / ${seed.code}`).toEqual(
          [...seed.permissions].sort(),
        )
      }
    }
  })

  it("every grant's tenant_id matches BOTH its role's tenant_id and its created_by user's tenant_id — the join is the only tenant boundary under BYPASSRLS", async () => {
    const all = await asMigrationRole((client) => allActiveGrants(client))
    expect(all.length).toBeGreaterThan(0)

    for (const row of all) {
      expect(row.tenant_id, JSON.stringify(row)).toBe(row.role_tenant_id)
      expect(row.tenant_id, JSON.stringify(row)).toBe(row.created_by_tenant_id)
    }
  })

  it("tenant A's roles hold no grant created by a tenant B user, and vice versa", async () => {
    const all = await asMigrationRole((client) => allActiveGrants(client))

    const alphaRows = grantsForTenant(all, alpha.tenantId)
    const betaRows = grantsForTenant(all, beta.tenantId)
    expect(alphaRows.length).toBeGreaterThan(0)
    expect(betaRows.length).toBeGreaterThan(0)

    for (const row of alphaRows) {
      expect(row.created_by_tenant_id).not.toBe(beta.tenantId)
    }
    for (const row of betaRows) {
      expect(row.created_by_tenant_id).not.toBe(alpha.tenantId)
    }
  })

  it('is idempotent: running the same SQL again inserts nothing new', async () => {
    const before = await asMigrationRole((client) => allActiveGrants(client))

    await asMigrationRole((client) => client.query(MIGRATION_014_SQL))

    const after = await asMigrationRole((client) => allActiveGrants(client))
    expect(after.length).toBe(before.length)
    expect(after).toEqual(before)
  })
})

// Every code this file backfills is, and stays, a real catalogue code.
describe('sanity', () => {
  it('NEW_CODES are all real, catalogued permission codes', () => {
    for (const code of NEW_CODES) expect(PERMISSION_CODES).toContain(code)
  })
})
