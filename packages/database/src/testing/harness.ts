import { CompiledQuery, type Kysely } from 'kysely'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeTarget, requireEnv } from '../env.ts'
import { closeDatabase, openDatabase } from '../lifecycle.ts'
import type { PoolTarget } from '../pool.ts'
import type { Database } from '../schema.ts'
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
 * `DATABASE_POOL_MAX=1` is not a performance choice. It makes connection
 * reuse deterministic, which is the only way to assert the thing ADR-0004:140
 * asks for: that the next borrower of *the same* connection does not inherit
 * the previous transaction's `app.tenant_id`. With a larger pool the test
 * would usually get a different backend and pass without testing anything.
 */
export async function prepareTestDatabase(): Promise<void> {
  if (prepared) return

  loadEnvFile()

  const url = requireEnv('TEST_DATABASE_URL', 'The isolation suite runs against the test cluster.')
  assertTestTarget(url)

  process.env['DATABASE_POOL_MAX'] = '1'

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
  const code = `T${label}${unique()}`.slice(0, 16)

  const tenantId = await withGlobal(async (tx) => {
    const row = await tx
      .insertInto('tenants')
      .values({ code, name: `Fixture ${code}` })
      .returning('id')
      .executeTakeFirstOrThrow()
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
