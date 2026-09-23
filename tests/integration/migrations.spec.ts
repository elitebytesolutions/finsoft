import { withGlobal } from '@finsoft/database'
import {
  migrateTestDatabase,
  prepareTestDatabase,
  rawOn,
  scalarOn,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * Migrations, against a real database.
 *
 * `prepareTestDatabase` migrates a disposable cluster from whatever state it
 * is in, so by the time these run the schema has been built by the same
 * runner that will build staging and production. What is asserted here is the
 * two properties that make that safe to run repeatedly:
 *
 *   1. everything on disk is applied — no silently skipped file;
 *   2. running it again applies nothing — idempotent, not merely tolerant.
 *
 * (2) matters because the deploy runs migrations on EVERY deployment
 * (infrastructure/staging/deploy.sh). If a re-run were not a no-op, every
 * deploy would mutate the schema of a system that is already serving.
 */

interface AppliedRow {
  version: number
  filename: string
  checksum: string
}

const appliedRows = (): Promise<AppliedRow[]> =>
  withGlobal((tx) =>
    rawOn<AppliedRow>(tx, 'SELECT version, filename, checksum FROM schema_migrations ORDER BY 1'),
  )

const appliedCount = (): Promise<number> =>
  withGlobal(async (tx) =>
    Number(await scalarOn<string>(tx, 'SELECT count(*)::text FROM schema_migrations')),
  )

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

describe('a fresh database migrates', () => {
  it('applied every migration that exists on disk', async () => {
    const { readdirSync } = await import('node:fs')
    const { REPO_ROOT } = await import('@finsoft/database/testing')
    const { join } = await import('node:path')

    const onDisk = readdirSync(join(REPO_ROOT, 'database', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    const applied = (await appliedRows()).map((r) => r.filename).sort()

    expect(applied).toEqual(onDisk)
    expect(onDisk.length, 'there should be migrations to apply').toBeGreaterThan(0)
  })

  it('built the tables those migrations describe', async () => {
    const tables = await withGlobal((tx) =>
      rawOn<{ tablename: string }>(
        tx,
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
      ),
    )
    const names = tables.map((t) => t.tablename)

    /*
     * Asserted by name rather than by count: a count passes while the wrong
     * table exists, which is precisely the failure a migration bug produces.
     */
    expect(names).toContain('tenants')
    expect(names).toContain('users')
    expect(names).toContain('schema_migrations')
  })

  it('recorded a checksum for each, so a later edit is detectable', async () => {
    for (const row of await appliedRows()) {
      expect(row.checksum, `${row.filename} has no checksum`).toMatch(/^[0-9a-f]{16,}$/)
    }
  })
})

describe('re-running applies nothing twice', () => {
  it('leaves the ledger byte-identical', async () => {
    const before = await appliedRows()

    await migrateTestDatabase()

    const after = await appliedRows()

    /*
     * Same versions, same filenames, SAME CHECKSUMS. Comparing only the count
     * would pass if a migration were re-applied under a different checksum,
     * which is the interesting failure rather than the boring one.
     */
    expect(after).toEqual(before)
  })

  it('adds no rows however many times it runs', async () => {
    const before = await appliedCount()

    await migrateTestDatabase()
    await migrateTestDatabase()

    expect(await appliedCount()).toBe(before)
  })

  it('does not rewrite applied_at, so the audit of when it ran survives', async () => {
    const stamp = () =>
      withGlobal((tx) =>
        scalarOn<string>(tx, 'SELECT max(applied_at)::text FROM schema_migrations'),
      )

    const before = await stamp()
    await migrateTestDatabase()

    expect(await stamp()).toBe(before)
  })
})
