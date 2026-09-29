import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashRefreshToken, login, mintRefreshToken } from '@finsoft/auth'
import { spendRefreshToken } from '@finsoft/database/auth'
import {
  prepareTestDatabase,
  teardownTestDatabase,
  TEST_TARGET,
  unique,
} from '@finsoft/database/testing'
import { createActiveUserFixture } from './helpers/auth-seed.ts'

/*
 * B1's row-lock race, and DB F2/N3's logout-races-refresh savepoint fix —
 * through the REAL functions (spendRefreshToken), not the file-local raw
 * `spend()` helper `refresh-rotation.spec.ts` uses for its lower-level
 * trigger tests. Security/Database re-review N2, N3 (2026-09-27).
 */

function migrationClient(): Client {
  const url = process.env['TEST_MIGRATION_DATABASE_URL']
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
  return new Client({ connectionString: url })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * C1-sec, security re-review 2026-09-27; revised 2026-09-29 after CI flake
 * M1-corr.
 *
 * ROOT CAUSE of the flake, found by reproducing it on demand (run this
 * file's N2 test alone, repeatedly — it failed every time once isolated
 * from the noise of a full suite run) and then bisecting with `docker exec
 * ... psql` sessions against the live test cluster mid-block:
 *
 * The original code ran this poll query on the SAME connection (`locker`)
 * that held `BEGIN; SELECT ... FOR UPDATE`. That connection has an open
 * transaction with a real, lock-holding snapshot from before the two
 * `spendRefreshToken` backends ever connected. Verified directly (a
 * throwaway probe script, three concurrent `pg.Client`s: a locker doing
 * `BEGIN` + a row lock, two blockers connecting and blocking afterward,
 * and a THIRD "watcher" connection also polling `pg_stat_activity`): a
 * fresh/short-lived connection sees the two new backends and their
 * `pg_blocking_pids()` entries IMMEDIATELY; the locker's OWN connection
 * never sees them appear in `pg_stat_activity` AT ALL, for as long as its
 * transaction stays open — not "slow to notice", genuinely never, across
 * 20 polls / 6 seconds. This reproduced with both the original `pg_locks`
 * `NOT granted` count and a `pg_blocking_pids()`-based count: the query
 * text was never the defect, the CONNECTION issuing it was. (Cause, per
 * the Security seat's review: PostgreSQL snapshots the cumulative-stats
 * views, `pg_stat_activity` included, ONCE per transaction and holds that
 * snapshot until the transaction ends. Any open transaction does this, not
 * specifically a row lock, so backends that connect after the first poll
 * stay invisible to that session. That explains the flakiness: in a full
 * run, pool connections that already existed were visible; in an isolated
 * run, fresh ones were not.)
 *
 * The fix: poll from a connection that is NOT the lock holder — a plain,
 * no-open-transaction connection, opened once and reused for every poll.
 * `expected` counts DISTINCT backends with a non-empty
 * `pg_blocking_pids()` (see the second, independently-caught bug below),
 * not raw `pg_locks` rows.
 *
 * Second bug, caught while fixing the first: an intermediate version of
 * this function required the LOCKER's own pid specifically inside every
 * waiter's `pg_blocking_pids()` result
 * (`pg_blocking_pids(pid) @> ARRAY[lockerPid]`), reasoning that the
 * function "resolves the whole wait chain to its root". Verified against
 * the same live two-waiter block that this is false for exactly the
 * two-waiters-on-one-row case: Postgres's own fairness/anti-thundering-
 * herd mechanism (`heap_lock_tuple`'s `LockTuple` before
 * `XactLockTableWait`) makes the SECOND arrival queue on a heavyweight
 * **tuple** lock held by the FIRST arrival, not on the true locker
 * directly — a documented PostgreSQL "soft block", which
 * `pg_blocking_pids()` reports as itself the blocker and does NOT recurse
 * through. So `pg_blocking_pids(secondWaiterPid)` is `[firstWaiterPid]`,
 * never `[lockerPid]`, and a query that demands `lockerPid` specifically
 * can never see 2. Asking only "is this backend blocked on ANYTHING"
 * (`cardinality(pg_blocking_pids(pid)) > 0`) avoids that false requirement
 * — correct regardless of which of the two backends queues behind the
 * other's tuple lock — while still being immune to the locktype reasoning
 * (`transactionid` vs `tuple`) the original `pg_locks` version needed.
 */
async function waitForBlockedWaiters(
  observer: Client,
  expected: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = await observer.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM pg_stat_activity a
        WHERE a.application_name = $1
          AND cardinality(pg_blocking_pids(a.pid)) > 0`,
      [TEST_TARGET.applicationName],
    )
    if (Number(rows[0]?.n ?? '0') >= expected) return
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${expected} blocked backend(s) (application_name=${TEST_TARGET.applicationName})`,
      )
    }
    await delay(15)
  }
}

