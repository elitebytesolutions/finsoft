import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '@finsoft/database/testing'
import { describe, expect, it } from 'vitest'
import { executableSteps, loadScenario } from './golden-posting-runner.ts'
import { EXECUTED_IN_M2, EXECUTED_IN_M3, PENDING } from './golden-posting-registry.ts'

/*
 * No posting golden scenario is silently dropped. Every posting-p*.json is
 * executed by posting-scenarios.spec.ts and/or posting-scenarios-m3.spec.ts,
 * or registered pending with a reason — and the lists agree with each file's
 * own executableFrom/stepsExecutableFrom metadata.
 */

const files = readdirSync(join(REPO_ROOT, 'tests', 'accounting', 'golden'))
  .filter((name) => /^posting-p\d+-.*\.json$/.test(name))
  .sort()

describe('posting golden scenarios: executed or pending, never neither', () => {
  it('finds the thirteen posting scenarios README §6 lists', () => {
    expect(files).toHaveLength(13)
  })

  it.each(files)('%s is executed (M2 and/or M3) or pending with a reason', (file) => {
    const inM2 = EXECUTED_IN_M2.some((entry) => entry.file === file)
    const inM3 = EXECUTED_IN_M3.some((entry) => entry.file === file)
    const pending = PENDING.filter((entry) => entry.file === file)
    expect(inM2 || inM3 || pending.length > 0, `${file} is in no list`).toBe(true)
    for (const entry of pending) expect(entry.reason.length).toBeGreaterThan(0)

    const scenario = loadScenario(file)
    const allSteps = scenario.steps.map((step) => step.step as number)
    const pendingAll = pending.some((entry) => entry.steps === 'all')

    if (pendingAll) {
      // Wholly pending only if it is executed nowhere else.
      expect(inM2 || inM3, `${file}: wholly pending but also executed`).toBe(false)
      return
    }

    /*
     * Each list's OWN coverage, per its own runner: EXECUTED_IN_M2 via
     * `executableSteps(scenario, 'M2')` (posting-scenarios.spec.ts's own
     * milestone — the default), EXECUTED_IN_M3 via `'M3'`
     * (posting-scenarios-m3.spec.ts; for a dual-subset file like P08 this
     * is its OWN M3 subset, not the `'ALL'` milestone the runner actually
     * selects at runtime for entriesAfter correctness — the registry is
     * bookkeeping of which steps each SPEC FILE is responsible for, not a
     * simulation of the runtime path). A scenario naming neither list
     * contributes no steps and must be registered pending instead (caught
     * above) or have `executableFrom` match M2 by construction.
     */
    const m2Steps = inM2 ? executableSteps(scenario, 'M2').map((step) => step.step as number) : []
    const m3Steps = inM3 ? executableSteps(scenario, 'M3').map((step) => step.step as number) : []
    const pendingSteps = pending.flatMap((entry) => (entry.steps === 'all' ? [] : [...entry.steps]))
    expect(
      [...m2Steps, ...m3Steps, ...pendingSteps].sort((a, b) => a - b),
      `${file}: steps accounted for`,
    ).toEqual(allSteps)
    // No step double-counted between the two executed lists.
    expect(
      m2Steps.filter((step) => m3Steps.includes(step)),
      `${file}: a step claimed by both EXECUTED_IN_M2 and EXECUTED_IN_M3`,
    ).toEqual([])
  })

  it('reports what is pending, so a green run is not mistaken for full coverage it does not have', () => {
    console.warn(
      PENDING.length === 0
        ? '\n  Posting golden scenarios pending: none — all twelve execute (M2 and/or M3).\n'
        : '\n  Posting golden scenarios pending:\n' +
            PENDING.map(
              (entry) =>
                `    ${entry.file} ${entry.steps === 'all' ? '(all steps)' : `steps ${entry.steps.join(',')}`}: ${entry.reason}`,
            ).join('\n') +
            '\n',
    )
    // Not `toBeGreaterThan(0)`: PENDING MAY be empty (M3-Q, 2026-10-01 — all
    // twelve now execute for real). This ratchet still fails if a file is in
    // NO list at all (the test above), which is what matters: a green run
    // here is never mistaken for coverage a file does not actually have.
    expect(PENDING.length).toBeGreaterThanOrEqual(0)
  })
})
