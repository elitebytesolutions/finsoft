import { CompiledQuery, type Kysely } from 'kysely'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { describeTarget, requireEnv } from '../env.ts'
import { closeDatabase, openDatabase } from '../lifecycle.ts'
import { getPool, type PoolTarget } from '../pool.ts'
import type { Database } from '../schema.ts'
import { createAuditChainAnchor } from '../audit/anchor.ts'
import { TenantContext, type TenantPrincipal } from '../tenant-context.ts'
import { withGlobal, withTenant, type GlobalTx, type TenantTx } from '../transaction.ts'

/*
 * Test harness for the tenant isolation gate. FND-007/008.
 *
 * Not part of the package's public surface — reachable only as
 * `@finsoft/database/testing`, and used by database/tests/** and
 * tests/security/**.
 *
 * Two things here need to be understood before they are copied:
 *
 *   1. Everything connects as **finsoft_app**, the production-style
 *      restricted role: no BYPASSRLS, no SUPERUSER, owner of nothing. A
 *      tenant-isolation suite run as a superuser proves nothing at all, so
 *      `assertTestTarget` below refuses to let the suite start against
 *      anything else.
 *
 *   2. `rawOn` executes arbitrary SQL text on a transaction handle. That is
 *      the "explicit, reviewed helper" ADR-0003:114 allows for raw SQL, and
 *      it exists for exactly one reason: an isolation test has to be able to
 *      run `SELECT * FROM users` the way an attacker or a careless agent
 *      would, unmediated by the repository layer that is supposed to be
 *      protecting it. Rule 8 names that bare query as the thing RLS must
 *      make safe. Parameters are bound, never interpolated.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')

/**
 * The test pool: finsoft_app against the test cluster on its own port.
 *
 * TEST_DATABASE_URL, never DATABASE_URL. The two clusters are separate
 * servers (FND-005), so a suite that resets or fills the test database can
 * never reach development data.
 */
export const TEST_TARGET: PoolTarget = {
  urlVar: 'TEST_DATABASE_URL',
  applicationName: 'finsoft-test',
}

let prepared = false

