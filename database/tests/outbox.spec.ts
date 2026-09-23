import { randomUUID } from 'node:crypto'
import { withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  scalarOn,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * The outbox schema, exercised through DIRECT SQL.
 *
 * Deliberately not through a repository. Every guarantee below has to hold
 * against a psql session, a migration, an admin script and a future import —
 * rule 21 contemplates humans with direct access, and a control that only
 * works when called through the right TypeScript is not a control.
 *
 * What this file is really for: the previous draft of 004 CLAIMED, in a
 * comment on a CHECK constraint, that it forbade resetting a DONE row to
 * PENDING. It did not. `UPDATE outbox SET status='PENDING',
 * dispatched_at=NULL` satisfied every constraint on the table, and ADR-0010
 * actively instructs someone to do exactly that. A claim in a comment is
 * worth nothing; the assertions here are what the claim is now backed by.
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

/** Every row this file writes, so a failure names a real id. */
interface Row {
  id: string
  status: string
  attempts: number
  reclaims: number
  lease_id: string | null
  claimed_at: Date | null
  dispatched_at: Date | null
  last_error: string | null
  payload: unknown
  effect_key: string
  acknowledged_at: Date | null
  acknowledged_by: string | null
}

let tenant: TenantFixture
let other: TenantFixture

beforeAll(async () => {
  ;[tenant, other] = await Promise.all([createTenantFixture('OBX'), createTenantFixture('OBY')])
}, 60_000)

/** Insert a PENDING row as the fixture tenant, returning it. */
async function enqueue(
  t: TenantFixture = tenant,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<Row> {
  const values = {
    topic: 'INVOICE_EMAIL',
    payload: JSON.stringify({ saleId: randomUUID() }),
    effect_key: `EK-${unique()}`,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    created_by: t.ownerId,
    updated_by: t.ownerId,
    replay_of: null,
    ...overrides,
  }

  return runAs({ tenantId: t.tenantId, userId: t.ownerId }, () =>
    withTenant(async (tx) => {
      const rows = await rawOn<Row>(
        tx,
        `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                             correlation_id, created_by, updated_by, replay_of)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          t.tenantId,
          values.topic,
          values.payload,
          values.effect_key,
          values.occurred_at,
          values.correlation_id,
          values.created_by,
          values.updated_by,
          values.replay_of,
        ],
      )
      const row = rows[0]
      if (!row) throw new Error('insert returned nothing')
      return row
    }),
  )
}

/** Run arbitrary SQL as the fixture tenant and return the affected rows. */
function asTenant<R>(
  t: TenantFixture,
  text: string,
  parameters: readonly unknown[] = [],
): Promise<R[]> {
  return runAs({ tenantId: t.tenantId, userId: t.ownerId }, () =>
    withTenant((tx) => rawOn<R>(tx, text, parameters)),
  )
}

const read = (id: string, t: TenantFixture = tenant): Promise<Row | undefined> =>
  asTenant<Row>(t, 'SELECT * FROM outbox WHERE id = $1', [id]).then((r) => r[0])

/** The real CLAIM statement from 004's header, returning the new lease. */
async function claim(id: string): Promise<string> {
  const rows = await asTenant<{ lease_id: string }>(
    tenant,
    `UPDATE outbox
        SET status = 'IN_FLIGHT', claimed_at = now(), lease_id = gen_random_uuid(),
            updated_at = now(), version = version + 1
      WHERE id = $1 AND status = 'PENDING'
     RETURNING lease_id`,
    [id],
  )
  const lease = rows[0]?.lease_id
  if (!lease) throw new Error(`claim of ${id} affected no rows`)
  return lease
}

/** The real ACK statement. Returns how many rows it actually touched. */
const ack = (id: string, lease: string): Promise<number> =>
  asTenant<Row>(
    tenant,
    `UPDATE outbox
        SET status = 'DONE', claimed_at = NULL, lease_id = NULL,
            dispatched_at = now(), updated_at = now(), version = version + 1
      WHERE id = $1 AND lease_id = $2
     RETURNING id`,
    [id, lease],
  ).then((r) => r.length)

/*
 * The real REAPER RECLAIM statement, fenced on the lease interval.
 *
 * The interval is a PARAMETER, which is why 004's COMMENT ON claimed_at
 * requires the dispatcher to read it from configuration rather than
 * hard-coding five minutes. Passing '0 seconds' expires every live lease
 * immediately, which is how these tests run in milliseconds instead of
 * needing a five-minute wall clock.
 *
 * Note what is NOT available: ageing `claimed_at` backwards by hand. That
 * would be an IN_FLIGHT -> IN_FLIGHT update, which the transition trigger
 * refuses. The test has to use the same door the reaper does.
 *
 * The reason that transition is excluded is NOT "a lease that can be extended
 * is not a fence" — a renewal that ROTATES the token is still a fence, since
 * the holder must present the current token to get the next one. It is
 * excluded because rotation-on-renewal adds a failure mode of its own: the
 * renewal commits, the dispatcher dies before recording the new token, and
 * the live token is held by nobody. See 004's transition-graph header.
 *
 * `id` is a test-only predicate. The production statement sweeps every
 * expired lease for the tenant, which is right in production and wrong here:
 * these tests deliberately leave rows IN_FLIGHT, and an unscoped sweep in one
 * test silently bumped `reclaims` on another's row. Found by the suite
 * passing test-by-test and failing as a whole.
 */
const reap = (id: string, interval = '5 minutes'): Promise<{ id: string }[]> =>
  asTenant<{ id: string }>(
    tenant,
    `UPDATE outbox
        SET status = 'PENDING', claimed_at = NULL, lease_id = NULL,
            reclaims = reclaims + 1, available_at = now(),
            updated_at = now(), version = version + 1
      WHERE status = 'IN_FLIGHT'
        AND claimed_at < now() - $1::interval
        AND reclaims + 1 < 5
        AND id = $2
     RETURNING id`,
    [interval, id],
  )

/* ==================================================================== *
 * 1. LEASE FENCING
 *
 * The finding: the stale ack was POSSIBLE, not merely unlikely. A correct
 * ack nulls claimed_at anyway, so outbox_claimed_at_matches_status was no
 * obstacle at all, and nothing in the schema distinguished one lease
 * generation from the next.
 * ==================================================================== */
describe('lease fencing: an expired claimant cannot touch a newer claim', () => {
  it('a stale ack affects ZERO rows and leaves the new lease intact', async () => {
    const row = await enqueue()

    const leaseA = await claim(row.id) // dispatcher A claims
    const reaped = await reap(row.id, '0 seconds') // A stalls; the reaper returns it to PENDING
    expect(reaped.map((r) => r.id)).toContain(row.id)

    const leaseB = await claim(row.id) // dispatcher B claims
    expect(leaseB, 'every claim mints a NEW token, including after a reclaim').not.toBe(leaseA)

    // A wakes up and acks, holding a token that is two generations old.
    const touched = await ack(row.id, leaseA)

    expect(touched, 'the stale ack must affect no rows — this is the whole fence').toBe(0)

    const after = await read(row.id)
    expect(after?.status, "B's row must still be in flight").toBe('IN_FLIGHT')
    expect(after?.lease_id, "B's lease must be untouched").toBe(leaseB)
    expect(after?.dispatched_at, 'and the row must not be marked dispatched').toBeNull()
  })

  it('a stale FAILURE cannot steal the row out from under the new claimant', async () => {
    /*
     * The worse half of the same bug. A's failure path reset the row to
     * PENDING, which made it claimable by a THIRD dispatcher while B was
     * still working — two live dispatchers on one effect.
     */
    const row = await enqueue()
    const leaseA = await claim(row.id)
    await reap(row.id, '0 seconds')
    const leaseB = await claim(row.id)

    const touched = await asTenant<Row>(
      tenant,
      `UPDATE outbox
          SET status = 'PENDING', claimed_at = NULL, lease_id = NULL,
              attempts = attempts + 1, available_at = now(),
              updated_at = now(), version = version + 1
        WHERE id = $1 AND lease_id = $2
       RETURNING id`,
      [row.id, leaseA],
    )

    expect(touched).toHaveLength(0)
    const after = await read(row.id)
    expect(after?.status).toBe('IN_FLIGHT')
    expect(after?.lease_id).toBe(leaseB)
    expect(after?.attempts, 'and no attempt was charged to the row').toBe(0)
  })

  it('the live claimant CAN still ack, so the fence is not simply blocking everything', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)
    expect(await ack(row.id, lease)).toBe(1)
    expect((await read(row.id))?.status).toBe('DONE')
  })

  it('a lease token exists exactly while the row is in flight', async () => {
    const row = await enqueue()
    expect(row.lease_id, 'PENDING carries no token').toBeNull()

    const lease = await claim(row.id)
    expect((await read(row.id))?.lease_id).toBe(lease)

    await ack(row.id, lease)
    expect((await read(row.id))?.lease_id, 'DONE carries no token').toBeNull()
  })

  it('refuses IN_FLIGHT without a token, so a reclaim cannot forget to reissue one', async () => {
    const row = await enqueue()
    await expect(
      asTenant(tenant, `UPDATE outbox SET status = 'IN_FLIGHT', claimed_at = now() WHERE id = $1`, [
        row.id,
      ]),
    ).rejects.toThrow(/outbox_lease_matches_status/)
  })
})

/* ==================================================================== *
 * 2. STATE TRANSITIONS
 * ==================================================================== */
describe('state transitions: invalid ones are rejected through direct SQL', () => {
  it('REFUSES resetting a DONE row to PENDING — the claim the old comment made falsely', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)
    await ack(row.id, lease)

    /*
     * Byte for byte the statement ADR-0010 told someone to run — the line
     * ADR-0019 correction 3 supersedes — and the one
     * draft 2 asserted a CHECK constraint prevented. It did not: (false) =
     * (false) satisfies outbox_dispatched_at_matches_status.
     */
    await expect(
      asTenant(tenant, `UPDATE outbox SET status = 'PENDING', dispatched_at = NULL WHERE id = $1`, [
        row.id,
      ]),
    ).rejects.toThrow(/DONE is terminal/)

    const after = await read(row.id)
    expect(after?.status).toBe('DONE')
    expect(after?.dispatched_at, 'the evidence of the first dispatch survives').not.toBeNull()
  })

  it.each([
    ['PENDING -> DONE, skipping the claim', `SET status='DONE', dispatched_at=now()`],
    ['PENDING -> FAILED, skipping the claim', `SET status='FAILED', last_error='x'`],
    ['PENDING -> PENDING, rescheduling by hand', `SET status='PENDING', available_at=now()`],
  ])('refuses %s', async (_label, setClause) => {
    const row = await enqueue()
    await expect(
      asTenant(tenant, `UPDATE outbox ${setClause} WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/illegal transition|check_violation|terminal/)
  })

  it('permits the four legal transitions', async () => {
    const a = await enqueue()
    const leaseA = await claim(a.id) // PENDING -> IN_FLIGHT
    expect(await ack(a.id, leaseA)).toBe(1) // IN_FLIGHT -> DONE

    const b = await enqueue()
    const leaseB = await claim(b.id)
    await asTenant(
      tenant,
      `UPDATE outbox SET status='PENDING', claimed_at=NULL, lease_id=NULL,
              attempts=attempts+1, available_at=now() WHERE id=$1 AND lease_id=$2`,
      [b.id, leaseB],
    ) // IN_FLIGHT -> PENDING
    expect((await read(b.id))?.status).toBe('PENDING')

    const c = await enqueue()
    const leaseC = await claim(c.id)
    await asTenant(
      tenant,
      `UPDATE outbox SET status='FAILED', claimed_at=NULL, lease_id=NULL,
              last_error='consumer gave up' WHERE id=$1 AND lease_id=$2`,
      [c.id, leaseC],
    ) // IN_FLIGHT -> FAILED
    expect((await read(c.id))?.status).toBe('FAILED')
  })

  it('freezes the evidence columns after insert', async () => {
    const row = await enqueue()

    /*
     * Two layers, and both are asserted because they fail differently: the
     * column-scoped GRANT refuses before the statement runs at all, and the
     * trigger refuses if a privileged role gets that far.
     */
    for (const [column, value] of [
      ['topic', `'OTHER_TOPIC'`],
      ['payload', `'{"tampered":true}'::jsonb`],
      ['occurred_at', 'now()'],
      ['created_by', 'gen_random_uuid()'],
      ['effect_key', `'DIFFERENT'`],
    ] as const) {
      await expect(
        asTenant(tenant, `UPDATE outbox SET ${column} = ${value} WHERE id = $1`, [row.id]),
        `${column} must not be writable after insert`,
      ).rejects.toThrow(/permission denied|immutable after insert/)
    }
  })

  it('FAILED accepts acknowledgement and nothing else', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)
    await asTenant(
      tenant,
      `UPDATE outbox SET status='FAILED', claimed_at=NULL, lease_id=NULL,
              last_error='poison' WHERE id=$1 AND lease_id=$2`,
      [row.id, lease],
    )

    // The one legal append.
    await asTenant(
      tenant,
      `UPDATE outbox SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1`,
      [row.id, tenant.ownerId],
    )
    expect((await read(row.id))?.status).toBe('FAILED')

    // Anything else about a terminal row is frozen.
    await expect(
      asTenant(tenant, `UPDATE outbox SET last_error = 'rewritten' WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/FAILED is terminal/)
  })

  it('acknowledgement is an APPEND: it cannot be withdrawn', async () => {
    /*
     * The review found this: the FAILED branch froze status, attempts,
     * reclaims, claimed_at, lease_id, available_at and last_error — but not
     * the acknowledgement columns, which is the point of the branch. So
     * `SET acknowledged_at = NULL, acknowledged_by = NULL` succeeded: status
     * still FAILED, no frozen column moved, outbox_acknowledged_is_paired
     * satisfied by both being NULL.
     *
     * The row then silently re-entered outbox_unacknowledged_failed_idx, the
     * alert re-armed, and the record of who took responsibility was gone.
     */
    const row = await failed()
    await acknowledge(row.id)

    await expect(
      asTenant(
        tenant,
        `UPDATE outbox SET acknowledged_at = NULL, acknowledged_by = NULL WHERE id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/acknowledgement is an append/)

    const after = await read(row.id)
    expect(after?.acknowledged_at, 'the acknowledgement survives').not.toBeNull()
    expect(after?.acknowledged_by).toBe(tenant.ownerId)
  })

  it('nor reassigned to someone else', async () => {
    /*
     * A SECOND user of the same tenant, because the composite foreign key
     * requires one and reassigning to the SAME user is not a reassignment:
     * `IS DISTINCT FROM` is false and the guard correctly says nothing. The
     * first version of this test did exactly that and passed vacuously.
     */
    const row = await failed()
    await acknowledge(row.id)

    const second = await asTenant<{ id: string }>(
      tenant,
      `INSERT INTO users (tenant_id, email, full_name, status, created_by, updated_by)
       VALUES ($1, $2, 'Second Approver', 'INVITED', $3, $3) RETURNING id`,
      [tenant.tenantId, `second.${unique().toLowerCase()}@example.test`, tenant.ownerId],
    ).then((r) => r[0]?.id)

    await expect(
      asTenant(tenant, `UPDATE outbox SET acknowledged_by = $2 WHERE id = $1`, [row.id, second]),
    ).rejects.toThrow(/acknowledgement is an append/)

    expect((await read(row.id))?.acknowledged_by, 'the original approver stands').toBe(
      tenant.ownerId,
    )
  })

  it('but a FAILED row can still be acknowledged the first time', async () => {
    /*
     * The positive control. Without it the two assertions above would pass
     * against a trigger that rejected every acknowledgement, which would
     * leave the alert armed forever — the failure the column exists to fix.
     */
    const row = await failed()
    await acknowledge(row.id)
    const after = await read(row.id)
    expect(after?.acknowledged_at).not.toBeNull()
    expect(after?.status).toBe('FAILED')
  })

  it('refuses to acknowledge a row that has not failed', async () => {
    /*
     * Two mechanisms refuse this and the ORDER matters for the message a
     * reader gets. The transition trigger fires first, because the statement
     * is also a PENDING -> PENDING update; outbox_acknowledged_only_when_failed
     * is the backstop for a row reached some other way. Asserted as "refused",
     * with both named, rather than pinned to whichever currently wins.
     */
    const row = await enqueue()
    await expect(
      asTenant(
        tenant,
        `UPDATE outbox SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1`,
        [row.id, tenant.ownerId],
      ),
    ).rejects.toThrow(/illegal transition|outbox_acknowledged_only_when_failed/)
  })
})

/** Drive a row to FAILED through the legal path, so it can be acknowledged. */
async function failed(): Promise<Row> {
  const row = await enqueue()
  const lease = await claim(row.id)
  await asTenant(
    tenant,
    `UPDATE outbox SET status='FAILED', claimed_at=NULL, lease_id=NULL,
            last_error='consumer gave up' WHERE id=$1 AND lease_id=$2`,
    [row.id, lease],
  )
  const done = await read(row.id)
  if (!done) throw new Error('row vanished')
  return done
}

const acknowledge = (id: string): Promise<unknown[]> =>
  asTenant(
    tenant,
    `UPDATE outbox SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1`,
    [id, tenant.ownerId],
  )

/* ==================================================================== *
 * 3. ATTEMPT CAPS
 *
 * The finding: nothing capped anything. A dispatcher bug that never capped
 * produced a row retrying forever and passed every database assertion.
 * ==================================================================== */
describe('attempt caps: nothing is stranded, and nothing retries forever', () => {
  it('refuses a PENDING row at the consumer cap, so it has nowhere to go but FAILED', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)

    await expect(
      asTenant(
        tenant,
        `UPDATE outbox SET status='PENDING', claimed_at=NULL, lease_id=NULL,
                attempts = 10, available_at = now() WHERE id=$1 AND lease_id=$2`,
        [row.id, lease],
      ),
    ).rejects.toThrow(/outbox_exhausted_is_failed/)
  })

  it('refuses a PENDING row at the reclaim cap, for the same reason', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)

    await expect(
      asTenant(
        tenant,
        `UPDATE outbox SET status='PENDING', claimed_at=NULL, lease_id=NULL,
                reclaims = 5, available_at = now() WHERE id=$1 AND lease_id=$2`,
        [row.id, lease],
      ),
    ).rejects.toThrow(/outbox_reclaims_exhausted_is_failed/)
  })

  it('refuses attempts beyond the cap at all', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)
    await expect(
      asTenant(
        tenant,
        `UPDATE outbox SET status='FAILED', claimed_at=NULL, lease_id=NULL,
                attempts = 11, last_error='x' WHERE id=$1 AND lease_id=$2`,
        [row.id, lease],
      ),
    ).rejects.toThrow(/outbox_attempts_capped/)
  })

  it('counts a DISPATCHER death separately from a CONSUMER failure', async () => {
    /*
     * The reason the two budgets are separate: a deploy that restarts five
     * workers is an infrastructure event. Charging it to `attempts` would
     * deliver a poison-message verdict on a row whose consumer never ran.
     */
    const row = await enqueue()
    const lease = await claim(row.id)
    await reap(row.id, '0 seconds')

    const after = await read(row.id)
    expect(after?.reclaims, 'the dispatcher died, so this is a reclaim').toBe(1)
    expect(after?.attempts, 'and the consumer never ran, so no attempt is charged').toBe(0)
    void lease
  })

  it('a FAILED row always carries an error, so it is never a dead end', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)
    await expect(
      asTenant(
        tenant,
        `UPDATE outbox SET status='FAILED', claimed_at=NULL, lease_id=NULL WHERE id=$1 AND lease_id=$2`,
        [row.id, lease],
      ),
    ).rejects.toThrow(/outbox_failed_has_error/)
  })

  it('the reaper can exhaust its budget and land on FAILED with a synthetic error', async () => {
    const row = await enqueue()

    /*
     * FOUR deaths return the row to PENDING. The fifth terminates it, because
     * the budget is "five lease expiries", and a row at reclaims = 5 may not
     * be PENDING — outbox_reclaims_exhausted_is_failed says so.
     *
     * This is why the reaper's predicate is `reclaims + 1 < 5` and not
     * `reclaims < 5`. The naive form passes at reclaims = 4, reclaims to 5,
     * and is rejected by the constraint. The statement has to be written in
     * terms of the resulting value, because that is what the constraint is
     * written in terms of — and this test is how the off-by-one was found.
     */
    for (let i = 0; i < 4; i += 1) {
      await claim(row.id)
      await reap(row.id, '0 seconds')
    }
    expect((await read(row.id))?.reclaims).toBe(4)

    // The fifth death has no budget left, so the exhaustion path runs.
    await claim(row.id)
    await asTenant(
      tenant,
      `UPDATE outbox
          SET status='FAILED', claimed_at=NULL, lease_id=NULL, reclaims = reclaims + 1,
              last_error = 'lease expired ' || (reclaims + 1) ||
                           ' times without an ack; no consumer error recorded',
              updated_at = now(), version = version + 1
        WHERE status='IN_FLIGHT' AND claimed_at < now() - interval '0 seconds' AND reclaims + 1 >= 5
          AND id = $1`,
      [row.id],
    )

    const after = await read(row.id)
    expect(after?.status).toBe('FAILED')
    expect(after?.attempts, 'the consumer never ran even once').toBe(0)
    expect(
      after?.last_error,
      'a row that died of dispatcher restarts must be distinguishable on sight from one that failed on its merits',
    ).toMatch(/lease expired 5 times without an ack/)
  })
})

