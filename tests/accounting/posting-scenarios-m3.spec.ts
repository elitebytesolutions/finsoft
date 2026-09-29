import { IMPLEMENTED_EVENTS } from '@finsoft/accounting-kernel'
import { closeDatabase } from '@finsoft/database'
import { migrateTestDatabase, prepareTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadScenario, runPostingScenario } from './golden-posting-runner.ts'
import { loadReceivablesRealPort, receivablesModuleFileExists } from './receivables-real-port.ts'

/*
 * P04, P05, P06, P08 (invoice steps 6-9), P09, P10, P11, P12 — against the
 * REAL `modules/receivables`, once it exists. docs/design/M3/README.md §3
 * assigns exactly this to M3-Q: "the posting-scenario/v1 runner executing
 * P04, P05, P06, P08 (invoice steps), P09, P10" (P11/P12 land with M3-000c,
 * 2026-09-28, and belong to the same gate).
 *
 * Every scenario here is PENDING on this branch, honestly: `modules/
 * receivables` has zero files (confirmed at the time of writing — M3-P's
 * own branch carries no commits beyond `develop` either), and SALE_POSTED /
 * CUSTOMER_PAYMENT_RECEIVED are RULE_NOT_ENABLED. The gate test below
 * proves that state rather than assuming it, and reports EXACTLY which of
 * the two preconditions is missing — so this file is never silently wrong
 * about why it isn't running anything.
 *
 * The moment `loadReceivablesRealPort()` returns non-null (the module
 * exists AND matches this lane's guessed shape — receivables-real-port.ts)
 * and both events are IMPLEMENTED, the `describe.each` below runs for
 * real, against the real kernel, real migrations, real module. Nothing
 * here needs to change to pick that up; only golden-posting-registry.ts's
 * PENDING list needs to shrink, by hand, once a real green run is
 * observed (the same ratchet discipline as pending-baseline.json).
 */

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
}, 120_000)

afterAll(async () => {
  await closeDatabase()
})

const M3_SCENARIOS: readonly { readonly file: string; readonly title: string }[] = [
  { file: 'posting-p04-service-invoice.json', title: 'P04 — service invoice' },
  { file: 'posting-p05-customer-receipt.json', title: 'P05 — customer receipt' },
  { file: 'posting-p06-reversal.json', title: 'P06 — reversal' },
  // stepsExecutableFrom.M3 = [6,7,8,9] (the invoice steps); 1-5 (JV) are
  // M2's and already run in posting-scenarios.spec.ts. runPostingScenario
  // picks the M3 subset automatically once a receivables port is passed —
  // golden-posting-runner.ts's `runsAsM3`.
  { file: 'posting-p08-idempotent-retry.json', title: 'P08 — invoice steps (6-9)' },
  { file: 'posting-p09-mvp-journey.json', title: 'P09 — the MVP journey' },
  { file: 'posting-p10-service-line-rounding.json', title: 'P10 — service-line rounding' },
  { file: 'posting-p11-receipt-draft-lifecycle.json', title: 'P11 — receipt draft lifecycle' },
  { file: 'posting-p12-inactive-customer.json', title: 'P12 — inactive customer' },
]

describe('M3-P readiness gate for P04-P12', () => {
  it('stays green ONLY while truly nothing is ready; fails loudly the moment either half arrives without the other', async () => {
    const moduleExists = receivablesModuleFileExists()
    const eventsEnabled =
      IMPLEMENTED_EVENTS.has('SALE_POSTED') && IMPLEMENTED_EVENTS.has('CUSTOMER_PAYMENT_RECEIVED')
    const port = await loadReceivablesRealPort()

    console.warn(
      '\n  M3-P readiness for P04-P12:\n' +
        `    modules/receivables/index.ts exists: ${moduleExists}\n` +
        `    SALE_POSTED / CUSTOMER_PAYMENT_RECEIVED enabled: ${eventsEnabled}\n` +
        `    ReceivablesPort adapter matches (receivables-real-port.ts): ${port !== null}\n` +
        (moduleExists && port === null
          ? '    modules/receivables exists but its shape does not match this ' +
            "lane's guess yet — see receivables-real-port.ts's header.\n"
          : ''),
    )

    /*
     * Accounting seat review, 2026-09-29 (43be499): the first version of
     * this gate only ever warned and returned when `port === null` — which
     * silently treated "the module exists but this lane's guessed shape
     * does not match it" the SAME as "nothing exists yet". Those are not
     * the same state: the first means someone needs to look at
     * receivables-real-port.ts NOW, the second means there is genuinely
     * nothing to do yet. Passing green in the first case would have hidden
     * exactly the moment this file becomes useful.
     */
    if (moduleExists && port === null) {
      expect.fail(
        'modules/receivables/index.ts exists, but loadReceivablesRealPort() could not match ' +
          "it to this lane's guessed shape (receivables-real-port.ts's REQUIRED_EXPORTS). " +
          'Update that file to the real export names — this is not a state to stay green in.',
      )
    }
    if (eventsEnabled && port === null) {
      expect.fail(
        'SALE_POSTED / CUSTOMER_PAYMENT_RECEIVED are IMPLEMENTED_EVENTS, but no receivables ' +
          'port loaded. The kernel is ready and nothing is exercising it through this gate — ' +
          'update receivables-real-port.ts (or MODULE_PATH) to find the real module.',
      )
    }

    if (port === null) {
      // The honest, expected state on this branch today: NEITHER
      // precondition has fired. Asserted, not skipped, so a change that
      // makes this stop checking anything shows up as a diff.
      expect(moduleExists).toBe(false)
      expect(eventsEnabled).toBe(false)
      return
    }

    for (const { file } of M3_SCENARIOS) {
      await runPostingScenario(loadScenario(file), { receivables: port })
    }
  }, 180_000)
})