/** Load the repository .env if the process was not started with one. */
function loadEnvFile(): void {
  const envPath = resolve(REPO_ROOT, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
}

/**
 * Refuse to run against anything but the test database, as a role that is
 * subject to RLS.
 *
 * A tenant-isolation suite pointed at the development database would fill it
 * with junk that cannot be deleted (rule 4 — no DELETE is granted). One run
 * as finsoft_migration, which holds BYPASSRLS, would pass every assertion
 * here while proving nothing.
 */
function assertTestTarget(url: string): void {
  const parsed = new URL(url)
  const database = parsed.pathname.replace(/^\//, '')

  if (!database.endsWith('_test')) {
    throw new Error(
      `Refusing to run the isolation suite against "${database}" (${describeTarget(url)}). ` +
        'TEST_DATABASE_URL must point at the disposable test cluster.',
    )
  }
  if (parsed.username !== 'finsoft_app') {
    throw new Error(
      `Refusing to run the isolation suite as "${parsed.username}". These tests must execute as ` +
        'finsoft_app — the role with no BYPASSRLS and no SUPERUSER. Run as any other role and ' +
        'the suite still passes while proving nothing (ADR-0004:59, INFRASTRUCTURE §5).',
    )
  }
}

/**
 * Prepare the process: load .env, pin the pool, open it against the test
 * database. Idempotent, so every spec file can call it in `beforeAll`.
 *
 * `DATABASE_POOL_MAX` defaults to `1`, which is not a performance choice. It
 * makes connection reuse deterministic, which is the only way to assert the
 * thing ADR-0004:140 asks for: that the next borrower of *the same*
 * connection does not inherit the previous transaction's `app.tenant_id`.
 * With a larger pool that test would usually get a different backend and
 * pass without testing anything.
 *
 * The default only applies if a spec file has not already set the variable
 * BEFORE calling this function (`??=`, not `=`). The one sanctioned reason
 * to do that: a genuine multi-connection concurrency test — B1's row-lock
 * race (security/database re-review N2) needs two REAL `spendRefreshToken`
 * calls in flight on two separate backends at once, which a pool of 1
 * cannot produce by construction (a second caller would queue for the
 * connection rather than race for the row). Every other spec file gets the
 * deterministic default exactly as before.
 */
export async function prepareTestDatabase(): Promise<void> {
  if (prepared) return

  loadEnvFile()

  const url = requireEnv('TEST_DATABASE_URL', 'The isolation suite runs against the test cluster.')
  assertTestTarget(url)

  process.env['DATABASE_POOL_MAX'] ??= '1'

  await migrateTestDatabase()
  await openDatabase(TEST_TARGET)

  prepared = true
}

export async function teardownTestDatabase(): Promise<void> {
  prepared = false
  await closeDatabase()
}

/**
 * Bring the test database up to the latest migration, as finsoft_migration.
 *
 * The runner resolves `database/migrations` against `process.cwd()`, so the
 * harness anchors the process at the repository root first. Vitest is
 * launched from there; the guard is for anyone who runs a spec file directly.
 */
export async function migrateTestDatabase(): Promise<void> {
  loadEnvFile()

  if (resolve(process.cwd()) !== REPO_ROOT) process.chdir(REPO_ROOT)

  const testMigrationUrl = requireEnv(
    'TEST_MIGRATION_DATABASE_URL',
    'Migrations run as finsoft_migration, the only role with DDL (INFRASTRUCTURE §5).',
  )

  const previous = process.env['MIGRATION_DATABASE_URL']
  process.env['MIGRATION_DATABASE_URL'] = testMigrationUrl
  try {
    const { migrate } = await import('../migrate/apply.ts')
    await migrate()
  } finally {
    if (previous === undefined) delete process.env['MIGRATION_DATABASE_URL']
    else process.env['MIGRATION_DATABASE_URL'] = previous
  }
}

/* ------------------------------------------------------------------ *
 * The accounting suite's own database. QA-001, Accounting seat ruling
 * 2026-10-01 (option c).
 *
 * tests/accounting and tests/reconciliation's Invariant 9 sweep
 * (ar-invariant-9.ts) reads EVERY tenant in its database except the
 * 'TKR'/'TM3RUNNER' allowlist — a design that assumed only
 * kernel-rules.spec.ts and the M3RUNNER golden runner would ever post
 * AR_CONTROL without a document behind it. database/tests/journal-lines.spec.ts
 * does the exact same thing, under labels ('JLP' and others) nobody put on
 * that allowlist — and on one persistent local Postgres (rule 4: no
 * DELETE, ever), test:schema's leftover tenants trip Invariant 9 the
 * moment test:accounting/test:reconciliation runs afterward, which is
 * literally the order `test:gate` runs them in.
 *
 * The fix is not a bigger allowlist. 'TJLP'/'TJLK'/'TSUB' would have
 * covered journal-lines.spec.ts's CURRENT labels and nothing else, forever
 * chasing whatever database/tests adds next — see M2-C's own removal of
 * exactly those three. It is a database database/tests has never touched:
 * tenants in one PostgreSQL database are categorically invisible to a
 * connection against another, which is a stronger guarantee than any list
 * of prefixes could be.
 *
 * GitHub Actions does not reproduce the bug today, because `db-suites`
 * (test:schema) and `financial` (test:accounting, test:reconciliation) are
 * SEPARATE JOBS, each `docker compose up -d --wait` on its own fresh
 * runner (.github/workflows/ci.yml) — there is no shared, persistent
 * database for test:schema to contaminate. One persistent local cluster —
 * `npm run test:gate`, or any future change that folds those jobs together
 * — reproduces it every time. This mechanism makes the two suites
 * correctly isolated regardless of job topology, so it does not depend on
 * that CI accident continuing to hold.
 * ------------------------------------------------------------------ */

/**
 * The accounting suite's pool: finsoft_app against its own database, on the
 * SAME test cluster as TEST_TARGET but never the same database.
 */
export const ACCOUNTING_TEST_TARGET: PoolTarget = {
  urlVar: 'TEST_ACCOUNTING_DATABASE_URL',
  applicationName: 'finsoft-test-accounting',
}

let accountingPrepared = false
let loggedAccountingDatabaseFallback = false
let loggedAccountingMigrationFallback = false

/**
 * Database-name transform shared by every derivation below: insert
 * '_accounting' immediately before a trailing '_test', or append it if the
 * name does not end that way. 'finsoft_test' becomes
 * 'finsoft_test_accounting' — the example name the Accounting seat's
 * ruling itself used.
 */
function accountingDatabaseName(baseName: string): string {
  return baseName.endsWith('_test')
    ? `${baseName.slice(0, -'_test'.length)}_test_accounting`
    : `${baseName}_accounting`
}

/** `baseUrl` with its database name run through `transform`; everything else unchanged. */
function withDatabaseName(baseUrl: string, transform: (name: string) => string): string {
  const parsed = new URL(baseUrl)
  const currentName = parsed.pathname.replace(/^\//, '')
  parsed.pathname = `/${transform(currentName)}`
  return parsed.toString()
}

/**
 * TEST_ACCOUNTING_DATABASE_URL if set, explicitly. Otherwise derived from
 * TEST_DATABASE_URL — falling back CLEARLY: logged once, not silently, so
 * "which database did this run actually use" is always answerable from the
 * log rather than requiring a read of this function.
 */
function resolveAccountingDatabaseUrl(): string {
  const explicit = process.env['TEST_ACCOUNTING_DATABASE_URL']
  if (explicit !== undefined && explicit.trim() !== '') return explicit

  const base = requireEnv(
    'TEST_DATABASE_URL',
    'TEST_ACCOUNTING_DATABASE_URL is not set, so it is derived from TEST_DATABASE_URL, which must ' +
      'itself be set.',
  )
  const derived = withDatabaseName(base, accountingDatabaseName)
  if (!loggedAccountingDatabaseFallback) {
    loggedAccountingDatabaseFallback = true
    // eslint-disable-next-line no-console -- one-time, explicit fallback notice, not applicaton logging
    console.log(
      `[testing/harness] TEST_ACCOUNTING_DATABASE_URL is not set — derived ${describeTarget(derived)} ` +
        'from TEST_DATABASE_URL. Set TEST_ACCOUNTING_DATABASE_URL explicitly to override.',
    )
  }
  return derived
}

/** The migration-role equivalent of `resolveAccountingDatabaseUrl`, derived from TEST_MIGRATION_DATABASE_URL. */
function resolveAccountingMigrationDatabaseUrl(): string {
  const explicit = process.env['TEST_ACCOUNTING_MIGRATION_DATABASE_URL']
  if (explicit !== undefined && explicit.trim() !== '') return explicit

  const base = requireEnv(
    'TEST_MIGRATION_DATABASE_URL',
    'TEST_ACCOUNTING_MIGRATION_DATABASE_URL is not set, so it is derived from ' +
      'TEST_MIGRATION_DATABASE_URL, which must itself be set.',
  )
  const derived = withDatabaseName(base, accountingDatabaseName)
  if (!loggedAccountingMigrationFallback) {
    loggedAccountingMigrationFallback = true
    // eslint-disable-next-line no-console -- one-time, explicit fallback notice, not applicaton logging
    console.log(
      `[testing/harness] TEST_ACCOUNTING_MIGRATION_DATABASE_URL is not set — derived ` +
        `${describeTarget(derived)} from TEST_MIGRATION_DATABASE_URL. Set ` +
        'TEST_ACCOUNTING_MIGRATION_DATABASE_URL explicitly to override.',
    )
  }
  return derived
}

/**
 * Exported for the handful of spec files that need their own raw
 * finsoft_migration connection against the SAME database the accounting
 * pool uses (tests/reconciliation/party-registry.spec.ts,
 * tests/accounting/posting-invariants.ts) — so that connection can never
 * drift from the one `prepareAccountingTestDatabase` actually opened.
 */
export function accountingMigrationDatabaseUrl(): string {
  loadEnvFile()
  return resolveAccountingMigrationDatabaseUrl()
}

/**
 * Refuse to run against anything that is not provably a test database, as
 * finsoft_app. Accounting seat ruling, 2026-10-01: the TKR/TM3RUNNER
 * allowlist in ar-invariant-9.ts only means anything run against a
 * database that is provably not staging or production — this is that
 * proof, cheap and explicit, mirroring `assertTestTarget` above.
 */
function assertAccountingTestTarget(url: string): void {
  assertTestDatabaseName(url, 'TEST_ACCOUNTING_DATABASE_URL')
  const parsed = new URL(url)
  if (parsed.username !== 'finsoft_app') {
    throw new Error(
      `Refusing to run the accounting/reconciliation suite as "${parsed.username}". These tests ` +
        'must execute as finsoft_app — the role with no BYPASSRLS and no SUPERUSER (ADR-0004:59, ' +
        'INFRASTRUCTURE §5) — exactly like the schema suite (assertTestTarget above).',
    )
  }
}

/** The database-name half of `assertTestTarget`/`assertAccountingTestTarget`, shared by both. */
/**
 * Security seat review, 2026-10-01: `.includes('_test')` accepted
 * "finsoft_test_prod" and "prod_test_x" — a database name that merely
 * contains the substring proves nothing about what it actually is. Must
 * END in '_test' (the schema suite's own name) or '_test_accounting' (the
 * accounting suite's — see `accountingDatabaseName` above), exactly like
 * `assertTestTarget`'s own `endsWith('_test')` check.
 */
export function assertTestDatabaseName(url: string, envVarName: string): void {
  const parsed = new URL(url)
  const database = parsed.pathname.replace(/^\//, '')
  if (!database.endsWith('_test') && !database.endsWith('_test_accounting')) {
    throw new Error(
      `Refusing to run: ${envVarName} points at "${database}" (${describeTarget(url)}), which is ` +
        'not a test database name — it must end in "_test" or "_test_accounting". Accounting seat ' +
        'ruling, 2026-10-01: this guard exists so the Invariant 9 allowlist can never quietly start ' +
        'meaning something against staging or production.',
    )
  }
}

/** True for a PostgreSQL "database does not exist" error (3D000). */
function isMissingDatabaseError(error: unknown): boolean {
  return sqlstate(error) === '3D000'
}

/** True for a PostgreSQL "database already exists" error (42P04) — a creation race, not a failure. */
function isDuplicateDatabaseError(error: unknown): boolean {
  return sqlstate(error) === '42P04'
}

/** A database name safe to interpolate into DDL — CREATE DATABASE takes no bound parameter for it. */
const SAFE_DATABASE_NAME = /^[a-z][a-z0-9_]*$/

/**
 * The only hosts the cluster's bootstrap role may ever be used against.
 * Security seat review, 2026-10-01: `ensureAccountingDatabaseExists` did
 * not check the host at all — it logged in with finsoft_bootstrap (the
 * cluster's actual superuser-equivalent) against whatever host
 * TEST_ACCOUNTING_MIGRATION_DATABASE_URL named, including one from a
 * misconfigured or hostile environment. There is no legitimate reason for
 * that login to ever leave the local test cluster.
 */
const LOCAL_DATABASE_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Refuse to proceed if `url`'s host is not one of `LOCAL_DATABASE_HOSTS`.
 * Checked BEFORE any connection is attempted — including the cheap,
 * non-bootstrap probe connection `ensureAccountingDatabaseExists` makes
 * first, so a bad host is refused even on the fast path that never touches
 * finsoft_bootstrap.
 */
export function assertLocalDatabaseHost(url: string): void {
  const parsed = new URL(url)
  // WHATWG URL keeps IPv6 hosts bracketed ("[::1]"); normalise before
  // comparing against the literal "::1" in LOCAL_DATABASE_HOSTS.
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!LOCAL_DATABASE_HOSTS.has(host)) {
    throw new Error(
      `Refusing to connect to "${host}" (${describeTarget(url)}). The accounting test database's ` +
        'bootstrap connection may only ever target localhost, 127.0.0.1 or ::1 — Security seat ' +
        'review, 2026-10-01.',
    )
  }
}

/**
 * Create the accounting database and grant it exactly like
 * infrastructure/docker/postgres/init/00-bootstrap.sh grants the main test
 * database, the first time anything asks for it on this cluster. A no-op,
 * fast, on every run after that.
 *
 * finsoft_migration deliberately has no CREATEDB (00-bootstrap.sh's own
 * comment: "finsoft_migration has no CREATEROLE... this role cannot be
 * created by a migration"; the same is true of CREATEDB, which is never
 * granted to it either) — so this is the one place a test helper needs the
 * cluster's actual bootstrap role, finsoft_bootstrap, which is why it is
 * the only function in this file that reads POSTGRES_BOOTSTRAP_USER /
 * POSTGRES_BOOTSTRAP_PASSWORD. Both are already in .env.example — this
 * needs no new infrastructure or .env entry.
 */
async function ensureAccountingDatabaseExists(migrationUrl: string): Promise<void> {
  assertLocalDatabaseHost(migrationUrl)

  const dbName = new URL(migrationUrl).pathname.replace(/^\//, '')
  if (!SAFE_DATABASE_NAME.test(dbName)) {
    throw new Error(
      `Refusing to create a database named "${dbName}" — it must match ${SAFE_DATABASE_NAME} to be ` +
        'safely interpolated into CREATE DATABASE, which takes no bound parameter for an identifier.',
    )
  }

  // Fast path: true on every run after the first.
  const probe = new Client({ connectionString: migrationUrl })
  try {
    await probe.connect()
    await probe.end()
    return
  } catch (error) {
    if (!isMissingDatabaseError(error)) throw error
  }

  const bootstrapUser = requireEnv(
    'POSTGRES_BOOTSTRAP_USER',
    "Creating the accounting test database for the first time needs the cluster's bootstrap role " +
      '(.env.example).',
  )
  const bootstrapPassword = requireEnv(
    'POSTGRES_BOOTSTRAP_PASSWORD',
    "Creating the accounting test database for the first time needs the cluster's bootstrap role " +
      '(.env.example).',
  )

  const adminUrl = new URL(migrationUrl)
  adminUrl.username = encodeURIComponent(bootstrapUser)
  adminUrl.password = encodeURIComponent(bootstrapPassword)
  adminUrl.pathname = '/postgres'

  const admin = new Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  try {
    // OWNER/TEMPLATE/ENCODING/LOCALE exactly as 00-bootstrap.sh creates the
    // main test database, so the two are indistinguishable except by name.
    await admin.query(
      `CREATE DATABASE "${dbName}" OWNER finsoft_migration TEMPLATE template0 ` +
        `ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'`,
    )
  } catch (error) {
    if (!isDuplicateDatabaseError(error)) throw error // lost a creation race — another process won it
  } finally {
    await admin.end()
  }

  const grantsUrl = new URL(adminUrl)
  grantsUrl.pathname = `/${dbName}`
  const grants = new Client({ connectionString: grantsUrl.toString() })
  await grants.connect()
  try {
    await grants.query(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC`)
    await grants.query(`GRANT CONNECT ON DATABASE "${dbName}" TO finsoft_app, readonly_support`)
    await grants.query('ALTER SCHEMA public OWNER TO finsoft_migration')
    await grants.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
    await grants.query('GRANT USAGE ON SCHEMA public TO finsoft_app, readonly_support')
    await grants.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration IN SCHEMA public ' +
        'GRANT SELECT, INSERT, UPDATE ON TABLES TO finsoft_app',
    )
    await grants.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration IN SCHEMA public ' +
        'GRANT SELECT ON TABLES TO readonly_support',
    )
    await grants.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration IN SCHEMA public ' +
        'GRANT USAGE, SELECT ON SEQUENCES TO finsoft_app',
    )
    await grants.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration IN SCHEMA public ' +
        'GRANT SELECT ON SEQUENCES TO readonly_support',
    )
  } finally {
    await grants.end()
  }
}

/** Bring the accounting database up to the latest migration, creating it first if needed. */
export async function migrateAccountingTestDatabase(): Promise<void> {
  loadEnvFile()

  if (resolve(process.cwd()) !== REPO_ROOT) process.chdir(REPO_ROOT)

  const migrationUrl = resolveAccountingMigrationDatabaseUrl()
  assertTestDatabaseName(migrationUrl, 'TEST_ACCOUNTING_MIGRATION_DATABASE_URL')

  await ensureAccountingDatabaseExists(migrationUrl)

  const previous = process.env['MIGRATION_DATABASE_URL']
  process.env['MIGRATION_DATABASE_URL'] = migrationUrl
  try {
    const { migrate } = await import('../migrate/apply.ts')
    await migrate()
  } finally {
    if (previous === undefined) delete process.env['MIGRATION_DATABASE_URL']
    else process.env['MIGRATION_DATABASE_URL'] = previous
  }
}

/**
 * The accounting-suite equivalent of `prepareTestDatabase`. Idempotent, so
 * every tests/accounting and tests/reconciliation spec file can call it in
 * `beforeAll` exactly the way the schema suite calls `prepareTestDatabase`.
 */
export async function prepareAccountingTestDatabase(): Promise<void> {
  if (accountingPrepared) return

  loadEnvFile()

  const url = resolveAccountingDatabaseUrl()
  assertAccountingTestTarget(url)
  // `openDatabase`/`getPool` read ACCOUNTING_TEST_TARGET.urlVar
  // (TEST_ACCOUNTING_DATABASE_URL) straight from process.env — the derived
  // fallback above is only a local value until this line makes it the one
  // the pool actually sees, exactly like migrateAccountingTestDatabase does
  // for MIGRATION_DATABASE_URL below.
  process.env['TEST_ACCOUNTING_DATABASE_URL'] = url

  process.env['DATABASE_POOL_MAX'] ??= '1'

  await migrateAccountingTestDatabase()
  await openDatabase(ACCOUNTING_TEST_TARGET)

  accountingPrepared = true
}

export async function teardownAccountingTestDatabase(): Promise<void> {
  accountingPrepared = false
  await closeDatabase()
}

/**
 * The database name database/tests, tests/security, tests/integration and
 * tests/performance all share (TEST_DATABASE_URL). Exported so
 * ar-invariant-9.ts's contamination tripwire can compare it against
 * `current_database()` without duplicating the derivation.
 */
export function schemaSuiteDatabaseName(): string {
  loadEnvFile()
  const url = requireEnv(
    'TEST_DATABASE_URL',
    'Needed to name the database the accounting suite must stay isolated from.',
  )
  return new URL(url).pathname.replace(/^\//, '')
}

/**
 * Every tenant code currently sitting in the SCHEMA suite's own database
 * (TEST_DATABASE_URL) — a short-lived, one-off connection, opened and
 * closed within this call, never the long-lived pool `getPool()` manages.
 * ADR-0013's one-pool-per-process rule governs that pool, used for the
 * whole process's application/test transactions; this is a narrow,
 * reviewed exception for exactly one diagnostic read, the same shape as
 * `rawOn`'s exception for raw SQL (see the note at the top of this file).
 *
 * Used only by ar-invariant-9.ts's contamination tripwire, to prove that
 * no tenant the accounting sweep is about to check also exists in the
 * database database/tests (and tests/security, tests/integration,
 * tests/performance) actually use. If `tenants` does not exist yet there
 * (nobody has migrated it), that is "nothing to compare against", not a
 * failure — treated as an empty set, with a console warning rather than a
 * silent return, so it is still visible in the log.
 */
export async function schemaSuiteTenantCodes(): Promise<readonly string[]> {
  loadEnvFile()
  const url = requireEnv(
    'TEST_DATABASE_URL',
    "Needed to check the accounting suite is isolated from the schema suite's own database.",
  )
  assertTestTarget(url)

  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ code: string }>('SELECT code FROM tenants')
    return rows.map((row) => row.code)
  } catch (error) {
    if (sqlstate(error) === '42P01') {
      // eslint-disable-next-line no-console -- visible-but-not-fatal: the schema database is simply unmigrated
      console.log(
        '[testing/harness] schemaSuiteTenantCodes: "tenants" does not exist yet in the schema ' +
          'database — treating it as empty.',
      )
      return []
    }
    throw error
  } finally {
    await client.end()
  }
}

/* ------------------------------------------------------------------ *
 * Running things
 * ------------------------------------------------------------------ */

/**
 * Establish a tenant context the way the auth guard does, then run `fn`.
 *
 * This is the only legitimate way a tenant id enters the system: verified
 * first, put into the context, and read from there by `withTenant`. A test
 * that wants to act as a tenant has to go through the same door production
 * code does.
 */
export function runAs<T>(principal: TenantPrincipal, fn: () => Promise<T>): Promise<T> {
  return TenantContext.run(principal, fn)
}

/**
 * The live pool's checked-out/idle/waiting connection counts.
 *
 * C1, architecture re-review 2026-09-27: proving "no connection is held
 * across argon2id" needs a way to observe the pool's own bookkeeping from
 * outside `packages/database` — `getPool()` is deliberately not part of the
 * package's public surface (index.ts's own header: "a connection outside a
 * scoped transaction" is exactly the shape of bug ADR-0013 exists to rule
 * out), so this is the one, narrow, test-only door to it, the same pattern
 * `rawOn`/`scalarOn` already use for raw SQL. `total - idle` is the number
 * of connections currently checked out for active work; a caller mid-`await`
 * on argon2 while still holding a connection would show up here as > 0.
 */
export function poolStats(): { total: number; idle: number; waiting: number } {
  const pool = getPool()
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
}

/**
 * Execute raw SQL on a transaction handle, with bound parameters.
 *
 * See the note at the top of this file. This is the adversarial path — the
 * bare `SELECT * FROM users` that rule 8 requires RLS to make safe — and it
 * is deliberately not available outside the test harness.
 */
export async function rawOn<R>(
  tx: TenantTx | GlobalTx,
  text: string,
  parameters: readonly unknown[] = [],
): Promise<R[]> {
  const executor = tx as unknown as Kysely<Database>
  const result = await executor.executeQuery<R>(CompiledQuery.raw(text, [...parameters]))
  return [...result.rows]
}

/**
 * A single scalar from a raw query, or undefined when no row came back.
 * Saves every caller writing the same `rows[0]?.value` dance.
 */
export async function scalarOn<V>(
  tx: TenantTx | GlobalTx,
  text: string,
  parameters: readonly unknown[] = [],
): Promise<V | undefined> {
  const rows = await rawOn<Record<string, V>>(tx, text, parameters)
  const first = rows[0]
  if (!first) return undefined
  return Object.values(first)[0]
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * A run-unique suffix.
 *
 * Nothing here cleans up after itself, and that is deliberate rather than
 * lazy: rule 4 means no role holds DELETE, and granting it to finsoft_app so
 * that tests could tidy up would weaken the very posture under test. The
 * test cluster is disposable — `npm run db:reset` — so rows accumulate until
 * someone destroys the volume, and every fixture is named uniquely so
 * repeated runs cannot collide.
 */
export function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
}

export interface TenantFixture {
  readonly tenantId: string
  readonly code: string
  /** The tenant's provisioned owner: the one user per tenant with no created_by. */
  readonly ownerId: string
}

/**
 * QA-001: fixed-width uniqueness suffix for `createTenantFixture`'s tenant
 * code, reserved by construction rather than whatever happens to survive a
 * blind `.slice(0, 16)`.
 *
 * `tenants.code` is `CHECK (code ~ '^[A-Z][A-Z0-9_]{1,15}$')`
 * (database/migrations/001_create_tenants.sql) — 2 to 16 characters total.
 * The old code built `T${label}${unique()}`.slice(0, 16)`: for a short label
 * that left most of `unique()` intact, but for a label as long as
 * 'GOLDEN_A'/'GOLDEN_B' (tests/accounting/golden-posting-runner.ts) or
 * 'M3RUNNER' (tests/accounting/golden-posting-runner-m3.spec.ts, via the
 * 'TM3RUNNER' alias override) — 8 characters — the slice cut INTO the random
 * suffix instead of the label, so parallel runs collided on
 * `tenants_code_key`. Worse under a frozen clock: when a spec file fakes
 * `Date` to a fixed instant (tests/accounting/posting-scenarios-m3.spec.ts's
 * `runAtScenarioClock`, documented there as a harness.ts finding this lane
 * could not fix because it is outside that lane's ALLOWED paths),
 * `unique()`'s `Date.now()` component stops varying at all and every bit of
 * uniqueness has to come from whatever of `Math.random()`'s slice survived
 * the truncation.
 *
 * The fix: a fixed budget, split so the label is truncated, never the
 * suffix.
 *
 *   1 ('T') + TENANT_CODE_LABEL_LIMIT + TENANT_CODE_SUFFIX_LENGTH === 16
 *
 * TENANT_CODE_SUFFIX_LENGTH is 7, which makes TENANT_CODE_LABEL_LIMIT 8 —
 * deliberately sized to be exactly long enough that 'GOLDEN_A', 'GOLDEN_B'
 * and 'M3RUNNER' (each 8 characters) survive WHOLE, unmodified, in the first
 * `1 + label.length` characters of the code. That is load-bearing: the
 * accounting-seat allowlist in tests/accounting/ar-invariant-9.ts
 * (`TEST_ONLY_TENANT_CODE_PREFIXES = ['TKR', 'TM3RUNNER']`) matches tenant
 * codes by literal prefix, and 'TM3RUNNER' is 9 characters — it would stop
 * matching if this budget ever truncated 'M3RUNNER' itself. 'KR'/'KR2'
 * (kernel-rules.spec.ts) are short enough that no budget here could touch
 * them. A unit test next to this file (`harness-tenant-code.spec.ts`) pins
 * both the 10,000-code uniqueness property and this exact prefix behaviour.
 *
 * The suffix itself is never silently shortened again: `tenantCodeSuffix()`
 * always returns exactly 7 characters, built from a per-process monotonic
 * counter (unique BY CONSTRUCTION for the first 46,656 calls in one process
 * — vastly more than any suite creates, and certainly more than the 10,000
 * the unit test demands, so that test cannot pass by luck) plus 4 random
 * characters for distinctness ACROSS processes (parallel vitest workers,
 * repeated `npm run test:*` invocations against the same disposable
 * cluster).
 */
const TENANT_CODE_SUFFIX_LENGTH = 7
const TENANT_CODE_LABEL_LIMIT = 16 - 1 - TENANT_CODE_SUFFIX_LENGTH

let tenantCodeSequence = 0

/** Exactly `TENANT_CODE_SUFFIX_LENGTH` characters, unique by construction. */
function tenantCodeSuffix(): string {
  tenantCodeSequence = (tenantCodeSequence + 1) % 36 ** 3
  const sequence = tenantCodeSequence.toString(36).toUpperCase().padStart(3, '0')
  const random = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0')
  return `${sequence}${random}`
}

/**
 * The pure half of `createTenantFixture`'s code construction — no database,
 * so `harness-tenant-code.spec.ts` can call this 10,000 times directly
 * instead of provisioning 10,000 real tenants.
 */
export function buildTenantCode(label: string): string {
  return `T${label.slice(0, TENANT_CODE_LABEL_LIMIT)}${tenantCodeSuffix()}`
}

/**
 * Create a tenant and its provisioned owner, through the real API surface.
 *
 * The two steps are deliberately different shapes, because they are different
 * situations:
 *
 *   `withGlobal` writes the `tenants` row. There is no tenant context yet —
 *   this is precisely ADR-0013:102's "tenant provisioning" case, and it is
 *   why the exception exists.
 *
 *   `withTenant` writes the first user, under the context that now exists.
 *   Its `created_by` is NULL because no user of this tenant existed to
 *   author it; migration 002 permits exactly one such row per tenant.
 */
export async function createTenantFixture(label: string): Promise<TenantFixture> {
  const code = buildTenantCode(label)

  const tenantId = await withGlobal(async (tx) => {
    const row = await tx
      .insertInto('tenants')
      .values({ code, name: `Fixture ${code}` })
      .returning('id')
      .executeTakeFirstOrThrow()

    /*
     * ADR-0020 §5: the anchor is created in the SAME transaction as the
     * tenants insert, before the tenant is generally visible. No production
     * tenant-provisioning code exists in this repository yet (see the note
     * at the top of database/migrations/009_create_audit_log.sql) — this
     * fixture is the only thing that creates a tenant today, so it is
     * updated to call the same helper real provisioning must call, rather
     * than leaving every fixture tenant in this test suite unable to ever
     * append an audit record.
     */
    await createAuditChainAnchor(tx, row.id)

    return row.id
  })

  const ownerId = await runAs({ tenantId, userId: null }, () =>
    withTenant(async (tx) => {
      const row = await tx
        .insertInto('users')
        .values({
          tenant_id: tenantId,
          email: `owner.${code.toLowerCase()}@example.test`,
          full_name: `Owner of ${code}`,
          status: 'INVITED',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    }),
  )

  return { tenantId, code, ownerId }
}

export interface PostgresError {
  code?: string
  message: string
}

/** The SQLSTATE of a thrown error, or undefined if it was not a database error. */
export function sqlstate(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as PostgresError).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}
