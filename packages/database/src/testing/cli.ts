#!/usr/bin/env node
import { migrateTestDatabase } from './harness.ts'

/*
 * Test-database operations. FND-007/008.
 *
 * A separate entrypoint from packages/database/src/migrate/cli.ts, which
 * targets MIGRATION_DATABASE_URL — the development cluster. This one targets
 * TEST_MIGRATION_DATABASE_URL, so that "migrate the test database" is a
 * command rather than an environment variable a hurried operator has to
 * remember to override.
 *
 * The suites call the same function in `beforeAll`, so this exists for the
 * operator who wants the schema up to date without running the tests.
 *
 *   migrate    apply pending migrations to the test cluster
 */

const command = process.argv[2] ?? 'help'

async function main(): Promise<number> {
  switch (command) {
    case 'migrate':
      await migrateTestDatabase()
      console.log('  test database is up to date')
      return 0

    default:
      console.log('usage: migrate')
      return command === 'help' ? 0 : 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
