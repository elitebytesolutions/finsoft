import { randomUUID } from 'node:crypto'
import { Queue, Worker } from 'bullmq'
import { withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  scalarOn,
  teardownTestDatabase,
  unique,
} from '@finsoft/database/testing'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * The transactional side-effect contract, end to end: a real PostgreSQL
 * transaction and a real Redis queue.
 *
 * ADR-0019's rule is that a side effect is dispatched only AFTER the business
 * fact commits. The three properties that has to give are each asserted here
 * against the real thing rather than argued about:
 *
 *   committed  → the row exists AND the job is processed
 *   rolled back → the row does not exist AND NO job exists
 *   retried    → the effect is applied exactly once
 *
 * The `outbox` table ADR-0019 specifies is not built yet — it needs a
 * migration, and a migration needs the database guardian. So this tests the
 * contract at the level the system supports today: the enqueue happens after
 * the transaction returns, which is the discipline the dispatcher will
 * formalise. When the outbox lands, these assertions should still hold and
 * the mechanism beneath them changes.
 */

const QUEUE = `test-outbox-${unique()}`

/*
 * Resolved INSIDE beforeAll, not at module scope.
 *
 * `prepareTestDatabase` is what loads .env, so at import time this variable
 * does not exist yet. An earlier version read it here with a hardcoded
 * fallback of :6380 — which was also the wrong port, because 6379 and 6380
 * were already taken on this machine and .env shifted the stack to :6390. The
 * fallback turned a missing-configuration error into a 60-second connection
 * timeout pointing at nothing.
 *
 * No fallback now. If it is unset the test says so immediately.
 */
function redisUrl(): string {
  const url = process.env['TEST_REDIS_URL']
  if (!url) {
    throw new Error(
      'TEST_REDIS_URL is not set. It names the DISPOSABLE test cache — the one a ' +
        'suite may FLUSHALL (ADR-0002:110) — and must never point at the dev cache.',
    )
  }
  return url
}

interface Job {
  correlationId: string
  effectId: string
}

let queue: Queue<Job>
let worker: Worker<Job>

/** Effects the handler actually applied, by id. A duplicate shows as > 1. */
const applied = new Map<string, number>()
/** Effect ids the handler should fail on, once each. */
const failOnce = new Set<string>()

beforeAll(async () => {
  await prepareTestDatabase()
  resetLoggerForTests()
  initLogger({ service: 'test-worker', level: 'fatal' })

  const connection = { url: redisUrl(), maxRetriesPerRequest: null }
  queue = new Queue<Job>(QUEUE, { connection })

  worker = new Worker<Job>(
    QUEUE,
    async (job) => {
      const { effectId } = job.data

      /*
       * Fail the FIRST attempt only, so the retry path is exercised for real
       * rather than simulated. BullMQ redelivers, and the handler must then
       * not apply the effect a second time.
       */
      if (failOnce.has(effectId)) {
        failOnce.delete(effectId)
        throw new Error('transient failure')
      }

      applied.set(effectId, (applied.get(effectId) ?? 0) + 1)
    },
    { connection, concurrency: 1 },
  )

  await worker.waitUntilReady()
  await queue.waitUntilReady()
}, 60_000)

afterAll(async () => {
  await worker?.close()
  await queue?.obliterate({ force: true }).catch(() => undefined)
  await queue?.close()
  resetLoggerForTests()
  await teardownTestDatabase()
})

/** Wait for a condition, so a test never races the worker's event loop. */
async function eventually(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met within timeout')
}

/**
 * The shape every posting path will have: do the work in the transaction,
 * dispatch only once it has committed.
 */
