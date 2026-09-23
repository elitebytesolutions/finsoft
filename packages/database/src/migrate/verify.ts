import { existsSync, readFileSync } from 'node:fs'
import {
  assertSequential,
  CHECKSUMS_LABEL,
  checksumsPath,
  findDestructiveStatements,
  loadMigrations,
  parseManifest,
  type Migration,
} from './migrations.ts'

/*
 * Static checks over database/migrations. ADR-0013's Compliance section.
 *
 * These run in CI without a database, which is the point: the control that
 * catches an edited migration must not depend on the database that would be
 * migrated from the very files under test.
 */

export interface Finding {
  severity: 'error' | 'review'
  message: string
}

/** ADR-0013: rollback is a new forward migration, never a `down`. */
function findDownSection(migration: Migration): boolean {
  return /^\s*--\s*(down|rollback)\b/im.test(migration.sql)
}

export function verifyMigrations(root = process.cwd()): Finding[] {
  const findings: Finding[] = []
  const migrations = loadMigrations(root)

  try {
    assertSequential(migrations)
  } catch (error) {
    findings.push({ severity: 'error', message: (error as Error).message })
  }

  /* ---------------------------------------------------------------- *
   * The committed manifest.
   *
   * An existing line changing means THE FILE changed. It does NOT on its
   * own mean an APPLIED migration was edited — this check compares file to
   * manifest, so regenerating both together passes cleanly. The manifest is
   * a review aid whose diff has to be read.
   *
   * `assertAppliedUnchanged` in apply.ts is the control that catches an
   * edited migration, because it compares file hashes against
   * `schema_migrations` in the TARGET DATABASE. See ADR-0013's corrections;
   * this comment asserted the retracted claim.
   * ---------------------------------------------------------------- */
  const manifestPath = checksumsPath(root)
  if (!existsSync(manifestPath)) {
    if (migrations.length > 0) {
      findings.push({
        severity: 'error',
        message: `${CHECKSUMS_LABEL} is missing. Run: npm run db:checksums`,
      })
    }
  } else {
    const recorded = parseManifest(readFileSync(manifestPath, 'utf8'))
    for (const migration of migrations) {
      const known = recorded.get(migration.filename)
      if (!known) {
        findings.push({
          severity: 'error',
          message: `${migration.filename} is not in ${CHECKSUMS_LABEL}. Run: npm run db:checksums`,
        })
      } else if (known !== migration.checksum) {
        findings.push({
          severity: 'error',
          message:
            `${migration.filename} has changed since its checksum was recorded ` +
            `(manifest ${known.slice(0, 12)}…, file ${migration.checksum.slice(0, 12)}…). ` +
            'An applied migration is immutable — correct it with a new forward migration.',
        })
      }
    }
    for (const filename of recorded.keys()) {
      if (!migrations.some((m) => m.filename === filename)) {
        findings.push({
          severity: 'error',
          message: `${filename} is in ${CHECKSUMS_LABEL} but no longer on disk.`,
        })
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Content checks
   * ---------------------------------------------------------------- */
  for (const migration of migrations) {
    if (findDownSection(migration)) {
      findings.push({
        severity: 'error',
        message: `${migration.filename} contains a down/rollback section. Migrations are forward-only.`,
      })
    }

    const destructive = findDestructiveStatements(migration)
    if (destructive.length > 0) {
      findings.push({
        severity: 'review',
        message: `${migration.filename} contains ${destructive.join(', ')} — requires Database Guardian review.`,
      })
    }
  }

  return findings
}
