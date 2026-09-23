import { randomUUID } from 'node:crypto'
import { claimBatch, reclaimExpired, withTenant, ATTEMPT_CAP, RECLAIM_CAP } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ConsumerRegistry, type EffectContext } from '../../apps/worker/src/outbox/consumers.ts'
import { OutboxDispatcher } from '../../apps/worker/src/outbox/dispatcher.ts'

/*
 * The outbox dispatcher, end to end, against a real PostgreSQL.
 *
 * The six failure paths the database guardian required of the implementation,
 * driven through the REAL dispatcher rather than through the repository —
 * because the repository's contract was already proved in
 * `database/tests/outbox.spec.ts`, and what is unproven is whether the
 * dispatcher HONOURS it. A repository that asserts rowcount = 1 does nothing
 * for a caller that catches the throw and carries on.
 *
 *   1  crash after claiming
 *   2  enqueue succeeds, ack fails
 *   3  a stale dispatcher cannot ack a reclaimed row
 *   4  repeated failures reach the cap
 *   5  replay preserves evidence
 *   6  tenant enumeration respects access boundaries
 *
 * Plus the consumer contract test in its amended form — twice with the same
 * `(tenant_id, topic, effect_key)`, INCLUDING once via a replay row with a
 * different `id`. ADR-0019 correction 3: the `outbox.id` form passes against
 * a consumer that double-sends on replay, which is the failure the correction
 * exists to prevent.
 */

beforeAll(async () => {
  await prepareTestDatabase()
  initLogger({ service: 'outbox-dispatcher-test', level: 'fatal' })
}, 60_000)

afterAll(async () => {
  resetLoggerForTests()
  await teardownTestDatabase()
})

/*
 * A FRESH TENANT PER TEST, not one shared across the file.
 *
 * The dispatcher's whole job is to claim every due row for a tenant, so two
 * tests sharing one tenant are two tests sharing a work queue: the first
 * version of this file had a cycle in one test consume 41 rows left by the
 * others and assert on a count of 1. Nothing cleans up — rule 4 means no role
 * holds DELETE — so isolation has to come from the fixture, not from teardown.
 *
 * `other` is shared deliberately: it exists to prove rows do NOT cross, and a
 * long-lived neighbour with accumulating rows is a better test of that than a
 * pristine one.
 */
let tenant: TenantFixture
let other: TenantFixture

beforeAll(async () => {
  other = await createTenantFixture('DSQ')
}, 60_000)

beforeEach(async () => {
  tenant = await createTenantFixture('DSP')
}, 30_000)

const TOPIC = 'INVOICE_EMAIL'

interface Row {
  id: string
  status: string
  attempts: number
  reclaims: number
  lease_id: string | null
  dispatched_at: Date | null
  last_error: string | null
  effect_key: string
}

function asTenant<R>(
  t: TenantFixture,
  text: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  return runAs({ tenantId: t.tenantId, userId: t.ownerId }, () =>
    withTenant((tx) => rawOn<R>(tx, text, params)),
  )
}

