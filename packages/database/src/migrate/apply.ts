import { Client } from 'pg'
import { assertSequential, loadMigrations, type Migration } from './migrations.ts'

/*
 * The migration runner. ADR-0013.
 *
 * A separate CLI entrypoint that never executes on application start. It
 * connects as finsoft_migration — the one role with DDL and BYPASSRLS
 * (INFRASTRUCTURE §5) — which the running API and worker never use.
 *
 * It holds no Kysely instance and imports no generated types: it is raw SQL
 * against schema_migrations, so a fresh clone can migrate before any types
 * have ever been generated.
 */

/**
 * schema_migrations carries no tenant_id and has no RLS. It belongs on
 * ADR-0003's global-table allowlist alongside the other reference tables.
 */
const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version       integer     PRIMARY KEY,
    filename      text        NOT NULL UNIQUE,
    checksum      text        NOT NULL,
    applied_at    timestamptz NOT NULL DEFAULT now(),
    execution_ms  integer     NOT NULL
  )
`

/**
 * Two deploy replicas starting at once must not both migrate. The lock is
 * session-scoped and released when the connection closes, including on crash.
 * hashtext is deterministic, so every deployer computes the same key.
 */
const LOCK = "SELECT pg_advisory_lock(hashtext('finsoft.migrations')::bigint)"

export interface AppliedRow {
  version: number
  filename: string
  checksum: string
}

export interface MigrateResult {
  applied: Migration[]
  alreadyApplied: number
}

function connectionString(): string {
  const url = process.env.MIGRATION_DATABASE_URL
  if (!url) {
    throw new Error(
      'MIGRATION_DATABASE_URL is not set. The runner connects as finsoft_migration, ' +
        'never as the application role (INFRASTRUCTURE §5). Copy .env.example to .env.',
    )
  }
  return url
}

/**
 * Compare what the database says it has applied against what is on disk.
 * A mismatch means an applied migration was edited, which ADR-0013 forbids:
 * the schema of a database that ran the old text no longer matches the file.
 */
export function assertAppliedUnchanged(applied: AppliedRow[], onDisk: Migration[]): void {
  const byVersion = new Map(onDisk.map((m) => [m.version, m]))
  const problems: string[] = []

  for (const row of applied) {
    const file = byVersion.get(row.version)
    if (!file) {
      problems.push(`${row.filename} is recorded as applied but no longer exists on disk`)
      continue
    }
    if (file.filename !== row.filename) {
      problems.push(
        `version ${row.version} was applied as ${row.filename}, now named ${file.filename}`,
      )
    }
    if (file.checksum !== row.checksum) {
      problems.push(
        `${file.filename} has changed since it was applied ` +
          `(recorded ${row.checksum.slice(0, 12)}…, file ${file.checksum.slice(0, 12)}…)`,
      )
    }
  }

  if (problems.length > 0) {
    throw new Error(
      'Applied migrations are immutable (ADR-0013):\n  - ' +
        problems.join('\n  - ') +
        '\n\nCorrect a mistake with a new forward migration, never by editing one that ran.',
    )
  }
}

export async function migrate(options: { dryRun?: boolean } = {}): Promise<MigrateResult> {
  const onDisk = loadMigrations()
  assertSequential(onDisk)

  const client = new Client({ connectionString: connectionString() })
  await client.connect()

  try {
    await client.query(LOCK)
    await client.query(SCHEMA_MIGRATIONS_DDL)

    const { rows } = await client.query<AppliedRow>(
      'SELECT version, filename, checksum FROM schema_migrations ORDER BY version',
    )
    assertAppliedUnchanged(rows, onDisk)

    const appliedVersions = new Set(rows.map((r) => r.version))
    const pending = onDisk.filter((m) => !appliedVersions.has(m.version))

    if (options.dryRun) {
      return { applied: pending, alreadyApplied: rows.length }
    }

    const applied: Migration[] = []
    for (const migration of pending) {
      const started = Date.now()

      /*
       * One transaction per file: a migration applies whole or not at all,
       * and never leaves the schema half-changed. The exception is a file
       * marked -- finsoft:no-transaction, which exists for statements
       * PostgreSQL refuses to run inside a transaction, such as
       * CREATE INDEX CONCURRENTLY.
       */
      if (migration.runInTransaction) await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO schema_migrations (version, filename, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
          [migration.version, migration.filename, migration.checksum, Date.now() - started],
        )
        if (migration.runInTransaction) await client.query('COMMIT')
      } catch (error) {
        if (migration.runInTransaction) await client.query('ROLLBACK')
        /*
         * Keep the cause. PostgreSQL's error carries the SQLSTATE, the
         * character position and often a hint — which is the entire
         * diagnostic when a migration fails. Flattening it to a message
         * would leave whoever is mid-deploy guessing.
         */
        throw new Error(
          `Migration ${migration.filename} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      applied.push(migration)
    }

    return { applied, alreadyApplied: rows.length }
  } finally {
    await client.end()
  }
}

export async function status(): Promise<{ applied: AppliedRow[]; pending: Migration[] }> {
  const onDisk = loadMigrations()
  assertSequential(onDisk)

  const client = new Client({ connectionString: connectionString() })
  await client.connect()
  try {
    await client.query(SCHEMA_MIGRATIONS_DDL)
    const { rows } = await client.query<AppliedRow>(
      'SELECT version, filename, checksum FROM schema_migrations ORDER BY version',
    )
    const appliedVersions = new Set(rows.map((r) => r.version))
    return { applied: rows, pending: onDisk.filter((m) => !appliedVersions.has(m.version)) }
  } finally {
    await client.end()
  }
}
