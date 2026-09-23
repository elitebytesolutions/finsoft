import { closeDatabase, openDatabase } from '@finsoft/database'
import { prepareTestDatabase, teardownTestDatabase } from '@finsoft/database/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
 * The startup guard, exercised by actually pointing the application at a
 * prohibited role.
 *
 * api-database.spec.ts asserts the role the test suite happens to be
 * configured with. That proves the configuration, not the safeguard — it
 * would pass identically on a system with no safeguard at all, which is the
 * distinction this file exists to close.
 *
 * Here the pool is deliberately pointed at finsoft_migration and at the
 * bootstrap superuser, and startup is required to REFUSE. Those are the two
 * mistakes that matter, because each produces a system that looks completely
 * healthy while every tenant can read every other tenant's rows.
 */

const TEST_URL = (): string => {
  const url = process.env['TEST_DATABASE_URL']
  if (!url) throw new Error('TEST_DATABASE_URL is required')
  return url
}

/** The same database, reached as a different role. */
function asRole(role: string, password: string): string {
  const url = new URL(TEST_URL())
  url.username = role
  url.password = password
  return url.toString()
}

beforeAll(prepareTestDatabase, 60_000)

/*
 * `prepareTestDatabase` leaves a pool open against TEST_TARGET, and the pool
 * is a module-level singleton — opening a second one throws "already open"
 * rather than reaching the guard. Each case therefore starts from closed and
 * opens exactly the connection it means to test.
 */
beforeEach(closeDatabase)

afterEach(async () => {
  // Each case opens its own pool; leaving one behind would leak a connection
  // into the next test and into the suite that runs after this file.
  await closeDatabase()
  delete process.env['GUARD_PROBE_URL']
})

afterAll(teardownTestDatabase)

const PROBE = { urlVar: 'GUARD_PROBE_URL', applicationName: 'finsoft-guard-probe' } as const

describe('startup refuses a role that bypasses RLS', () => {
  it('refuses finsoft_migration, which holds BYPASSRLS by design', async () => {
    process.env['GUARD_PROBE_URL'] = asRole(
      'finsoft_migration',
      process.env['POSTGRES_MIGRATION_PASSWORD'] ?? 'local-dev-only-migration',
    )

    await expect(openDatabase(PROBE)).rejects.toThrow(/BYPASSRLS/)
  })

  it('names the role it refused, so the fix is obvious from the log', async () => {
    process.env['GUARD_PROBE_URL'] = asRole(
      'finsoft_migration',
      process.env['POSTGRES_MIGRATION_PASSWORD'] ?? 'local-dev-only-migration',
    )

    await expect(openDatabase(PROBE)).rejects.toThrow(/finsoft_migration/)
  })

  it('says what to do instead', async () => {
    process.env['GUARD_PROBE_URL'] = asRole(
      'finsoft_migration',
      process.env['POSTGRES_MIGRATION_PASSWORD'] ?? 'local-dev-only-migration',
    )

    await expect(openDatabase(PROBE)).rejects.toThrow(/finsoft_app/)
  })

  it('refuses the bootstrap superuser', async () => {
    process.env['GUARD_PROBE_URL'] = asRole(
      process.env['POSTGRES_BOOTSTRAP_USER'] ?? 'finsoft_bootstrap',
      process.env['POSTGRES_BOOTSTRAP_PASSWORD'] ?? 'local-dev-only-bootstrap',
    )

    await expect(openDatabase(PROBE)).rejects.toThrow(/SUPERUSER/)
  })
})

describe('startup accepts the application role', () => {
  it('opens against finsoft_app without complaint', async () => {
    process.env['GUARD_PROBE_URL'] = TEST_URL()

    /*
     * The other half of the control. A guard that refused everything would
     * pass all four cases above and stop the application from ever starting —
     * so the permitted case is asserted too.
     */
    await expect(openDatabase(PROBE)).resolves.toBeUndefined()
  })
})