async function enqueue(
  t: TenantFixture = tenant,
  overrides: { effectKey?: string; topic?: string } = {},
): Promise<Row> {
  const rows = await asTenant<Row>(
    t,
    `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                         correlation_id, created_by, updated_by)
     VALUES ($1, $2, $3::jsonb, $4, now(), $5, $6, $6)
     RETURNING *`,
    [
      t.tenantId,
      overrides.topic ?? TOPIC,
      JSON.stringify({ saleId: randomUUID() }),
      overrides.effectKey ?? `EK-${unique()}`,
      randomUUID(),
      t.ownerId,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('insert returned nothing')
  return row
}

const read = (id: string, t: TenantFixture = tenant): Promise<Row | undefined> =>
  asTenant<Row>(t, 'SELECT * FROM outbox WHERE id = $1', [id]).then((r) => r[0])

/** A dispatcher whose lease is short enough for a test to outlive. */
function dispatcherWith(
  consumer: (c: EffectContext) => Promise<void>,
  options: {
    leaseSeconds?: number
    batchSize?: number
    topic?: string
    timeoutSeconds?: number
    backoff?: (attempt: number) => number
  } = {},
): OutboxDispatcher {
  const registry = new ConsumerRegistry()
  registry.register({
    topic: options.topic ?? TOPIC,
    consumer,
    /*
     * Both values are configurable, and the ORDERING between them is the
     * thing under test elsewhere in this file. A test that needs an already-
     * expired lease passes a small pair — 0.01s lease against a 0.001s
     * timeout still satisfies the 2x margin — rather than being handed an
     * exemption from the invariant. The invariant is real, so the tests live
     * inside it.
     */
    timeoutSeconds: options.timeoutSeconds ?? 1,
  })
  return new OutboxDispatcher(
    {
      leaseSeconds: options.leaseSeconds ?? 10,
      batchSize: options.batchSize ?? 50,
      idlePollMs: 50,
      ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
    },
    registry,
  )
}

/* ==================================================================== *
 * 1. CRASH AFTER CLAIMING
 * ==================================================================== */
describe('1 — a dispatcher that dies after claiming does not strand the row', () => {
  it('the row is reclaimed and redelivered, and the consumer runs again', async () => {
    const row = await enqueue()

    /*
     * The crash, simulated at the only point where it matters: the row is
     * IN_FLIGHT and committed, and this process will never ack it. Claiming
     * through the real repository rather than by hand, so the row is in the
     * exact state a real crash leaves.
     */
    const claimed = await runAs({ tenantId: tenant.tenantId, userId: null }, () => claimBatch(10))
    expect(claimed.map((r) => r.id)).toContain(row.id)
    expect((await read(row.id))?.status).toBe('IN_FLIGHT')

    // A second dispatcher comes along with a lease short enough to have expired.
    const seen: string[] = []
    const recovered = dispatcherWith(
      async (c) => {
        seen.push(c.effectKey)
      },
      /*
       * A lease of 10ms against a consumer that declares 1ms. Satisfies the
       * 2x margin, and by the time the reaper runs the abandoned claim is
       * comfortably older than its lease — without a five-minute wait and
       * without suspending the invariant for the test's convenience.
       */
      { leaseSeconds: 0.01, timeoutSeconds: 0.001 },
    )

    const result = await recovered.runCycle()

    expect(result.reclaimed, 'the reaper must find the abandoned lease').toBeGreaterThan(0)
    expect(seen, 'and the effect must actually be performed on the retry').toContain(row.effect_key)

    const after = await read(row.id)
    expect(after?.status).toBe('DONE')
    expect(after?.reclaims, 'charged to the dispatcher budget, not the consumer one').toBe(1)
    expect(after?.attempts, 'the consumer never failed').toBe(0)
  })
})

/* ==================================================================== *
 * 2. ENQUEUE SUCCEEDS, ACK FAILS
 * ==================================================================== */
describe('2 — the effect is performed but the ack does not land', () => {
  it('redelivers, and the consumer deduplicates so the effect happens once', async () => {
    const row = await enqueue()
    const performed: string[] = []

    /*
     * The consumer's own dedup record, which is what ADR-0019 requires of
     * every consumer: keyed on (tenant, topic, effectKey) — NOT on the outbox
     * row id.
     */
    const sent = new Set<string>()
    const consumer = async (c: EffectContext): Promise<void> => {
      const key = `${c.tenantId}|${c.topic}|${c.effectKey}`
      if (sent.has(key)) return // a redelivery: already done, nothing to do
      sent.add(key)
      performed.push(c.effectKey)
    }

    // First pass: the consumer runs, then the lease is yanked before the ack.
    const stealing = dispatcherWith(async (c) => {
      await consumer(c)
      await asTenant(
        tenant,
        `UPDATE outbox SET status='PENDING', claimed_at=NULL, lease_id=NULL,
                reclaims=reclaims+1, available_at=now() WHERE id=$1 AND status='IN_FLIGHT'`,
        [row.id],
      )
    })

    const first = await stealing.runCycle()
    expect(first.leasesLost, 'the ack must be refused, not silently succeed').toBeGreaterThan(0)
    expect((await read(row.id))?.status, 'so the row stays claimable').toBe('PENDING')
    expect(performed, 'the effect did happen').toHaveLength(1)

    // Second pass: the row comes back, and the consumer's guard holds.
    const second = dispatcherWith(consumer)
    await second.runCycle()

    expect((await read(row.id))?.status).toBe('DONE')
    expect(performed, 'AT-LEAST-ONCE delivery, exactly-once EFFECT').toHaveLength(1)
  })
})

/* ==================================================================== *
 * 3. A STALE DISPATCHER CANNOT ACK A RECLAIMED ROW
 * ==================================================================== */
describe('3 — the fence, as the dispatcher sees it', () => {
  it('a stale ack is refused and the live claim survives untouched', async () => {
    const row = await enqueue()

    // Dispatcher A claims and stalls.
    const claimedByA = await runAs({ tenantId: tenant.tenantId, userId: null }, () =>
      claimBatch(10),
    )
    const a = claimedByA.find((r) => r.id === row.id)
    expect(a).toBeDefined()

    // The reaper returns it; dispatcher B claims and holds a fresh token.
    await runAs({ tenantId: tenant.tenantId, userId: null }, () => reclaimExpired(0))
    const claimedByB = await runAs({ tenantId: tenant.tenantId, userId: null }, () =>
      claimBatch(10),
    )
    const b = claimedByB.find((r) => r.id === row.id)
    expect(b?.leaseId, 'every claim mints a new token').not.toBe(a?.leaseId)

    /*
     * A wakes and acks with its stale token, through the real repository.
     * The repository throws LeaseLostError rather than reporting success,
     * which is the behaviour the dispatcher depends on — and the reason it
     * is an error type rather than a boolean is that a boolean gets ignored.
     */
    const { ackDispatched, LeaseLostError } = await import('@finsoft/database')
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: null }, () =>
        ackDispatched(row.id, a?.leaseId ?? ''),
      ),
    ).rejects.toBeInstanceOf(LeaseLostError)

    const after = await read(row.id)
    expect(after?.status, "B's row is still in flight").toBe('IN_FLIGHT')
    expect(after?.lease_id).toBe(b?.leaseId)
    expect(after?.dispatched_at, 'and was never marked dispatched').toBeNull()
  })

  it('the dispatcher counts a lost lease rather than treating it as a failure', async () => {
    const row = await enqueue()

    const d = dispatcherWith(async () => {
      // Another dispatcher reclaims while this consumer is working.
      await asTenant(
        tenant,
        `UPDATE outbox SET status='PENDING', claimed_at=NULL, lease_id=NULL,
                reclaims=reclaims+1, available_at=now() WHERE id=$1 AND status='IN_FLIGHT'`,
        [row.id],
      )
    })

    const result = await d.runCycle()

    /*
     * `>= 1`, and then assertions about THIS ROW.
     *
     * A cycle counter is a fact about the whole database: the dispatcher
     * enumerates every tenant of any status, which is the point of it, so any
     * row another spec left behind lands in the same totals. The first
     * version of this test asserted `failed === 0` and got 100 — all of them
     * BULK_PROBE rows belonging to a different spec's tenant. The counter was
     * right and the assertion was wrong.
     */
    expect(result.leasesLost).toBeGreaterThanOrEqual(1)

    const after = await read(row.id)
    expect(after?.attempts, 'a lost lease charges the row no consumer attempt').toBe(0)
    expect(after?.last_error, 'and records no consumer error, because none occurred').toBeNull()
    expect(after?.status, 'the row is back in the queue for whoever holds the live lease').toBe(
      'PENDING',
    )
  })
})

