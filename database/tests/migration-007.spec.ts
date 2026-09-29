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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * Migration 007 (TD-005, ADR-0023 §1). D4, security/database re-review
 * 2026-09-27: the column-scoped regrant on `users`/`tenants` and
 * `users_enforce_transition`, exercised as `finsoft_app` under RLS — the
 * same role and the same path the application uses, never as
 * `finsoft_migration`.
 */

describe('migration 007', () => {
  beforeAll(prepareTestDatabase, 60_000)
  afterAll(teardownTestDatabase)

  let fixture: TenantFixture

  beforeAll(async () => {
    fixture = await createTenantFixture('M7A')
  }, 60_000)

  async function activateOwner(): Promise<void> {
    await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
      withTenant((tx) =>
        rawOn(
          tx,
          `UPDATE users SET password_hash = 'x', status = 'ACTIVE', version = version + 1
            WHERE id = $1`,
          [fixture.ownerId],
        ),
      ),
    )
  }

  describe('the exact column grant (users)', () => {
    const GRANTED = [
      'full_name',
      'password_hash',
      'status',
      'last_login_at',
      'updated_at',
      'updated_by',
      'version',
    ]
    const WITHHELD = ['id', 'tenant_id', 'email', 'created_at', 'created_by']

    it.each(GRANTED)('finsoft_app may UPDATE users.%s', async (column) => {
      const granted = await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
        withTenant((tx) =>
          scalarOn<boolean>(tx, 'select has_column_privilege($1, $2, $3, $4)', [
            'finsoft_app',
            'users',
            column,
            'UPDATE',
          ]),
        ),
      )
      expect(granted, `finsoft_app should hold UPDATE on users.${column}`).toBe(true)
    })

    it.each(WITHHELD)('finsoft_app may NOT UPDATE users.%s', async (column) => {
      const granted = await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
        withTenant((tx) =>
          scalarOn<boolean>(tx, 'select has_column_privilege($1, $2, $3, $4)', [
            'finsoft_app',
            'users',
            column,
            'UPDATE',
          ]),
        ),
      )
      expect(granted, `finsoft_app must NOT hold UPDATE on users.${column} (TD-005)`).toBe(false)
    })
  })

  describe('the exact column grant (tenants)', () => {
    const GRANTED = ['name', 'legal_name', 'ntn', 'strn', 'timezone', 'updated_at']
    const WITHHELD = ['id', 'code', 'status', 'base_currency', 'created_at']

    it.each(GRANTED)('finsoft_app may UPDATE tenants.%s', async (column) => {
      const granted = await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
        withTenant((tx) =>
          scalarOn<boolean>(tx, 'select has_column_privilege($1, $2, $3, $4)', [
            'finsoft_app',
            'tenants',
            column,
            'UPDATE',
          ]),
        ),
      )
      expect(granted, `finsoft_app should hold UPDATE on tenants.${column}`).toBe(true)
    })

    it.each(WITHHELD)('finsoft_app may NOT UPDATE tenants.%s', async (column) => {
      const granted = await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
        withTenant((tx) =>
          scalarOn<boolean>(tx, 'select has_column_privilege($1, $2, $3, $4)', [
            'finsoft_app',
            'tenants',
            column,
            'UPDATE',
          ]),
        ),
      )
      expect(granted, `finsoft_app must NOT hold UPDATE on tenants.${column} (ADR-0023 §1)`).toBe(
        false,
      )
    })
  })

  describe('users_enforce_transition', () => {
    it('rejects DISABLED -> ACTIVE', async () => {
      const u = await createTenantFixture('M7B')
      await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          rawOn(
            tx,
            `UPDATE users SET password_hash = 'x', status = 'ACTIVE', version = version + 1 WHERE id = $1`,
            [u.ownerId],
          ),
        ),
      )
      await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          rawOn(tx, `UPDATE users SET status = 'DISABLED', version = version + 1 WHERE id = $1`, [
            u.ownerId,
          ]),
        ),
      )

      const error = await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          rawOn(tx, `UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = $1`, [
            u.ownerId,
          ]),
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      )

      expect(error, 'DISABLED is terminal; reactivation must be rejected').not.toBeNull()
      expect(sqlstate(error)).toBe('23514')
    })

    it('rejects a version rewind', async () => {
      const u = await createTenantFixture('M7C')
      const error = await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          rawOn(tx, `UPDATE users SET full_name = full_name, version = 0 WHERE id = $1`, [
            u.ownerId,
          ]),
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).not.toBeNull()
      expect(sqlstate(error)).toBe('23514')
    })

    it('rejects an unchanged version', async () => {
      const u = await createTenantFixture('M7D')
      const error = await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          rawOn(tx, `UPDATE users SET full_name = full_name WHERE id = $1`, [u.ownerId]),
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      )
      expect(
        error,
        'a version that does not move is indistinguishable from a rewind',
      ).not.toBeNull()
      expect(sqlstate(error)).toBe('23514')
    })

    it('rejects a tenant_id change (defence in depth — no grant permits this anyway)', async () => {
      const u = await createTenantFixture('M7E')
      const other = await createTenantFixture('M7F')
      const error = await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          rawOn(tx, `UPDATE users SET tenant_id = $2, version = version + 1 WHERE id = $1`, [
            u.ownerId,
            other.tenantId,
          ]),
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      )
      // No grant on tenant_id at all — 42501 from the privilege layer is the
      // expected shape; if a future grant ever widened to include it, the
      // trigger's own identity check (23514) is the backstop.
      expect(error, 'tenant_id must never be rewritable, by grant or by trigger').not.toBeNull()
      expect(['42501', '23514']).toContain(sqlstate(error))
    })

    it('rejects an email change — no path exists yet (TD-005)', async () => {
      const u = await createTenantFixture('M7G')
      const error = await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          rawOn(tx, `UPDATE users SET email = 'someone-else@example.test' WHERE id = $1`, [
            u.ownerId,
          ]),
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).not.toBeNull()
      expect(['42501', '23514']).toContain(sqlstate(error))
    })

    it('accepts a version-only +1 bump (the RBAC cascade shape) with updated_by unset', async () => {
      const u = await createTenantFixture('M7H')
      // The provisioned owner: created_by IS NULL, so updated_by must stay
      // NULL too (users_authorship_pair_or_neither) — exactly the shape the
      // RBAC role-change cascade (migration 008) must also respect.
      await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          rawOn(tx, `UPDATE users SET version = version + 1 WHERE id = $1`, [u.ownerId]),
        ),
      )

      const version = await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          scalarOn<number>(tx, `SELECT version FROM users WHERE id = $1`, [u.ownerId]),
        ),
      )
      expect(version).toBe(1)
    })

    it('accepts two version bumps in one transaction', async () => {
      const u = await createTenantFixture('M7I')
      await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant(async (tx) => {
          await rawOn(tx, `UPDATE users SET version = version + 1 WHERE id = $1`, [u.ownerId])
          await rawOn(tx, `UPDATE users SET version = version + 1 WHERE id = $1`, [u.ownerId])
        }),
      )

      const version = await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
        withTenant((tx) =>
          scalarOn<number>(tx, `SELECT version FROM users WHERE id = $1`, [u.ownerId]),
        ),
      )
      expect(version).toBe(2)
    })
  })

  it('leaves tenants.code and tenants.status untouched by the API role, by grant', async () => {
    for (const column of ['code', 'status']) {
      const granted = await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
        withTenant((tx) =>
          scalarOn<boolean>(tx, 'select has_column_privilege($1, $2, $3, $4)', [
            'finsoft_app',
            'tenants',
            column,
            'UPDATE',
          ]),
        ),
      )
      expect(granted).toBe(false)
    }
  })

  it('sanity: the fixture owner can still be activated through the grant path', async () => {
    await activateOwner()
    const status = await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
      withTenant((tx) =>
        scalarOn<string>(tx, `SELECT status FROM users WHERE id = $1`, [fixture.ownerId]),
      ),
    )
    expect(status).toBe('ACTIVE')
  })
})
