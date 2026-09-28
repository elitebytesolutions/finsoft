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
 * C1-sec, security re-review 2026-09-27: poll `pg_locks` for the real number
 * of backends actually blocked waiting for the row lock, instead of a fixed
 * `delay(300)` and hoping both calls got there in time (or that CI is never
 * slower than 300ms). `NOT granted` on a `finsoft-test`-attributed backend is
 * exactly "this connection issued a statement that is blocked behind another
 * session's lock" — which is what committing the locker is supposed to wait
 * for, not a guess at how long that takes.
 */
async function waitForBlockedWaiters(
  client: Client,
  expected: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.application_name = $1`,
      [TEST_TARGET.applicationName],
    )
    if (Number(rows[0]?.n ?? '0') >= expected) return
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${expected} blocked waiter(s) in pg_locks`,
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
    await locker.query('BEGIN')
    const tokenRow = await locker.query<{ id: string }>(
      'SELECT id FROM refresh_tokens WHERE token_hash = $1',
      [token.hash],
    )
    const tokenId = tokenRow.rows[0]?.id
    expect(tokenId).toBeTruthy()
    await locker.query('SELECT * FROM refresh_tokens WHERE id = $1 FOR UPDATE', [tokenId])

    const callA = spendRefreshToken({
      presentedTokenHash: token.hash,
      newTokenHash: hashRefreshToken(mintRefreshToken().raw),
      deviceId: null,
    })
    const callB = spendRefreshToken({
      presentedTokenHash: token.hash,
      newTokenHash: hashRefreshToken(mintRefreshToken().raw),
      deviceId: null,
    })

    // Wait until pg_locks itself reports both calls genuinely blocked on the
    // row lock, rather than guessing how long that takes.
    await waitForBlockedWaiters(locker, 2)
    await locker.query('COMMIT')
    await locker.end()

    const [a, b] = await Promise.all([callA, callB])

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