/* ==================================================================== *
 * 4. REPEATED FAILURES REACH THE CAP
 * ==================================================================== */
describe('4 — nothing retries forever', () => {
  it('a consistently failing consumer drives the row to FAILED at the attempt cap', async () => {
    const row = await enqueue()

    /*
     * Zero backoff, through configuration.
     *
     * The first version pulled `available_at` back between cycles with an
     * UPDATE — which is a PENDING -> PENDING transition, and the trigger
     * refused it. The trigger was right: rescheduling a row by hand is not
     * something the dispatcher does, and allowing it would reopen the backoff
     * field to arbitrary writes. So the retry schedule became configuration,
     * which is what it should have been anyway.
     */
    const d = dispatcherWith(
      async () => {
        throw new Error('the remote endpoint is unreachable')
      },
      { backoff: () => 0 },
    )

    for (let i = 0; i < ATTEMPT_CAP; i += 1) await d.runCycle()

    const after = await read(row.id)
    expect(after?.status).toBe('FAILED')
    expect(after?.attempts).toBe(ATTEMPT_CAP)
    expect(after?.last_error, 'a FAILED row always carries something actionable').toMatch(
      /unreachable/,
    )
    expect(after?.reclaims, 'the dispatcher never died, so no reclaim is charged').toBe(0)
  })

  it('a consistently dying dispatcher drives it to FAILED at the RECLAIM cap instead', async () => {
    const row = await enqueue()

    /*
     * The other road to the same terminal state, and the reason the two
     * counters are separate. Here the consumer never runs at all.
     */
    for (let i = 0; i < RECLAIM_CAP; i += 1) {
      await runAs({ tenantId: tenant.tenantId, userId: null }, () => claimBatch(10))
      await runAs({ tenantId: tenant.tenantId, userId: null }, () => reclaimExpired(0))
    }

    const after = await read(row.id)
    expect(after?.status).toBe('FAILED')
    expect(after?.reclaims).toBe(RECLAIM_CAP)
    expect(after?.attempts, 'the consumer never once ran — this is not a poison message').toBe(0)
    expect(
      after?.last_error,
      'and it must be distinguishable on sight from a row that failed on its merits',
    ).toMatch(/lease expired 5 times without an ack/)
  })

  it('a row with no registered consumer fails loudly rather than sitting PENDING forever', async () => {
    const orphan = await enqueue(tenant, { topic: 'NOBODY_CONSUMES_THIS' })
    const d = dispatcherWith(async () => undefined)

    const result = await d.runCycle()

    expect(result.failed).toBeGreaterThan(0)
    const after = await read(orphan.id)
    expect(after?.attempts).toBe(1)
    expect(after?.last_error).toMatch(/No consumer registered/)
  })
})

