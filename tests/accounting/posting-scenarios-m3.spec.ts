import { IMPLEMENTED_EVENTS } from '@finsoft/accounting-kernel'
import { closeDatabase } from '@finsoft/database'
import {
  migrateAccountingTestDatabase,
  prepareAccountingTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadScenario, runPostingScenario, type PostingScenario } from './golden-posting-runner.ts'
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
  await prepareAccountingTestDatabase()
  await migrateAccountingTestDatabase()
}, 120_000)

afterAll(async () => {
  await closeDatabase()
})

/**
 * `modules/receivables`' real use cases import the PRODUCTION kernel
 * singletons (`postingEngine`, `reversalEngine`, ADR-0028 statement 7) —
 * unlike `golden-posting-runner.ts`'s own JV path and the fake port, which
 * build a `createPostingEngine(fixedClock(...))` explicitly. Those
 * singletons use `systemClock` (`new Date()`), with NO caller-side way to
 * inject a test clock (found running P11 against the real module, M3-P
 * @efb7e3f: `currentOpenPeriod` resolved null because the kernel computed
 * "today" as the ACTUAL wall-clock date, not the scenario's fixed
 * `fixture.today` — the fixture's closed periods did not match the real
 * calendar's open one). Faking `Date` ALONE (not `setTimeout`/timers,
 * which real async I/O — the database driver included — depends on) for
 * exactly the scenario's own `fixture.today` is the fix: it is real
 * standard `Date`, reachable this way, with nothing kernel- or
 * module-side to change.
 */
async function runAtScenarioClock(
  scenario: PostingScenario,
  fn: () => Promise<void>,
): Promise<void> {
  /*
   * `createTenantFixture`'s own uniqueness (packages/database/src/testing/
   * harness.ts's `unique()`) is `Date.now().toString(36) + Math.random()...`,
   * truncated hard by the tenant code's 16-character limit for a label as
   * long as "GOLDEN_A"/"GOLDEN_B" — found running this file repeatedly
   * against the real module (M3-P @efb7e3f): with `Date` faked to the
   * SAME fixed instant for every scenario sharing a `fixture.today`, most
   * of `unique()`'s entropy collapses to whatever survives of
   * `Math.random()`'s slice, and `tenants_code_key` started colliding
   * across repeated runs. A little REAL-clock jitter, added to the fixed
   * instant, keeps `Date.now()` distinct per run without moving the
   * scenario off its own calendar day (well inside Asia/Karachi's UTC+5,
   * nowhere near midnight at T12:00). Not a fix to harness.ts (outside
   * this lane's ALLOWED paths) — reported as a real finding in the M3-Q
   * report; this is this file's own affordance for it.
   */
  const jitterMs = Date.now() % 60_000
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(
    new Date(new Date(`${scenario.fixture.today}T12:00:00.000Z`).getTime() + jitterMs),
  )
  try {
    await fn()
  } finally {
    vi.useRealTimers()
  }
}

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

    /*
     * A FRESH port per scenario, not the one shared `port` above (found
     * running the real module, M3-P @efb7e3f): `loadReceivablesRealPort()`
     * builds a port with its OWN document-ref -> id map
     * (receivables-real-port.ts), and every M3 golden file reuses the same
     * refs ("INV-A1", "RCT-A1", ...) — a shared port across scenarios
     * resolves a later scenario's "INV-A1" to an EARLIER scenario's
     * (different-tenant) invoice id. The availability probe above still
     * runs once; only the port each scenario actually posts through is
     * scenario-scoped.
     */
    for (const { file } of M3_SCENARIOS) {
      const scenario = loadScenario(file)
      const scenarioPort = await loadReceivablesRealPort()
      await runAtScenarioClock(scenario, () =>
        runPostingScenario(scenario, { receivables: scenarioPort! }),
      )
    }
  }, 180_000)
})
