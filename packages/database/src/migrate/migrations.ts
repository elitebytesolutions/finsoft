import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * Discovery, parsing and hashing of migration files. ADR-0013.
 *
 * Migrations are plain .sql, numbered, forward-only and immutable once
 * applied. Nothing here generates SQL or introspects the schema — the
 * database owns the schema and these files are how it gets there.
 */

export const MIGRATIONS_DIR = 'database/migrations'

/**
 * Path to the committed manifest, resolved against a root.
 *
 * It takes a root rather than being a constant because the checks must be
 * runnable against a directory other than the process's own — which is how
 * they are tested.
 */
export function checksumsPath(root = process.cwd()): string {
  return join(root, MIGRATIONS_DIR, 'CHECKSUMS')
}

/** Display form, for messages that tell a human which file to look at. */
export const CHECKSUMS_LABEL = `${MIGRATIONS_DIR}/CHECKSUMS`

/**
 * A migration whose DDL cannot run inside a transaction carries this on its
 * first line. CREATE INDEX CONCURRENTLY is the case that forces it; nothing
 * else should need it, and it is visible in the file rather than configured
 * elsewhere.
 */
const NO_TRANSACTION_MARKER = '-- finsoft:no-transaction'

const FILENAME_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/

export interface Migration {
  version: number
  filename: string
  path: string
  sql: string
  checksum: string
  runInTransaction: boolean
}

/**
 * Hash the LF-normalised content.
 *
 * Authoring happens on Windows and CI runs on Linux. Hashing raw bytes would
 * make every checksum platform-dependent and the immutability check would
 * fire on a fresh clone rather than on a real edit.
 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

export function loadMigrations(root = process.cwd()): Migration[] {
  const dir = join(root, MIGRATIONS_DIR)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  return files.map((filename) => {
    const match = FILENAME_PATTERN.exec(filename)
    if (!match) {
      throw new Error(
        `Migration "${filename}" does not match NNN_lower_snake_case.sql. ` +
          'Numbering is how order is established and it is not negotiable.',
      )
    }
    const path = join(dir, filename)
    const sql = readFileSync(path, 'utf8')
    return {
      version: Number(match[1]),
      filename,
      path,
      sql,
      checksum: checksumOf(sql),
      runInTransaction: !sql.trimStart().startsWith(NO_TRANSACTION_MARKER),
    }
  })
}

/**
 * Numbering must be strictly sequential from 001 with no gaps and no
 * duplicates.
 *
 * Two parallel worktrees will both reach for the next free number and collide
 * at merge. That is the intended behaviour, not a defect: it forces
 * migrations to serialise through review rather than interleave silently.
 */
export function assertSequential(migrations: Migration[]): void {
  const problems: string[] = []
  const seen = new Map<number, string>()

  migrations.forEach((m, index) => {
    const previous = seen.get(m.version)
    if (previous) {
      problems.push(`duplicate version ${m.version}: ${previous} and ${m.filename}`)
    }
    seen.set(m.version, m.filename)

    const expected = index + 1
    if (m.version !== expected) {
      problems.push(`expected ${String(expected).padStart(3, '0')}_*.sql, found ${m.filename}`)
    }
  })

  if (problems.length > 0) {
    throw new Error(`Migration numbering is broken:\n  - ${problems.join('\n  - ')}`)
  }
}

/**
 * Statement classes that need a Database Guardian's eyes.
 *
 * This does not block them — some are legitimate on a table that has never
 * held financial data. It flags them so branch protection routes the PR to
 * the required reviewer. A self-typed approval comment would be
 * self-certification, not a control.
 */
const DESTRUCTIVE = [
  { pattern: /\bDROP\s+TABLE\b/i, label: 'DROP TABLE' },
  { pattern: /\bDROP\s+COLUMN\b/i, label: 'DROP COLUMN' },
  { pattern: /\bDROP\s+INDEX\b/i, label: 'DROP INDEX' },
  { pattern: /\bTRUNCATE\b/i, label: 'TRUNCATE' },
  { pattern: /\bDROP\s+CONSTRAINT\b/i, label: 'DROP CONSTRAINT' },
  { pattern: /\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i, label: 'ALTER COLUMN ... TYPE' },
  { pattern: /\bDROP\s+POLICY\b/i, label: 'DROP POLICY' },
  { pattern: /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, label: 'DISABLE ROW LEVEL SECURITY' },
] as const

/** Strip comments so a statement named in prose does not trip the scan. */
function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

export function findDestructiveStatements(migration: Migration): string[] {
  const body = withoutComments(migration.sql)
  return DESTRUCTIVE.filter(({ pattern }) => pattern.test(body)).map(({ label }) => label)
}

/* ------------------------------------------------------------------ *
 * The committed checksum manifest
 *
 * This is the control that catches an edited migration in a pull request.
 * A schema_migrations comparison inside CI cannot: CI migrates an ephemeral
 * database from the very files under test, so its hashes always agree with
 * themselves no matter what changed.
 * ------------------------------------------------------------------ */

export function renderManifest(migrations: Migration[]): string {
  const header = [
    '# Checksums of applied migration files. ADR-0013.',
    '#',
    '# Append a line when a migration is added. Never edit an existing line:',
    '# CI recomputes these and fails if one changes, because an applied',
    '# migration is immutable. Correct a mistake with a new forward migration.',
    '#',
    '# sha256 of the file content, line endings normalised to LF.',
    '',
  ].join('\n')

  const body = migrations.map((m) => `${m.checksum}  ${m.filename}`).join('\n')
  return `${header}${body}\n`
}

export function parseManifest(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [checksum, filename] = trimmed.split(/\s+/)
    if (checksum && filename) entries.set(filename, checksum)
  }
  return entries
}