/* ==================================================================== *
 * 5. REPLAY PRESERVES EVIDENCE
 * ==================================================================== */
describe('5 — replay, through the dispatcher', () => {
  it('a replay does NOT re-send, because it carries the original effect key', async () => {
    const row = await enqueue()
    const performed: string[] = []
    const sent = new Set<string>()

    const consumer = async (c: EffectContext): Promise<void> => {
      /*
       * THE AMENDED CONSUMER CONTRACT TEST. ADR-0019 correction 3 requires
       * every consumer to be exercised twice with the same
       * (tenant_id, topic, effect_key), INCLUDING once via a replay row with
       * a different id — because the old `outbox.id` form passes against a
       * consumer that double-sends on replay.
       */
      const key = `${c.tenantId}|${c.topic}|${c.effectKey}`
      if (sent.has(key)) return
      sent.add(key)
      performed.push(c.effectKey)
    }

    await dispatcherWith(consumer).runCycle()
    expect(performed).toHaveLength(1)

    const original = await read(row.id)
    expect(original?.status).toBe('DONE')

    // Replay: a new row, same effect key, pointing back at the original.
    const replay = await asTenant<Row>(
      tenant,
      `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                           correlation_id, created_by, updated_by, replay_of)
       SELECT tenant_id, topic, payload, effect_key, occurred_at,
              correlation_id, created_by, updated_by, id
         FROM outbox WHERE id = $1
       RETURNING *`,
      [row.id],
    ).then((r) => r[0])

    expect(replay?.id).not.toBe(row.id)
    await dispatcherWith(consumer).runCycle()

    expect(
      performed,
      'a fresh row id must NOT get past the consumer dedup — that is a silent double send',
    ).toHaveLength(1)
    expect((await read(replay?.id ?? ''))?.status, 'and the replay still completes').toBe('DONE')

    const originalAfter = await read(row.id)
    expect(originalAfter?.dispatched_at?.toISOString()).toBe(original?.dispatched_at?.toISOString())
  })
})