async function createUserThenDispatch(
  tenant: { tenantId: string; ownerId: string },
  opts: { failInTransaction?: boolean } = {},
): Promise<string> {
  const { tenantId, ownerId } = tenant
  const effectId = randomUUID()
  const email = `wt.${unique().toLowerCase()}@example.test`

  await runAs({ tenantId, userId: ownerId }, () =>
    withTenant(async (tx) => {
      /*
       * Authored by the fixture's owner, not NULL. Migration 002 permits
       * exactly ONE row per tenant with created_by NULL — the provisioned
       * owner, which has no user to author it — and enforces that with a
       * partial unique index. A second NULL-authored row is a duplicate key,
       * which is how the first version of this test failed: correctly.
       */
      await tx
        .insertInto('users')
        .values({
          tenant_id: tenantId,
          email,
          full_name: 'Worker Test',
          status: 'INVITED',
          created_by: ownerId,
          updated_by: ownerId,
        })
        .execute()

      // Thrown INSIDE the transaction, so the insert never commits — and the
      // enqueue below is never reached.
      if (opts.failInTransaction) throw new Error('business rule rejected this')
    }),
  )

  await queue.add('effect', { correlationId: randomUUID(), effectId })
  return effectId
}

describe('a committed transaction dispatches its side effect', () => {
  it('processes the job, and the row is there', async () => {
    const tenant = await createTenantFixture('WTA')
    const effectId = await createUserThenDispatch(tenant)

    await eventually(() => applied.get(effectId) === 1)

    expect(applied.get(effectId)).toBe(1)

    const count = await runAs({ tenantId: tenant.tenantId, userId: null }, () =>
      withTenant((tx) => scalarOn<string>(tx, 'SELECT count(*)::text FROM users')),
    )
    // The provisioned owner from the fixture, plus the one just created.
    expect(Number(count)).toBe(2)
  })
})

describe('a rolled back transaction dispatches nothing', () => {
  it('writes no row and enqueues no job', async () => {
    const tenant = await createTenantFixture('WTB')
    const before = await queue.getJobCounts()

    await expect(createUserThenDispatch(tenant, { failInTransaction: true })).rejects.toThrow(
      /business rule/,
    )

    const count = await runAs({ tenantId: tenant.tenantId, userId: null }, () =>
      withTenant((tx) => scalarOn<string>(tx, 'SELECT count(*)::text FROM users')),
    )
    // Only the fixture's owner. The insert rolled back with the transaction.
    expect(Number(count)).toBe(1)

    const after = await queue.getJobCounts()
    const total = (c: Record<string, number>) =>
      (c.waiting ?? 0) + (c.active ?? 0) + (c.completed ?? 0) + (c.failed ?? 0) + (c.delayed ?? 0)

    /*
     * The important half. A side effect dispatched for a transaction that
     * rolled back is an email about an invoice that does not exist — and it
     * cannot be recalled once sent.
     */
    expect(total(after), 'a rolled back transaction must enqueue nothing').toBe(total(before))
  })
})

/*
 * ── What the next test does and does not establish ──────────────────────
 *
 * It proves that THIS handler's effect, which is idempotent by construction,
 * survives a real BullMQ redelivery after a real failure. That is worth
 * having: it exercises the retry path rather than simulating it, and it
 * fails if the handler is later made non-idempotent.
 *
 * It is NOT a general exactly-once delivery guarantee, and no such guarantee
 * exists. BullMQ is at-least-once and ADR-0019 accepts that: a worker killed
 * mid-job, a lost acknowledgement or a network partition all redeliver. The
 * obligation that creates sits on every HANDLER, individually, and a passing
 * test here says nothing about a handler written next week.
 *
 * When the outbox dispatcher lands, the property that actually needs proving
 * is that each outbox row is marked DONE exactly once under concurrent
 * dispatchers — which is a different test, against a table that does not
 * exist yet.
 */
describe('a retry does not duplicate this handler effect', () => {
  it('applies it once across a failure and a redelivery', async () => {
    const tenant = await createTenantFixture('WTC')
    const effectId = randomUUID()

    failOnce.add(effectId)

    await queue.add(
      'effect',
      { correlationId: randomUUID(), effectId },
      { attempts: 3, backoff: { type: 'fixed', delay: 100 } },
    )

    await eventually(() => applied.get(effectId) === 1)

    // Give a duplicate a chance to arrive before asserting it did not.
    await new Promise((r) => setTimeout(r, 500))

    expect(
      applied.get(effectId),
      'at-least-once delivery means this handler WILL see a redelivery; it must be idempotent',
    ).toBe(1)

    expect(tenant.tenantId).toBeTruthy()
  })
})
