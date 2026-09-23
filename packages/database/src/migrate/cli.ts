#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { migrate, status } from './apply.ts'
import { checksumsPath, loadMigrations, renderManifest } from './migrations.ts'
import { verifyMigrations } from './verify.ts'

/*
 * The migration CLI. ADR-0013.
 *
 * A separate entrypoint, never invoked on application start: it connects as
 * finsoft_migration, the one role holding DDL and BYPASSRLS, and the running
 * API and worker have no path to it.
 *
 *   migrate     apply pending migrations
 *   status      show applied and pending
 *   verify      static checks, no database required (this is the CI gate)
 *   checksums   regenerate the committed manifest after adding a migration
 */

const command = process.argv[2] ?? 'help'

async function main(): Promise<number> {
  switch (command) {
    case 'migrate': {
      const dryRun = process.argv.includes('--dry-run')
      const result = await migrate({ dryRun })
      if (result.applied.length === 0) {
        console.log(`  nothing to apply — ${result.alreadyApplied} migration(s) already applied`)
        return 0
      }
      for (const m of result.applied) {
        console.log(`  ${dryRun ? 'would apply' : 'applied'}  ${m.filename}`)
      }
      console.log(`\n  ${result.applied.length} migration(s) ${dryRun ? 'pending' : 'applied'}`)
      return 0
    }

    case 'status': {
      const { applied, pending } = await status()
      console.log(`  applied: ${applied.length}`)
      for (const row of applied) console.log(`    ✓ ${row.filename}`)
      console.log(`  pending: ${pending.length}`)
      for (const m of pending) console.log(`    … ${m.filename}`)
      return pending.length === 0 ? 0 : 0
    }

    case 'verify': {
      const findings = verifyMigrations()
      const errors = findings.filter((f) => f.severity === 'error')
      const review = findings.filter((f) => f.severity === 'review')

      for (const f of errors) console.log(`  ✗ ${f.message}`)
      for (const f of review) console.log(`  ! ${f.message}`)

      if (errors.length === 0) {
        const count = loadMigrations().length
        console.log(
          `  ✓ ${count} migration(s): numbering sequential, checksums match, forward-only`,
        )
      }
      if (review.length > 0) {
        console.log(`\n  ${review.length} item(s) need Database Guardian review before merge.`)
      }
      return errors.length === 0 ? 0 : 1
    }

    case 'checksums': {
      const migrations = loadMigrations()
      const path = checksumsPath()
      writeFileSync(path, renderManifest(migrations), 'utf8')
      console.log(`  wrote ${path} (${migrations.length} entries)`)
      console.log('  review the diff: an existing line changing means an edited migration.')
      return 0
    }

    default:
      console.log('usage: migrate | status | verify | checksums')
      return command === 'help' ? 0 : 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
