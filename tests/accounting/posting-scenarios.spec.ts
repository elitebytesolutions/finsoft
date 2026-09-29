import { closeDatabase } from '@finsoft/database'
import { migrateTestDatabase, prepareTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { loadScenario, runPostingScenario } from './golden-posting-runner.ts'
import { EXECUTED_IN_M2 } from './golden-posting-registry.ts'

/*
 * posting-scenario/v1 golden files, executed against the REAL kernel and a
 * real PostgreSQL (finsoft_app, RLS forced). docs/posting-rules/README.md §6.
 *
 * Which files run, and which steps of them, is golden-posting-registry.ts —
 * the registry spec proves every golden file is either executed here or
 * pending with a stated reason, so none can be silently dropped.
 */

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
}, 120_000)

afterAll(async () => {
  await closeDatabase()
})

for (const { file, title } of EXECUTED_IN_M2) {
  describe(title, () => {
    it('matches every hand-computed figure exactly', async () => {
      await runPostingScenario(loadScenario(file))
    }, 60_000)
  })
}
