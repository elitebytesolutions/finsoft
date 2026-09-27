import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { withGlobal } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  scalarOn,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * migration 006's `auth_lookup.resolve_refresh`. ADR-0023 §2, "the primary
 * gate, and the single most valuable assertion in this record".
 *
 * A connection scoped to `finsoft_migration` is required for the negative
 * arm (dropping a policy needs table ownership or superuser) and for
 * `SET ROLE finsoft_refresh` — neither is available to `finsoft_app`, which
 * is exactly the point: this file measures a privilege boundary that
 * `finsoft_app` itself cannot even approach.
 */

function migrationClient(): Client {
  const url = process.env['TEST_MIGRATION_DATABASE_URL']
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
  return new Client({ connectionString: url })
}

function hexHash(): string {
  return randomBytes(32).toString('hex')
}

describe('auth_lookup.resolve_refresh — the pre-tenant refresh resolver (ADR-0023 §2)', () => {
  beforeAll(prepareTestDatabase, 60_000)
  afterAll(teardownTestDatabase)

  it('proacl is exactly {finsoft_refresh=X, finsoft_app=X} — no PUBLIC, no readonly_support', async () => {
    const rows = await withGlobal((tx) =>
      rawOn<{ proacl: string | null; owner: string; prosecdef: boolean }>(
        tx,
        `select p.proacl::text as proacl, p.proowner::regrole::text as owner, p.prosecdef
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'auth_lookup' and p.proname = 'resolve_refresh'`,
      ),
    )
    const row = rows[0]
    expect(row, 'auth_lookup.resolve_refresh does not exist').toBeDefined()
    expect(row?.owner).toBe('finsoft_refresh')
    expect(row?.prosecdef).toBe(true)

    const pub = await withGlobal((tx) =>
      scalarOn<boolean>(
        tx,
        `select has_function_privilege('public', 'auth_lookup.resolve_refresh(text)', 'EXECUTE')`,
      ),
    )
    const support = await withGlobal((tx) =>
      scalarOn<boolean>(
        tx,
        `select has_function_privilege('readonly_support', 'auth_lookup.resolve_refresh(text)', 'EXECUTE')`,
      ),
    )
    const app = await withGlobal((tx) =>
      scalarOn<boolean>(
        tx,
        `select has_function_privilege('finsoft_app', 'auth_lookup.resolve_refresh(text)', 'EXECUTE')`,
      ),
    )

    expect(
      pub,
      'PUBLIC must not hold EXECUTE — the two-no-op-statement bug ADR-0023 §2 names',
    ).toBe(false)
    expect(support, 'readonly_support must not hold EXECUTE').toBe(false)
    expect(app, 'finsoft_app must hold EXECUTE — this is the one caller').toBe(true)
  })

  it('a defect-injected second SECURITY DEFINER function in auth_lookup gets no PUBLIC EXECUTE either', async () => {
    /*
     * "If it passes, the default-privileges line works; if it fails, that
     * line is prose." (ADR-0023 §2 Compliance.) Created and dropped inside a
     * transaction that rolls back, so nothing here survives the test.
     */
    const client = migrationClient()
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query('GRANT USAGE, CREATE ON SCHEMA auth_lookup TO finsoft_refresh')
      await client.query('SET ROLE finsoft_refresh')
      await client.query(
        `CREATE FUNCTION auth_lookup.throwaway_probe() RETURNS void
           LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT $$`,
      )
      const { rows } = await client.query(
        `select has_function_privilege('public', 'auth_lookup.throwaway_probe()', 'EXECUTE') as pub`,
      )
      expect(
        rows[0].pub,
        'ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_refresh must cover a NEW function too',
      ).toBe(false)
      await client.query('RESET ROLE')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  })

  it('pg_auth_members: finsoft_refresh has exactly one member, finsoft_migration, INHERIT FALSE SET TRUE ADMIN FALSE', async () => {
    const rows = await withGlobal((tx) =>
      rawOn<{
        member: string
        inherit_option: boolean
        set_option: boolean
        admin_option: boolean
      }>(
        tx,
        `select m.rolname as member, am.inherit_option, am.set_option, am.admin_option
           from pg_auth_members am
           join pg_roles r on r.oid = am.roleid
           join pg_roles m on m.oid = am.member
          where r.rolname = 'finsoft_refresh'`,
      ),
    )
    expect(rows.map((r) => r.member)).toEqual(['finsoft_migration'])
    expect(
      rows[0]?.inherit_option,
      'INHERIT FALSE is what makes REVOKE/GRANT no-ops outside SET ROLE',
    ).toBe(false)
    expect(rows[0]?.set_option, 'SET TRUE is what permits SET ROLE finsoft_refresh at all').toBe(
      true,
    )
    expect(rows[0]?.admin_option).toBe(false)
  })

  it('finsoft_refresh holds no INSERT, UPDATE or DELETE on any table', async () => {
    const tableNames = await withGlobal((tx) =>
      rawOn<{ table_name: string }>(
        tx,
        `select relname as table_name from pg_class
          join pg_namespace n on n.oid = pg_class.relnamespace
         where n.nspname = 'public' and relkind = 'r'`,
      ),
    )
    for (const { table_name } of tableNames) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        const granted = await withGlobal((tx) =>
          scalarOn<boolean>(tx, 'select has_table_privilege($1, $2, $3)', [
            'finsoft_refresh',
            table_name,
            privilege,
          ]),
        )
        expect(granted, `finsoft_refresh holds ${privilege} on ${table_name}`).toBe(false)
      }
    }
  })

  it('is NOLOGIN and holds no CONNECT on the database', async () => {
    const canLogin = await withGlobal((tx) =>
      scalarOn<boolean>(tx, `select rolcanlogin from pg_roles where rolname = 'finsoft_refresh'`),
    )
    expect(canLogin, 'finsoft_refresh must be NOLOGIN — it is reached only via SET ROLE').toBe(
      false,
    )

    const canConnect = await withGlobal((tx) =>
      scalarOn<boolean>(
        tx,
        `select has_database_privilege('finsoft_refresh', current_database(), 'CONNECT')`,
      ),
    )
    expect(canConnect).toBe(false)
  })

  it('THE PRIMARY GATE — positive arm: policy present, app.tenant_id UNSET, a seeded hash resolves to its own tenant', async () => {
    const fixture = await createTenantFixture('PTR')
    const hash = hexHash()

    // Seed a refresh_tokens row directly as finsoft_migration (BYPASSRLS),
    // because writing one as finsoft_app requires a tenant context this
    // test must NOT establish — establishing it would disarm exactly the
    // assertion this test exists to make (ADR-0023 §2 Compliance).
    const client = migrationClient()
    await client.connect()
    try {
      const family = await client.query(
        `insert into sessions (tenant_id, user_id, created_by, updated_by)
           values ($1, $2, $2, $2) returning id`,
        [fixture.tenantId, fixture.ownerId],
      )
      const sessionId = family.rows[0].id
      const fam = await client.query(
        `insert into refresh_token_families (tenant_id, session_id, created_by, updated_by)
           values ($1, $2, $3, $3) returning id`,
        [fixture.tenantId, sessionId, fixture.ownerId],
      )
      const familyId = fam.rows[0].id
      await client.query(
        `insert into refresh_tokens (tenant_id, family_id, token_hash, expires_at, created_by, updated_by)
           values ($1, $2, $3, now() + interval '1 day', $4, $4)`,
        [fixture.tenantId, familyId, hash, fixture.ownerId],
      )
    } finally {
      await client.end()
    }

    // Resolve as finsoft_app, with NO tenant context established at all.
    const resolved = await withGlobal((tx) =>
      rawOn<{ tenant_id: string; token_id: string }>(
        tx,
        'select tenant_id, token_id from auth_lookup.resolve_refresh($1)',
        [hash],
      ),
    )

    expect(resolved, 'the resolver must return exactly one row for a seeded hash').toHaveLength(1)
    expect(resolved[0]?.tenant_id).toBe(fixture.tenantId)
  })

  it('THE PRIMARY GATE — negative arm: policy DROPPED, app.tenant_id UNSET, resolving ANY hash raises 42704', async () => {
    const client = migrationClient()
    await client.connect()
    try {
      await client.query('BEGIN')
      // finsoft_migration itself holds no EXECUTE on the function (proacl
      // is exactly {finsoft_refresh, finsoft_app} — see the earlier test).
      // A temporary grant, exactly as ADR-0023 §2's own Compliance SQL
      // does it, so THIS connection can call the function at all; it dies
      // with the ROLLBACK below.
      await client.query('SET ROLE finsoft_refresh')
      await client.query(
        'GRANT EXECUTE ON FUNCTION auth_lookup.resolve_refresh(text) TO finsoft_migration',
      )
      await client.query('RESET ROLE')
      // AccessExclusiveLock; serialises against concurrent readers of this
      // table for the duration of the (rolled-back) transaction.
      await client.query('DROP POLICY refresh_lookup ON refresh_tokens')

      let sqlstate: string | undefined
      try {
        await client.query('select * from auth_lookup.resolve_refresh($1)', [hexHash()])
      } catch (error) {
        sqlstate = (error as { code?: string }).code
      }

      expect(
        sqlstate,
        '42704 = unrecognized configuration parameter "app.tenant_id" — raised by ' +
          "tenant_isolation's current_setting once the permissive USING (true) policy is gone. " +
          'RLS denial would instead return zero rows silently, which is NOT what must happen here.',
      ).toBe('42704')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  })

  it("THE COMPANION ARM — policy dropped, tenant A set, resolving tenant B's hash returns zero rows", async () => {
    const a = await createTenantFixture('PTA')
    const b = await createTenantFixture('PTB')
    const hash = hexHash()

    const seedClient = migrationClient()
    await seedClient.connect()
    try {
      const session = await seedClient.query(
        `insert into sessions (tenant_id, user_id, created_by, updated_by) values ($1,$2,$2,$2) returning id`,
        [b.tenantId, b.ownerId],
      )
      const family = await seedClient.query(
        `insert into refresh_token_families (tenant_id, session_id, created_by, updated_by) values ($1,$2,$3,$3) returning id`,
        [b.tenantId, session.rows[0].id, b.ownerId],
      )
      await seedClient.query(
        `insert into refresh_tokens (tenant_id, family_id, token_hash, expires_at, created_by, updated_by)
           values ($1,$2,$3, now() + interval '1 day', $4,$4)`,
        [b.tenantId, family.rows[0].id, hash, b.ownerId],
      )
    } finally {
      await seedClient.end()
    }

    const client = migrationClient()
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET ROLE finsoft_refresh')
      await client.query(
        'GRANT EXECUTE ON FUNCTION auth_lookup.resolve_refresh(text) TO finsoft_migration',
      )
      await client.query('RESET ROLE')
      await client.query('DROP POLICY refresh_lookup ON refresh_tokens')
      await client.query(`select set_config('app.tenant_id', $1, true)`, [a.tenantId])
      const { rows } = await client.query('select * from auth_lookup.resolve_refresh($1)', [hash])
      expect(
        rows,
        "with the pre-tenant policy gone, tenant A must not resolve tenant B's token via the " +
          'ordinary tenant_isolation policy either',
      ).toHaveLength(0)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  })
})
