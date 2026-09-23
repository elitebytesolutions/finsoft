import { withGlobal, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  scalarOn,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * ── READ THIS BEFORE QUOTING A NUMBER FROM THIS FILE ────────────────────
 *
 * This is NOT the performance budget in ARCHITECTURE.md §11.
 *
 * §11 budgets a business transaction — posting a sale, which writes stock
 * movements, journal lines, numbering, audit and an outbox row inside one
 * transaction — at P95 < 800 ms on production-like hardware. None of that
 * exists yet, so none of it is measured here and no number below may be
 * presented as evidence about it. See README.md in this directory for who
 * owns that work and what it has to show.
 *
 * What IS measured: the round-trip cost of the foundation those transactions
 * will sit on. A connection acquired, a tenant context set, a trivial query,
 * the transaction committed. That is worth a test today because it catches
 * real regressions long before there is a business transaction to time:
 *
 *   - a pool misconfigured so that every call opens a fresh connection
 *   - a tenant context set with a round trip that could have been batched
 *   - a database pathologically slow for an environmental reason (no shared
 *     buffers, a volume on spinning rust, an accidental fsync-per-statement)
 *
 * The thresholds are deliberately loose. This runs on a developer laptop and
 * on a shared CI runner alongside other jobs, so a tight bound would fail for
 * reasons that have nothing to do with the code — and a performance test that
 * fails randomly gets deleted. These are ORDER-OF-MAGNITUDE guards: they
 * catch "every query now opens a TCP connection", not "this got 8% slower".
 */

const SAMPLES = 60

/** Loose by design — see the header. A regression this catches is 10x, not 10%. */
const BUDGET = {
  globalRoundTripP95Ms: 250,
  tenantRoundTripP95Ms: 350,
}

let tenant: TenantFixture

beforeAll(async () => {
  await prepareTestDatabase()
  tenant = await createTenantFixture('PERF')
}, 60_000)

afterAll(teardownTestDatabase)

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index] ?? 0
}

async function measure(times: number, work: () => Promise<unknown>): Promise<number[]> {
  // Warm up first. The first call pays for connection establishment and for
  // the driver's lazy initialisation, and including it would measure startup
  // rather than steady state.
  await work()

  const samples: number[] = []
  for (let i = 0; i < times; i += 1) {
    const started = performance.now()
    await work()
    samples.push(performance.now() - started)
  }
  return samples
}

function report(label: string, samples: number[]): void {
  const p50 = percentile(samples, 50).toFixed(1)
  const p95 = percentile(samples, 95).toFixed(1)
  const max = Math.max(...samples).toFixed(1)
  // eslint-disable-next-line no-console -- the measurement IS the output of this suite
  console.log(`  ${label}: p50 ${p50}ms · p95 ${p95}ms · max ${max}ms (${samples.length} samples)`)
}

describe('foundation round-trip latency', () => {
  it('a global transaction completes well within an order of magnitude', async () => {
    const samples = await measure(SAMPLES, () =>
      withGlobal((tx) => scalarOn<string>(tx, 'SELECT 1')),
    )
    report('withGlobal', samples)

    expect(percentile(samples, 95)).toBeLessThan(BUDGET.globalRoundTripP95Ms)
  })

  it('a tenant transaction costs a context set, not a new connection', async () => {
    const samples = await measure(SAMPLES, () =>
      runAs({ tenantId: tenant.tenantId, userId: null }, () =>
        withTenant((tx) => scalarOn<string>(tx, 'SELECT count(*)::text FROM users')),
      ),
    )
    report('withTenant', samples)

    expect(percentile(samples, 95)).toBeLessThan(BUDGET.tenantRoundTripP95Ms)
  })

  it('setting the tenant context does not dominate the transaction', async () => {
    const globalSamples = await measure(SAMPLES, () =>
      withGlobal((tx) => scalarOn<string>(tx, 'SELECT 1')),
    )
    const tenantSamples = await measure(SAMPLES, () =>
      runAs({ tenantId: tenant.tenantId, userId: null }, () =>
        withTenant((tx) => scalarOn<string>(tx, 'SELECT 1')),
      ),
    )

    const overhead = percentile(tenantSamples, 50) - percentile(globalSamples, 50)
    report('tenant overhead', [overhead])

    /*
     * RLS plus `set_config` should cost a small fraction of a round trip, not
     * a multiple of one. A large gap here means the context is being set with
     * its own round trip, or a policy is forcing a sequential scan — both
     * worth knowing about before there is real traffic, and both invisible in
     * a correctness test.
     */
    expect(overhead).toBeLessThan(BUDGET.globalRoundTripP95Ms)
  })
})