/* ==================================================================== *
 * 6. TENANT ENUMERATION RESPECTS ACCESS BOUNDARIES
 * ==================================================================== */
describe('6 — tenant enumeration', () => {
  it('dispatches each tenant under its own context and never crosses', async () => {
    const mine = await enqueue(tenant)
    const theirs = await enqueue(other)

    const seenByTenant = new Map<string, string[]>()
    const d = dispatcherWith(async (c) => {
      const list = seenByTenant.get(c.tenantId) ?? []
      list.push(c.effectKey)
      seenByTenant.set(c.tenantId, list)
    })

    await d.runCycle()

    expect(seenByTenant.get(tenant.tenantId)).toContain(mine.effect_key)
    expect(seenByTenant.get(other.tenantId)).toContain(theirs.effect_key)
    expect(
      seenByTenant.get(tenant.tenantId),
      "one tenant's cycle must never see another's row",
    ).not.toContain(theirs.effect_key)
  })

  it('serves a SUSPENDED tenant, which is the starvation case', async () => {
    const dormant = await createTenantFixture('DSR')
    const owed = await enqueue(dormant)

    const { withGlobal } = await import('@finsoft/database')
    await withGlobal((tx) =>
      rawOn(tx, `UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [dormant.tenantId]),
    )

    const seen: string[] = []
    await dispatcherWith(async (c) => {
      seen.push(c.effectKey)
    }).runCycle()

    expect(
      seen,
      'a suspended tenant can still owe a final invoice email; enumerating only ACTIVE tenants ' +
        'strands it forever, unclaimed, unreaped and unmeasured',
    ).toContain(owed.effect_key)
  })

  it('bounds each tenant to its batch size, so one backlog cannot own the cycle', async () => {
    const backlogged = await createTenantFixture('DSS')
    for (let i = 0; i < 5; i += 1) await enqueue(backlogged)

    const seen: string[] = []
    const d = dispatcherWith(
      async (c) => {
        seen.push(c.effectKey)
      },
      { batchSize: 2 },
    )

    const result = await d.runCycle()
    const forBacklogged = await asTenant<{ n: string }>(
      backlogged,
      `SELECT count(*)::text AS n FROM outbox WHERE status = 'PENDING'`,
    )

    expect(result.claimed, 'no more than batchSize per tenant per cycle').toBeLessThanOrEqual(
      2 * (await listTenantCount()),
    )
    expect(Number(forBacklogged[0]?.n), 'the rest waits for the next cycle').toBeGreaterThan(0)
  })
})

async function listTenantCount(): Promise<number> {
  const { listTenantIdsForDispatch } = await import('@finsoft/database')
  return (await listTenantIdsForDispatch()).length
}

/* ==================================================================== *
 * The startup ordering invariant
 * ==================================================================== */
describe('the lease must exceed the longest consumer timeout', () => {
  it('refuses to construct a dispatcher whose lease is too short', () => {
    const registry = new ConsumerRegistry()
    registry.register({ topic: TOPIC, consumer: async () => undefined, timeoutSeconds: 30 })

    expect(
      () => new OutboxDispatcher({ leaseSeconds: 10, batchSize: 10, idlePollMs: 50 }, registry),
    ).toThrow(/not at least 2x the longest consumer timeout/)
  })

  it('accepts one with margin, so the check is not simply blocking everything', () => {
    const registry = new ConsumerRegistry()
    registry.register({ topic: TOPIC, consumer: async () => undefined, timeoutSeconds: 30 })

    expect(
      () => new OutboxDispatcher({ leaseSeconds: 120, batchSize: 10, idlePollMs: 50 }, registry),
    ).not.toThrow()
  })

  it('refuses two consumers for one topic', () => {
    const registry = new ConsumerRegistry()
    registry.register({ topic: TOPIC, consumer: async () => undefined, timeoutSeconds: 1 })
    expect(() =>
      registry.register({ topic: TOPIC, consumer: async () => undefined, timeoutSeconds: 1 }),
    ).toThrow(/already registered/)
  })
})
