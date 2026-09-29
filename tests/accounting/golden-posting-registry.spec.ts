import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '@finsoft/database/testing'
import { describe, expect, it } from 'vitest'
import { executableSteps, loadScenario } from './golden-posting-runner.ts'
import { EXECUTED_IN_M2, PENDING } from './golden-posting-registry.ts'

/*
 * No posting golden scenario is silently dropped. Every posting-p*.json is
 * executed by posting-scenarios.spec.ts or registered pending with a reason,
 * and the two lists agree with each file's own executableFrom metadata.
 */

const files = readdirSync(join(REPO_ROOT, 'tests', 'accounting', 'golden'))
  .filter((name) => /^posting-p\d+-.*\.json$/.test(name))
  .sort()

describe('posting golden scenarios: executed or pending, never neither', () => {
  it('finds the twelve posting scenarios README §6 lists', () => {
    expect(files).toHaveLength(12)
  })

  it.each(files)('%s is executed in M2 or pending with a reason', (file) => {
    const executed = EXECUTED_IN_M2.some((entry) => entry.file === file)
    const pending = PENDING.filter((entry) => entry.file === file)
    expect(executed || pending.length > 0, `${file} is in neither list`).toBe(true)
    for (const entry of pending) expect(entry.reason.length).toBeGreaterThan(0)

    const scenario = loadScenario(file)
    const allSteps = scenario.steps.map((step) => step.step as number)
    const pendingAll = pending.some((entry) => entry.steps === 'all')

    if (pendingAll) {
      // Wholly pending only if the file itself says it is not M2's.
      expect(executed, `${file}: wholly pending but also executed`).toBe(false)
      expect(scenario.executableFrom, `${file}: executableFrom`).not.toBe('M2')
      return
    }

    // Executed: the run steps plus the pending steps are exactly all steps.
    const run = executableSteps(scenario).map((step) => step.step as number)
    const pendingSteps = pending.flatMap((entry) => (entry.steps === 'all' ? [] : [...entry.steps]))
    expect(
      [...run, ...pendingSteps].sort((a, b) => a - b),
      `${file}: steps accounted for`,
    ).toEqual(allSteps)
    const m3 = scenario.stepsExecutableFrom?.M3 ?? []
    expect(
      [...pendingSteps].sort((a, b) => a - b),
      `${file}: pending steps are the M3 steps`,
    ).toEqual([...m3])
  })

  it('reports what is pending, so a green run is not mistaken for full coverage', () => {
    console.warn(
      '\n  Posting golden scenarios pending:\n' +
        PENDING.map(
          (entry) =>
            `    ${entry.file} ${entry.steps === 'all' ? '(all steps)' : `steps ${entry.steps.join(',')}`}: ${entry.reason}`,
        ).join('\n') +
        '\n',
    )
    expect(PENDING.length).toBeGreaterThan(0)
  })
})