/* ==================================================================== *
 * 4. REPLAY
 * ==================================================================== */
describe('replay: the original survives and a fresh id cannot bypass deduplication', () => {
  async function completed(): Promise<Row> {
    const row = await enqueue()
    const lease = await claim(row.id)
    await ack(row.id, lease)
    const done = await read(row.id)
    if (!done) throw new Error('row vanished')
    return done
  }

  it('leaves the original byte-identical', async () => {
    const original = await completed()

    await asTenant(
      tenant,
      `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                           correlation_id, created_by, updated_by, replay_of)
       SELECT tenant_id, topic, payload, effect_key, occurred_at,
              correlation_id, created_by, updated_by, id
         FROM outbox WHERE id = $1`,
      [original.id],
    )

    const after = await read(original.id)
    expect(after?.status).toBe('DONE')
    expect(after?.dispatched_at?.toISOString()).toBe(original.dispatched_at?.toISOString())
    expect(after?.payload).toEqual(original.payload)
  })

  it('the replay is a NEW row that points back at its original', async () => {
    const original = await completed()
    const replay = await asTenant<Row>(
      tenant,
      `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                           correlation_id, created_by, updated_by, replay_of)
       SELECT tenant_id, topic, payload, effect_key, occurred_at,
              correlation_id, created_by, updated_by, id
         FROM outbox WHERE id = $1
       RETURNING *`,
      [original.id],
    ).then((r) => r[0])

    expect(replay?.id).not.toBe(original.id)
    expect(replay?.status).toBe('PENDING')
    expect(
      replay?.effect_key,
      'the replay carries the ORIGINAL effect_key — this is what stops it bypassing the consumer dedup',
    ).toBe(original.effect_key)
  })

  it('REFUSES a replay that mints a fresh effect_key', async () => {
    /*
     * The acceptance case, stated exactly: a new replay id must not bypass
     * business-effect deduplication. ADR-0010 keyed sent_notifications on
     * outbox.id, so a replay's fresh id alone would sail past it. The dedup
     * key is (tenant_id, topic, effect_key), and this is what keeps the
     * replay honest about which effect it is.
     */
    const original = await completed()
    await expect(
      asTenant(
        tenant,
        `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                             correlation_id, created_by, updated_by, replay_of)
         SELECT tenant_id, topic, payload, 'SMUGGLED-' || $2, occurred_at,
                correlation_id, created_by, updated_by, id
           FROM outbox WHERE id = $1`,
        [original.id, unique()],
      ),
    ).rejects.toThrow(/must carry the original topic, effect_key and correlation_id/)
  })

  it('REFUSES replaying a row that is still live', async () => {
    const row = await enqueue()
    await expect(
      asTenant(
        tenant,
        `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                             correlation_id, created_by, updated_by, replay_of)
         SELECT tenant_id, topic, payload, effect_key, occurred_at,
                correlation_id, created_by, updated_by, id
           FROM outbox WHERE id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/cannot replay a row that is still PENDING/)
  })

  it('REFUSES a replay pointing at another tenant’s row', async () => {
    const mine = await completed()
    await expect(
      asTenant(
        other,
        `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                             correlation_id, created_by, updated_by, replay_of)
         VALUES ($1, 'INVOICE_EMAIL', '{"x":1}'::jsonb, 'EK', now(), gen_random_uuid(), $2, $2, $3)`,
        [other.tenantId, other.ownerId, mine.id],
      ),
    ).rejects.toThrow()
  })
})

/* ==================================================================== *
 * 5. PAYLOAD LIMIT
 * ==================================================================== */
describe('payload limit: rejected at the documented boundary', () => {
  /*
   * The bound is measured on the NORMALISED jsonb text, not on the bytes the
   * client sent. PostgreSQL re-serialises canonically — it inserts a space
   * after each colon — so a 4096-byte input arrives as 4097 and is refused.
   *
   * Found by this test failing, and worth pinning rather than papering over:
   * a client-side length check against the same number will disagree with the
   * database at the margin, and the enqueuer should treat 4 KB as a budget
   * with headroom rather than an exact boundary to sit on.
   */
  const normalisedLength = (payload: string): Promise<number | undefined> =>
    runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) => scalarOn<number>(tx, `SELECT length($1::jsonb #>> '{}')`, [payload])),
    )

  it('normalises the payload before measuring it, which shifts the boundary', async () => {
    const sent = JSON.stringify({ k: 'x' })
    expect(sent.length).toBe(9)
    expect(await normalisedLength(sent), 'jsonb adds a space after the colon').toBe(10)
  })

  it('accepts a payload AT the 4096-byte limit, measured as the database measures it', async () => {
    const filler = 'x'.repeat(4096 - JSON.stringify({ k: '' }).length - 1)
    const payload = JSON.stringify({ k: filler })
    expect(await normalisedLength(payload)).toBe(4096)

    const row = await enqueue(tenant, { payload })
    expect(row.id).toBeTruthy()
  })

  it('REFUSES one byte over', async () => {
    const filler = 'x'.repeat(4096 - JSON.stringify({ k: '' }).length)
    const payload = JSON.stringify({ k: filler })
    expect(await normalisedLength(payload)).toBe(4097)

    await expect(enqueue(tenant, { payload })).rejects.toThrow(/outbox_payload_bounded/)
  })

  it.each([' ', '   ', 'sale:S1 ', ' sale:S1', '\tsale:S1', 'sale:S1\n'])(
    'REFUSES an effect_key that is blank, untrimmed or carries whitespace at an edge: %j',
    async (effect_key) => {
      /*
       * The shape matters more than the length, because effect_key is what
       * all of ADR-0019 correction 3 rests on. 'sale:S1 ' and 'sale:S1' would be two
       * dedup slots for ONE effect.
       *
       * The tab and newline cases are why this is a regex rather than the
       * `effect_key = btrim(effect_key)` the review proposed. Measured
       * against the engine: BTRIM STRIPS SPACES ONLY, so a tab-prefixed key
       * satisfies it and passes. A tab is exactly as invisible in a log line
       * as a space, so the constraint names the whitespace CLASS.
       */
      await expect(enqueue(tenant, { effect_key })).rejects.toThrow(/outbox_effect_key_bounded/)
    },
  )

  it('accepts an ordinary effect_key, so the rule is not simply blocking everything', async () => {
    const row = await enqueue(tenant, { effect_key: 'sale:S1:invoice-email' })
    expect(row.effect_key).toBe('sale:S1:invoice-email')
  })

  it('still REFUSES a payload that is not an object', async () => {
    for (const notAnObject of ['null', '42', '"text"', '[1,2,3]']) {
      await expect(
        enqueue(tenant, { payload: notAnObject }),
        `${notAnObject} satisfies NOT NULL and is not a payload`,
      ).rejects.toThrow(/outbox_payload_is_object/)
    }
  })
})

/* ==================================================================== *
 * 6. TENANT ENUMERATION
 * ==================================================================== */
describe('tenant enumeration: scoped, bounded, and nobody starves', () => {
  it('a claim under one tenant cannot see another tenant’s pending rows', async () => {
    const mine = await enqueue(tenant)
    const theirs = await enqueue(other)

    const visible = await asTenant<{ id: string }>(other, `SELECT id FROM outbox`)
    const ids = visible.map((r) => r.id)

    expect(ids, 'the other tenant sees its own row').toContain(theirs.id)
    expect(ids, 'and cannot see mine, through a bare SELECT with no predicate').not.toContain(
      mine.id,
    )
  })

  it('WITH CHECK refuses an insert stamped with another tenant', async () => {
    await expect(
      asTenant(
        other,
        `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                             correlation_id, created_by, updated_by)
         VALUES ($1, 'INVOICE_EMAIL', '{"x":1}'::jsonb, 'EK', now(), gen_random_uuid(), $2, $2)`,
        [tenant.tenantId, other.ownerId],
      ),
    ).rejects.toThrow()
  })

  it('A SUSPENDED OR CLOSED TENANT IS STILL ENUMERATED — the starvation case', async () => {
    /*
     * The liveness hole, not an isolation hole. A suspended tenant can hold a
     * final invoice email or an FBR push owed for a period already posted.
     * 001's only index on `tenants` is partial on status='ACTIVE', which makes
     * the WRONG enumeration query the convenient one to write — and a row
     * belonging to a tenant nobody enumerates is never claimed, never reaped,
     * and never measured, because no measurement is taken for it.
     */
    const dormant = await createTenantFixture('OBZ')
    const owed = await enqueue(dormant)

    await runAs({ tenantId: dormant.tenantId, userId: null }, async () => {
      const { withGlobal } = await import('@finsoft/database')
      await withGlobal((tx) =>
        rawOn(tx, `UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [dormant.tenantId]),
      )
    })

    const { withGlobal } = await import('@finsoft/database')

    const activeOnly = await withGlobal((tx) =>
      rawOn<{ id: string }>(tx, `SELECT id FROM tenants WHERE status = 'ACTIVE'`),
    )
    expect(
      activeOnly.map((t) => t.id),
      'the convenient query is the one that strands the row',
    ).not.toContain(dormant.tenantId)

    const everyTenant = await withGlobal((tx) =>
      rawOn<{ id: string }>(tx, `SELECT id FROM tenants`),
    )
    expect(
      everyTenant.map((t) => t.id),
      'the required enumeration covers every tenant, of any status',
    ).toContain(dormant.tenantId)

    const stillClaimable = await asTenant<{ id: string }>(
      dormant,
      `SELECT id FROM outbox WHERE status = 'PENDING' ORDER BY available_at, id LIMIT 50`,
    )
    expect(
      stillClaimable.map((r) => r.id),
      'and the row is dispatchable once the tenant is enumerated',
    ).toContain(owed.id)
  })

  it('the claim query is bounded, and orders deterministically', async () => {
    /*
     * LIMIT is the per-tenant batch cap: without it one tenant with a backlog
     * monopolises a poll cycle. ORDER BY available_at, id is the tiebreak —
     * many rows share available_at = now() from the default, and without `id`
     * the order among them is arbitrary, which permits a starved row and
     * makes the plan irreproducible.
     */
    const batch = await Promise.all([enqueue(), enqueue(), enqueue(), enqueue()])
    const page = await asTenant<{ id: string }>(
      tenant,
      `SELECT id FROM outbox WHERE status = 'PENDING' ORDER BY available_at, id LIMIT 2`,
    )

    expect(page).toHaveLength(2)
    const again = await asTenant<{ id: string }>(
      tenant,
      `SELECT id FROM outbox WHERE status = 'PENDING' ORDER BY available_at, id LIMIT 2`,
    )
    expect(
      again.map((r) => r.id),
      'the same page twice, or a row can starve',
    ).toEqual(page.map((r) => r.id))
    expect(batch.length).toBe(4)
  })

  it('the claim query uses the partial index rather than a sequential scan', async () => {
    /*
     * Against a POPULATED table, because a plan assertion over an empty one
     * proves nothing: the planner picks a sequential scan for a handful of
     * rows whatever the indexes say, and would do so again if the index were
     * dropped. 2000 rows is enough to make the index the cheaper option here
     * while keeping the test fast; the real bar is the dispatcher PR's
     * EXPLAIN (ANALYZE, BUFFERS) against 10^6 rows across 50+ tenants.
     */
    await asTenant(
      tenant,
      /*
       * available_at a century out, deliberately. These rows exist to give
       * the planner a table worth indexing; they are not work.
       *
       * Dated now(), they became DUE — and the dispatcher enumerates every
       * tenant of any status, so `tests/integration/outbox-dispatcher.spec.ts`
       * picked up 2000 rows for a topic no consumer handles and failed every
       * one of them. The bulk rows still populate outbox_pending_idx, because
       * it is partial on status and keyed on available_at whatever the value
       * is, so the plan assertion is unaffected.
       */
      `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at,
                           available_at, correlation_id, created_by, updated_by)
       SELECT $1, 'BULK_PROBE', '{"n":1}'::jsonb, 'BULK-' || g, now(),
              now() + interval '100 years', gen_random_uuid(), $2, $2
         FROM generate_series(1, 2000) AS g`,
      [tenant.tenantId, tenant.ownerId],
    )
    await asTenant(tenant, `ANALYZE outbox`)

    const plan = await asTenant<{ 'QUERY PLAN': string }>(
      tenant,
      `EXPLAIN SELECT id FROM outbox WHERE status = 'PENDING' ORDER BY available_at, id LIMIT 50`,
    )
    const text = plan.map((r) => r['QUERY PLAN']).join('\n')

    expect(text, `plan was:\n${text}`).toMatch(/outbox_pending_idx/)
    expect(
      text,
      'a sort above the index scan means the index ordering is not being used',
    ).not.toMatch(/^\s*->\s*Sort/m)
  })
})

/* ==================================================================== *
 * 7. PUBLISH / ACK FAILURE
 * ==================================================================== */
describe('publish/ack failure: a crash after enqueue redelivers, and loses nothing', () => {
  it('a row claimed by a dispatcher that dies is redelivered, not stranded', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)

    // The dispatcher performs the side effect, then dies before acking.

    const reaped = await reap(row.id, '0 seconds')
    expect(
      reaped.map((r) => r.id),
      'the row must come back',
    ).toContain(row.id)

    const after = await read(row.id)
    expect(after?.status).toBe('PENDING')
    expect(after?.claimed_at, 'and the lease is released').toBeNull()
    expect(after?.lease_id).toBeNull()
    expect(after?.reclaims).toBe(1)

    // It is claimable again, by anyone.
    const next = await claim(row.id)
    expect(next).not.toBe(lease)
  })

  it('a half-applied ack is impossible: DONE cannot exist without dispatched_at', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)

    await expect(
      asTenant(
        tenant,
        `UPDATE outbox SET status='DONE', claimed_at=NULL, lease_id=NULL WHERE id=$1 AND lease_id=$2`,
        [row.id, lease],
      ),
    ).rejects.toThrow(/outbox_dispatched_at_matches_status/)

    expect((await read(row.id))?.status, 'so the row stays claimable after a failed ack').toBe(
      'IN_FLIGHT',
    )
  })

  it('nor can DONE coexist with a live claim', async () => {
    const row = await enqueue()
    const lease = await claim(row.id)
    await expect(
      asTenant(
        tenant,
        `UPDATE outbox SET status='DONE', dispatched_at=now() WHERE id=$1 AND lease_id=$2`,
        [row.id, lease],
      ),
    ).rejects.toThrow(/outbox_claimed_at_matches_status/)
  })

  it('the event itself is never lost: no role holds DELETE', async () => {
    const row = await enqueue()
    await expect(asTenant(tenant, `DELETE FROM outbox WHERE id = $1`, [row.id])).rejects.toThrow(
      /permission denied/,
    )

    expect(
      await read(row.id),
      'rule 4: the evidence that a side effect was owed survives',
    ).toBeTruthy()
  })
})

/* ==================================================================== *
 * Structural assertions that belong with this table rather than in the
 * generic schema suite.
 * ==================================================================== */
describe('the structural guarantees', () => {
  it('forces row level security, not merely enables it', async () => {
    const { withGlobal } = await import('@finsoft/database')
    const row = await withGlobal((tx) =>
      rawOn<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        tx,
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'outbox'`,
      ),
    )
    expect(row[0]?.relrowsecurity).toBe(true)
    expect(row[0]?.relforcerowsecurity, 'without FORCE the owner sees every tenant').toBe(true)
  })

  it('withholds UPDATE on every evidence column', async () => {
    const { withGlobal } = await import('@finsoft/database')
    const granted = await withGlobal((tx) =>
      rawOn<{ column_name: string }>(
        tx,
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_name = 'outbox' AND grantee = 'finsoft_app' AND privilege_type = 'UPDATE'`,
      ),
    ).then((rows) => rows.map((r) => r.column_name))

    for (const evidence of [
      'id',
      'tenant_id',
      'topic',
      'payload',
      'effect_key',
      'occurred_at',
      'correlation_id',
      'created_at',
      'created_by',
      'updated_by',
      'replay_of',
    ]) {
      expect(granted, `${evidence} must not be UPDATE-able by the application role`).not.toContain(
        evidence,
      )
    }

    for (const state of ['status', 'attempts', 'reclaims', 'claimed_at', 'lease_id']) {
      expect(granted, `${state} is lifecycle state and must be writable`).toContain(state)
    }
  })

  it('pins updated_by to created_by, since no machine principal exists', async () => {
    const row = await enqueue()
    const scalar = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        scalarOn<boolean>(tx, `SELECT updated_by = created_by FROM outbox WHERE id = $1`, [row.id]),
      ),
    )
    expect(scalar).toBe(true)
  })
})
