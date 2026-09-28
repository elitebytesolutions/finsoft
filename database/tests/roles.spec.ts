import { withGlobal } from '@finsoft/database'
import {
  prepareTestDatabase,
  rawOn,
  scalarOn,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { roles, tables } from './catalog.ts'

/*
 * Database roles and session configuration. ADR-0004:52-61, INFRASTRUCTURE §5,
 * NON_NEGOTIABLES rules 4 and 21.
 *
 * INFRASTRUCTURE §5 puts it plainly: finsoft_app must not have BYPASSRLS, and
 * "a schema test asserts this on every deploy — it is the difference between
 * RLS being a control and RLS being decoration". This file is that test.
 *
 * It also asserts what the *pool* did, not what pool.ts intended: a timeout
 * configured in a TypeScript object and a timeout the server actually applied
 * are different claims, and only the second one protects anything.
 */

/**
 * The container's bootstrap superuser.
 *
 * It exists because `postgres:17-alpine` needs a POSTGRES_USER to initialise
 * the cluster, it carries SUPERUSER and therefore BYPASSRLS inherently, and
 * it is never used by application code — the bootstrap script creates the
 * three real roles and gets out of the way (FND-005). Production's equivalent
 * is the managed-service admin, and rule 21's `finsoft_breakglass` is the
 * emergency identity; neither is a connection string this codebase holds.
 *
 * The assertions below are therefore phrased as "the only non-superuser role
 * with BYPASSRLS is finsoft_migration". Phrasing it as "only one role has
 * bypass" would fail on a correctly configured cluster, and a test that
 * cannot pass gets weakened rather than fixed.
 */
const BOOTSTRAP_SUPERUSER = 'finsoft_bootstrap'

describe('database roles', () => {
  beforeAll(prepareTestDatabase, 60_000)
  afterAll(teardownTestDatabase)

  it('connects as finsoft_app, not as anything privileged', async () => {
    const who = await withGlobal((tx) =>
      rawOn<{ current_user: string; session_user: string }>(
        tx,
        'select current_user, session_user',
      ),
    )

    expect(who[0]?.current_user).toBe('finsoft_app')
    expect(who[0]?.session_user).toBe('finsoft_app')
  })

  it('gives finsoft_app neither rolbypassrls nor rolsuper', async () => {
    const app = (await roles()).find((r) => r.role_name === 'finsoft_app')

    expect(app, 'finsoft_app does not exist').toBeDefined()
    expect(
      app?.bypasses_rls,
      'finsoft_app holds BYPASSRLS. Every RLS policy in the schema is now decoration and every ' +
        'tenant can read every other tenant (rule 8 — Sev-1).',
    ).toBe(false)
    expect(
      app?.is_superuser,
      'finsoft_app is SUPERUSER, which implies BYPASSRLS. Same consequence.',
    ).toBe(false)
  })

  it('keeps readonly_support subject to RLS too', async () => {
    const support = (await roles()).find((r) => r.role_name === 'readonly_support')

    expect(support, 'readonly_support does not exist').toBeDefined()
    expect(
      support?.bypasses_rls,
      'ADR-0004:61 — support access to a tenant is granted by setting the tenant, never by ' +
        'bypassing the policy.',
    ).toBe(false)
    expect(support?.is_superuser).toBe(false)
  })

  it('reserves BYPASSRLS for finsoft_migration alone among non-superusers', async () => {
    const bypassers = (await roles())
      .filter((r) => r.bypasses_rls && !r.is_superuser)
      .map((r) => r.role_name)
      .sort()

    expect(
      bypassers,
      'BYPASSRLS is reserved for the migration role (ADR-0004:59). It is never used by the ' +
        'running application, the worker, or any background job.',
    ).toEqual(['finsoft_migration'])
  })

  it('accounts for the bootstrap superuser rather than pretending it is absent', async () => {
    const superusers = (await roles())
      .filter((r) => r.is_superuser)
      .map((r) => r.role_name)
      .sort()

    expect(
      superusers,
      `the only superuser should be the container bootstrap identity (${BOOTSTRAP_SUPERUSER}). ` +
        'Anything else here is a role that can read every tenant.',
    ).toEqual([BOOTSTRAP_SUPERUSER])
  })

  it('has no break-glass role locally (rule 21)', async () => {
    const breakglass = (await roles()).find((r) => r.role_name === 'finsoft_breakglass')
    expect(
      breakglass,
      'finsoft_breakglass is a production emergency identity. Rule 21 scopes agents to local ' +
        'and CI databases; a local superuser by that name would also make the assertions above ' +
        'meaningless.',
    ).toBeUndefined()
  })

  it('D3: the non-superuser role set is exactly the four ADR-0023 names', async () => {
    const names = (await roles())
      .filter((r) => !r.is_superuser)
      .map((r) => r.role_name)
      .sort()
    expect(names).toEqual([
      'finsoft_app',
      'finsoft_migration',
      'finsoft_refresh',
      'readonly_support',
    ])
  })

  it('D3: finsoft_refresh is a member of nothing, and nothing but finsoft_migration is a member of it', async () => {
    const memberships = await withGlobal((tx) =>
      rawOn<{ member: string; role: string }>(
        tx,
        `select m.rolname as member, r.rolname as role
           from pg_auth_members am
           join pg_roles r on r.oid = am.roleid
           join pg_roles m on m.oid = am.member
          where r.rolname = 'finsoft_refresh' or m.rolname = 'finsoft_refresh'`,
      ),
    )
    // finsoft_refresh member OF anything: none.
    expect(memberships.filter((m) => m.member === 'finsoft_refresh')).toEqual([])
    // Anything member of finsoft_refresh: exactly finsoft_migration.
    expect(memberships.filter((m) => m.role === 'finsoft_refresh').map((m) => m.member)).toEqual([
      'finsoft_migration',
    ])
  })

  it('item 4, security/database re-review: the exact membership allowlist for every role', async () => {
    // pg_auth_members over ALL FOUR roles, not just finsoft_refresh — a
    // future `GRANT some_role TO finsoft_app` would let finsoft_app assume
    // whatever privilege that role carries, and nothing before this test
    // would have caught it.
    const memberships = await withGlobal((tx) =>
      rawOn<{ member: string; role: string }>(
        tx,
        `select m.rolname as member, r.rolname as role
           from pg_auth_members am
           join pg_roles r on r.oid = am.roleid
           join pg_roles m on m.oid = am.member`,
      ),
    )
    const membershipsOf = (member: string) =>
      memberships.filter((m) => m.member === member).map((m) => m.role)

    expect(membershipsOf('finsoft_app'), 'finsoft_app is a member of nothing').toEqual([])
    expect(membershipsOf('readonly_support'), 'readonly_support is a member of nothing').toEqual([])
    expect(
      membershipsOf('finsoft_migration'),
      'finsoft_migration is a member of exactly finsoft_refresh',
    ).toEqual(['finsoft_refresh'])
    expect(membershipsOf('finsoft_refresh'), 'finsoft_refresh is a member of nothing').toEqual([])
  })

  it('grants DELETE to nobody (rule 4)', async () => {
    const all = await tables()
    // Derived from pg_roles, not hardcoded (ADR-0023 §2 Compliance): every
    // non-pg_%, non-superuser role EXCLUDING the table owner
    // (finsoft_migration), which holds DELETE implicitly as owner —
    // has_table_privilege('finsoft_migration', ..., 'DELETE') is true for
    // that reason alone, and an unspecified derivation would make this
    // assertion red on a correct cluster.
    const grantees = (await roles())
      .filter((r) => !r.is_superuser && r.role_name !== 'finsoft_migration')
      .map((r) => r.role_name)
    expect(grantees.sort()).toEqual(['finsoft_app', 'finsoft_refresh', 'readonly_support'])

    for (const table of all) {
      for (const grantee of grantees) {
        const granted = await withGlobal((tx) =>
          scalarOn<boolean>(tx, 'select has_table_privilege($1, $2, $3)', [
            grantee,
            table.table_name,
            'DELETE',
          ]),
        )
        expect(
          granted,
          `${grantee} holds DELETE on ${table.table_name}. Rule 4: hard delete is forbidden for ` +
            'any operational or financial record. A table that genuinely needs it grants it ' +
            'explicitly, in its migration, with the justification in review.',
        ).toBe(false)
      }
    }
  })

  it('makes the migration ledger read-only to every role but the migrator (003)', async () => {
    /*
     * schema_migrations holds the checksums the runner compares each file
     * against. A role that can UPDATE a row here can make an edited migration
     * look untouched, and ADR-0013's immutability guarantee becomes
     * decoration — the same shape of failure as RLS without FORCE.
     *
     * finsoft_app held INSERT and UPDATE until 003. Nothing was exploited to
     * get them: the runner creates the table as finsoft_migration, so it
     * inherited the ALTER DEFAULT PRIVILEGES meant for ordinary application
     * tables. That default cannot exclude one table, so the runner now also
     * sets these grants at creation time; this asserts the outcome of both.
     *
     * SELECT is retained deliberately — the API's readiness probe reads this
     * table as finsoft_app to verify the schema version.
     */
    const writes = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const

    for (const grantee of ['finsoft_app', 'readonly_support', 'public'] as const) {
      for (const privilege of writes) {
        const granted = await withGlobal((tx) =>
          scalarOn<boolean>(tx, 'select has_table_privilege($1, $2, $3)', [
            grantee,
            'schema_migrations',
            privilege,
          ]),
        )
        expect(
          granted,
          `${grantee} holds ${privilege} on schema_migrations. Only finsoft_migration may ` +
            'write the ledger; anything else can forge a checksum and defeat ADR-0013.',
        ).toBe(false)
      }
    }

    // The read the readiness probe depends on must survive the lockdown.
    const canRead = await withGlobal((tx) =>
      scalarOn<boolean>(
        tx,
        "select has_table_privilege('finsoft_app', 'schema_migrations', 'SELECT')",
      ),
    )
    expect(canRead, 'the API readiness probe reads schema_migrations as finsoft_app').toBe(true)
  })

  it('gives finsoft_app no CREATE on the public schema', async () => {
    const canCreate = await withGlobal((tx) =>
      scalarOn<boolean>(tx, "select has_schema_privilege('finsoft_app', 'public', 'CREATE')"),
    )
    expect(
      canCreate,
      'an application that can create a table can quietly add one that escapes review, RLS and ' +
        'these schema tests.',
    ).toBe(false)
  })

  it('does not own the tables it reads, so FORCE RLS is meaningful', async () => {
    const owners = await withGlobal((tx) =>
      rawOn<{ table_name: string; owner: string }>(
        tx,
        `select c.relname as table_name, c.relowner::regrole::text as owner
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'`,
      ),
    )

    expect(owners.length).toBeGreaterThan(0)
    for (const row of owners) {
      expect(row.owner, `${row.table_name} owner`).toBe('finsoft_migration')
    }
  })

  /* ---------------------------------------------------------------- *
   * Pool configuration, as the server received it.
   * ADR-0004:118 — "the one way RLS can be defeated by configuration".
   * ---------------------------------------------------------------- */

  it('applied statement_timeout to the session', async () => {
    const value = await withGlobal((tx) => scalarOn<string>(tx, 'show statement_timeout'))
    expect(
      value,
      'the pool did not actually set statement_timeout. A statement with no ceiling holds its ' +
        'connection and its locks indefinitely.',
    ).toBe('15s')
  })

  it('applied idle_in_transaction_session_timeout to the session', async () => {
    const value = await withGlobal((tx) =>
      scalarOn<string>(tx, 'show idle_in_transaction_session_timeout'),
    )
    expect(
      value,
      'mandatory, because every unit of work here is a transaction: an abandoned one keeps a ' +
        'connection checked out with app.tenant_id still set on it.',
    ).toBe('10s')
  })

  it('identifies itself in pg_stat_activity', async () => {
    const value = await withGlobal((tx) => scalarOn<string>(tx, 'show application_name'))
    expect(value).toBe('finsoft-test')
  })

  it('runs at READ COMMITTED, which ARCHITECTURE §7 assumes', async () => {
    const value = await withGlobal((tx) => scalarOn<string>(tx, 'show transaction_isolation'))
    expect(value).toBe('read committed')
  })
})
