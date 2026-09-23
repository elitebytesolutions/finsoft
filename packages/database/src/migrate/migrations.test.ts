import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertAppliedUnchanged } from './apply.ts'
import {
  assertSequential,
  checksumOf,
  findDestructiveStatements,
  loadMigrations,
  parseManifest,
  renderManifest,
  type Migration,
} from './migrations.ts'
import { verifyMigrations } from './verify.ts'

/*
 * The guarantees ADR-0013 claims for the migration framework, executed.
 *
 * These are the checks that make "applied migrations are immutable" a
 * property rather than a policy, so they are tested against real files on
 * disk rather than mocks.
 */

let root: string

function writeMigration(filename: string, sql: string): void {
  writeFileSync(join(root, 'database', 'migrations', filename), sql, 'utf8')
}

function writeManifest(text: string): void {
  writeFileSync(join(root, 'database', 'migrations', 'CHECKSUMS'), text, 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'finsoft-migrations-'))
  mkdirSync(join(root, 'database', 'migrations'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('checksums', () => {
  it('normalises line endings', () => {
    // Authoring is on Windows, CI is Linux. Hashing raw bytes would make the
    // immutability check fire on a fresh clone rather than on a real edit.
    expect(checksumOf('CREATE TABLE t ();\r\n')).toBe(checksumOf('CREATE TABLE t ();\n'))
  })

  it('changes when the content changes', () => {
    expect(checksumOf('SELECT 1')).not.toBe(checksumOf('SELECT 2'))
  })

  it('round-trips through the manifest', () => {
    writeMigration('001_a.sql', 'CREATE TABLE a ();')
    writeMigration('002_b.sql', 'CREATE TABLE b ();')
    const migrations = loadMigrations(root)
    const parsed = parseManifest(renderManifest(migrations))
    expect(parsed.get('001_a.sql')).toBe(migrations[0]!.checksum)
    expect(parsed.get('002_b.sql')).toBe(migrations[1]!.checksum)
  })
})

describe('filenames and ordering', () => {
  it('rejects a filename that is not NNN_snake_case.sql', () => {
    writeMigration('create-tenants.sql', 'SELECT 1')
    expect(() => loadMigrations(root)).toThrow(/does not match/)
  })

  it('rejects a gap in the sequence', () => {
    writeMigration('001_a.sql', 'SELECT 1')
    writeMigration('003_c.sql', 'SELECT 1')
    expect(() => assertSequential(loadMigrations(root))).toThrow(/expected 002/)
  })

  it('accepts a contiguous sequence', () => {
    writeMigration('001_a.sql', 'SELECT 1')
    writeMigration('002_b.sql', 'SELECT 1')
    expect(() => assertSequential(loadMigrations(root))).not.toThrow()
  })
})

describe('transaction marker', () => {
  it('wraps a migration in a transaction by default', () => {
    writeMigration('001_a.sql', 'CREATE TABLE a ();')
    expect(loadMigrations(root)[0]!.runInTransaction).toBe(true)
  })

  it('honours -- finsoft:no-transaction for CREATE INDEX CONCURRENTLY', () => {
    writeMigration(
      '001_a.sql',
      '-- finsoft:no-transaction\nCREATE INDEX CONCURRENTLY a_idx ON a (id);',
    )
    expect(loadMigrations(root)[0]!.runInTransaction).toBe(false)
  })
})

describe('destructive statements', () => {
  const cases: Array<[string, string]> = [
    ['DROP TABLE tenants;', 'DROP TABLE'],
    ['ALTER TABLE t DROP COLUMN c;', 'DROP COLUMN'],
    ['DROP INDEX t_idx;', 'DROP INDEX'],
    ['TRUNCATE tenants;', 'TRUNCATE'],
    ['ALTER TABLE t DROP CONSTRAINT t_chk;', 'DROP CONSTRAINT'],
    ['ALTER TABLE t ALTER COLUMN amount TYPE numeric(19,4);', 'ALTER COLUMN ... TYPE'],
    ['DROP POLICY tenant_isolation ON t;', 'DROP POLICY'],
    ['ALTER TABLE t DISABLE ROW LEVEL SECURITY;', 'DISABLE ROW LEVEL SECURITY'],
  ]

  it.each(cases)('flags %s', (sql, label) => {
    writeMigration('001_a.sql', sql)
    expect(findDestructiveStatements(loadMigrations(root)[0]!)).toContain(label)
  })

  it('does not flag a statement merely named in a comment', () => {
    writeMigration('001_a.sql', '-- we do not DROP TABLE here, ever\nCREATE TABLE a ();')
    expect(findDestructiveStatements(loadMigrations(root)[0]!)).toEqual([])
  })

  it('leaves an ordinary migration alone', () => {
    writeMigration('001_a.sql', 'CREATE TABLE a (id uuid PRIMARY KEY);')
    expect(findDestructiveStatements(loadMigrations(root)[0]!)).toEqual([])
  })
})

describe('verifyMigrations', () => {
  it('passes a well-formed set', () => {
    writeMigration('001_a.sql', 'CREATE TABLE a ();')
    writeManifest(renderManifest(loadMigrations(root)))
    expect(verifyMigrations(root).filter((f) => f.severity === 'error')).toEqual([])
  })

  it('fails when an applied migration has been edited', () => {
    writeMigration('001_a.sql', 'CREATE TABLE a ();')
    writeManifest(renderManifest(loadMigrations(root)))
    writeMigration('001_a.sql', 'CREATE TABLE a (); -- edited after the fact')

    const errors = verifyMigrations(root).filter((f) => f.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toMatch(/has changed since its checksum was recorded/)
  })

  it('fails when a migration is missing from the manifest', () => {
    writeMigration('001_a.sql', 'CREATE TABLE a ();')
    writeManifest(renderManifest(loadMigrations(root)))
    writeMigration('002_b.sql', 'CREATE TABLE b ();')

    const errors = verifyMigrations(root).filter((f) => f.severity === 'error')
    expect(errors.some((e) => e.message.includes('002_b.sql is not in'))).toBe(true)
  })

  it('rejects a down section — migrations are forward-only', () => {
    writeMigration('001_a.sql', 'CREATE TABLE a ();\n-- Down\nDROP TABLE a;')
    writeManifest(renderManifest(loadMigrations(root)))

    const errors = verifyMigrations(root).filter((f) => f.severity === 'error')
    expect(errors.some((e) => e.message.includes('forward-only'))).toBe(true)
  })

  it('routes a destructive statement to review rather than blocking it', () => {
    writeMigration('001_a.sql', 'DROP TABLE legacy_import;')
    writeManifest(renderManifest(loadMigrations(root)))

    const findings = verifyMigrations(root)
    expect(findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(findings.filter((f) => f.severity === 'review')).toHaveLength(1)
  })
})

describe('assertAppliedUnchanged', () => {
  const onDisk: Migration[] = [
    {
      version: 1,
      filename: '001_a.sql',
      path: '001_a.sql',
      sql: 'CREATE TABLE a ();',
      checksum: 'aaa',
      runInTransaction: true,
    },
  ]

  it('accepts a matching set', () => {
    expect(() =>
      assertAppliedUnchanged([{ version: 1, filename: '001_a.sql', checksum: 'aaa' }], onDisk),
    ).not.toThrow()
  })

  it('rejects a checksum that no longer matches', () => {
    expect(() =>
      assertAppliedUnchanged([{ version: 1, filename: '001_a.sql', checksum: 'bbb' }], onDisk),
    ).toThrow(/has changed since it was applied/)
  })

  it('rejects an applied migration that has disappeared', () => {
    expect(() =>
      assertAppliedUnchanged([{ version: 9, filename: '009_gone.sql', checksum: 'zzz' }], onDisk),
    ).toThrow(/no longer exists on disk/)
  })

  it('rejects a renamed file', () => {
    expect(() =>
      assertAppliedUnchanged(
        [{ version: 1, filename: '001_old_name.sql', checksum: 'aaa' }],
        onDisk,
      ),
    ).toThrow(/now named/)
  })
})