describe('refresh concurrency, through spendRefreshToken itself', () => {
  // N2 needs TWO real spendRefreshToken calls in flight on TWO separate
  // backends at once, which a pool of 1 (the harness default) cannot
  // produce — a second caller would queue for the connection, not race for
  // the row. Set BEFORE prepareTestDatabase(), which only defaults the
  // variable if unset (see harness.ts's own comment on this).
  process.env['DATABASE_POOL_MAX'] = '3'

  beforeAll(prepareTestDatabase, 60_000)
  afterAll(teardownTestDatabase)

  async function liveRefreshToken(): Promise<{ raw: string; hash: string }> {
    const u = await createActiveUserFixture(`RC${unique()}`.slice(0, 6))
    const result = await login({
      tenantCode: u.code,
      email: u.email,
      password: u.password,
      ip: '203.0.113.9',
      ipPrefix: '203.0.113.9',
      deviceId: null,
      userAgent: null,
    })
    if (result.outcome !== 'success') throw new Error('fixture login did not succeed')
    return { raw: result.refreshToken, hash: hashRefreshToken(result.refreshToken) }
  }

  it('DB F2/N3: a family revoked (logout) between the read and the spend is a clean "reused", never a 500', async () => {
    const token = await liveRefreshToken()

    const outcome = await spendRefreshToken(
      {
        presentedTokenHash: token.hash,
        newTokenHash: hashRefreshToken(mintRefreshToken().raw),
        deviceId: null,
      },
      undefined,
      {
        beforeSpend: async () => {
          // Simulate a concurrent logout: revoke the family directly, on a
          // SEPARATE connection, after spendRefreshToken has already read
          // the candidate row (which saw an unrevoked family) but before it
          // attempts the spend UPDATE. Without the SAVEPOINT fix, the
          // trigger's 23514 aborts the transaction and the subsequent
          // revokeFamilyAndSession call raises 25P02, surfacing as a 500.
          const client = migrationClient()
          await client.connect()
          try {
            await client.query(
              `UPDATE refresh_token_families SET revoked_at = now(), revoked_reason = 'TEST_CONCURRENT_LOGOUT',
                 version = version + 1
               WHERE id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
              [token.hash],
            )
          } finally {
            await client.end()
          }
        },
      },
    )

    expect(outcome.outcome, 'must be a clean outcome, never a thrown 25P02').toBe('reused')

    // C4-sec, security re-review 2026-09-27: the savepoint fix must not just
    // avoid the 500 — it must still run the REAL consequence of a reuse,
    // revokeFamilyAndSession, to completion. The family was already revoked
    // by the simulated logout above; the session it owns must be too.
    const check = migrationClient()
    await check.connect()
    try {
      const session = await check.query<{ revoked_at: string | null }>(
        `SELECT s.revoked_at FROM sessions s
           JOIN refresh_token_families f ON f.session_id = s.id
          WHERE f.id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
        [token.hash],
      )
      expect(
        session.rows[0]?.revoked_at,
        'the session must be revoked too, not just reported as reused',
      ).not.toBeNull()
    } finally {
      await check.end()
    }
  })

  it('N2: two real spendRefreshToken calls racing the SAME token — exactly one success, one reused, family+session revoked, successor also rejected', async () => {
    const token = await liveRefreshToken()

    // A third, independent connection holds the row lock so both
    // spendRefreshToken calls genuinely block at their UPDATE step rather
    // than one finishing before the other starts.
    const locker = migrationClient()
    await locker.connect()

    // A FOURTH, separate connection does the polling. Not the locker's own
    // connection: verified directly (three-plus-`docker exec psql`
    // sessions against the live test cluster, root-caused above) that once
    // `locker` has an open transaction holding a real row lock, ITS OWN
    // queries against `pg_stat_activity` stop seeing backends that connect
    // afterward — a fresh/idle connection sees them immediately. Using
    // `locker` for both jobs is what made this wait unable to ever observe
    // 2, on every run, once isolated from a full-suite run's incidental
    // timing.
    const observer = migrationClient()
    await observer.connect()

    // Both calls are started, and MUST be settled (never just awaited on
    // the happy path), no matter what happens between here and there —
    // including a `waitForBlockedWaiters` timeout. The earlier version of
    // this test awaited them only after the wait succeeded: if the wait
    // itself threw, the locker's transaction was never committed or rolled
    // back, so the row lock was held forever — and whichever call(s) really
    // were blocked on it then ran into their own 15s `statement_timeout`
    // (`57014 canceling statement ... while locking tuple`), as an
    // unhandled rejection, well after this test had already failed for a
    // different reason. `try/finally` on the locker plus `Promise.allSettled`
    // here means a wait timeout is reported once, cleanly, and never
    // cascades into orphaned locks or unhandled-rejection noise for
    // whatever test runs next.
    let callA: ReturnType<typeof spendRefreshToken> | undefined
    let callB: ReturnType<typeof spendRefreshToken> | undefined
    let setupError: unknown

    try {
      await locker.query('BEGIN')
      const tokenRow = await locker.query<{ id: string }>(
        'SELECT id FROM refresh_tokens WHERE token_hash = $1',
        [token.hash],
      )
      const tokenId = tokenRow.rows[0]?.id
      expect(tokenId).toBeTruthy()
      await locker.query('SELECT * FROM refresh_tokens WHERE id = $1 FOR UPDATE', [tokenId])

      callA = spendRefreshToken({
        presentedTokenHash: token.hash,
        newTokenHash: hashRefreshToken(mintRefreshToken().raw),
        deviceId: null,
      })
      callB = spendRefreshToken({
        presentedTokenHash: token.hash,
        newTokenHash: hashRefreshToken(mintRefreshToken().raw),
        deviceId: null,
      })

      // Wait until Postgres itself reports both calls genuinely blocked,
      // rather than guessing how long that takes.
      await waitForBlockedWaiters(observer, 2)
    } catch (error) {
      // Recorded, not thrown yet: whichever of callA/callB DID get started
      // must still be settled below before this test ends, win or lose, or
      // a genuinely-blocked call left running past this point becomes an
      // unhandled rejection once its own statement_timeout eventually fires.
      setupError = error
    } finally {
      // No writes happened on either connection — COMMIT and ROLLBACK are
      // equally correct for releasing the FOR UPDATE lock. Try COMMIT
      // first (the expected path); fall back to ROLLBACK so an
      // already-aborted transaction still releases the connection instead
      // of throwing out of a finally.
      await locker.query('COMMIT').catch(() => locker.query('ROLLBACK').catch(() => {}))
      await locker.end().catch(() => {})
      await observer.end().catch(() => {})
    }

    // Await whatever was actually started, regardless of setupError, so
    // nothing is left an unhandled rejection — then surface the ORIGINAL
    // failure (the meaningful one: e.g. "timed out waiting for 2 blocked
    // backends") rather than a confusing downstream error.
    const settled = await Promise.allSettled(
      [callA, callB].filter((c): c is NonNullable<typeof c> => c !== undefined),
    )
    if (setupError) throw setupError

    const rejected = settled.find((s) => s.status === 'rejected')
    if (rejected && rejected.status === 'rejected') throw rejected.reason
    expect(settled, 'both calls must have been started and settled').toHaveLength(2)
    const fulfilled = settled as [
      PromiseFulfilledResult<Awaited<ReturnType<typeof spendRefreshToken>>>,
      PromiseFulfilledResult<Awaited<ReturnType<typeof spendRefreshToken>>>,
    ]
    const [a, b] = [fulfilled[0].value, fulfilled[1].value]

    const outcomes = [a.outcome, b.outcome].sort()
    expect(outcomes, 'exactly one success and one reused').toEqual(['reused', 'success'])

    const check = migrationClient()
    await check.connect()
    try {
      const family = await check.query<{ id: string; revoked_at: string | null }>(
        `SELECT id, revoked_at FROM refresh_token_families
          WHERE id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
        [token.hash],
      )
      expect(
        family.rows[0]?.revoked_at,
        'the family must be revoked after reuse was detected',
      ).not.toBeNull()

      const session = await check.query<{ revoked_at: string | null }>(
        `SELECT s.revoked_at FROM sessions s
           JOIN refresh_token_families f ON f.session_id = s.id
          WHERE f.id = $1`,
        [family.rows[0]?.id],
      )
      expect(session.rows[0]?.revoked_at, 'the session must be revoked too (B2)').not.toBeNull()

      // The successor: the WINNING call's rotation target, still unused —
      // find it and confirm spendRefreshToken now rejects it too, because
      // the family it belongs to was revoked after it was created.
      const successor = await check.query<{ token_hash: string }>(
        `SELECT token_hash FROM refresh_tokens
          WHERE family_id = $1 AND used_at IS NULL`,
        [family.rows[0]?.id],
      )
      expect(
        successor.rows,
        'the winning call must have inserted exactly one successor',
      ).toHaveLength(1)

      const successorOutcome = await spendRefreshToken({
        presentedTokenHash: successor.rows[0]!.token_hash,
        newTokenHash: hashRefreshToken(mintRefreshToken().raw),
        deviceId: null,
      })
      expect(
        successorOutcome.outcome,
        'the successor must also be dead once reuse revoked the whole family',
      ).toBe('reused')
    } finally {
      await check.end()
    }
  })
})
