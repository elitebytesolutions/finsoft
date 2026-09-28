import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HashingQueueFullError, hashPassword, login, verifyCredential } from '@finsoft/auth'
import { withTenant } from '@finsoft/database'
import { prepareTestDatabase, runAs, teardownTestDatabase, unique } from '@finsoft/database/testing'
import { Redis } from 'ioredis'
import { createActiveUserFixture, type ActiveUserFixture } from './helpers/auth-seed.ts'

/*
 * The login TOCTOU, closed. Architecture F1-F3, Database F1, Security N1
 * (2026-09-27).
 *
 * C2 split login into two transactions so argon2id runs with no database
 * connection held. That opens a window — tens of milliseconds — between
 * the read and the write. These tests inject a mutation into EXACTLY that
 * window, on a separate connection, via `login()`'s test-only
 * `testHooks.beforeWrite` (production code never sets this — see its own
 * doc comment in packages/database/src/auth/login.ts), and assert the
 * write's own state guard (status = 'ACTIVE' AND password_hash =
 * $verifiedHash, checked by the UPDATE's row lock at write time) refuses
 * the session — never a version-only re-read, which is what the earlier,
 * rejected version of this file did wrong.
 */

function loginInput(u: ActiveUserFixture) {
  return {
    tenantCode: u.code,
    email: u.email,
    password: u.password,
    ip: '203.0.113.1',
    ipPrefix: '203.0.113.1',
    deviceId: null,
    userAgent: null,
  }
}

async function sessionCount(u: ActiveUserFixture): Promise<number> {
  return runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
    withTenant(async (tx) => {
      const rows = await tx
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', u.ownerId)
        .execute()
      return rows.length
    }),
  )
}

describe('login TOCTOU: a state change between read and write must produce identical 401, no session row', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
    // Same ordering constraint as tests/integration/auth.spec.ts: this must
    // run AFTER prepareTestDatabase() (which loads .env) and BEFORE
    // anything in @finsoft/auth opens a Redis connection — throttle.ts's
    // client() caches its connection on first use and never re-reads
    // REDIS_URL afterwards, so setting this inside an individual `it` (as
    // item 1d's test originally did) is too late once an earlier test in
    // this file has already called login().
    process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL']
  }, 60_000)
  afterAll(teardownTestDatabase)

  it('user disabled between verification and the write', async () => {
    const u = await createActiveUserFixture(`TT${unique()}`.slice(0, 6))
    expect(await sessionCount(u)).toBe(0)

    const result = await login(loginInput(u), undefined, {
      beforeWrite: async () => {
        await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
          withTenant((tx) =>
            tx
              .updateTable('users')
              .set({ status: 'DISABLED', updated_by: null, version: sql`version + 1` })
              .where('id', '=', u.ownerId)
              .execute(),
          ),
        )
      },
    })

    expect(result.outcome).toBe('failed')
    expect(await sessionCount(u), 'no session row for a user disabled mid-login').toBe(0)
  })

  it('password changed (and version bumped) between verification and the write', async () => {
    const u = await createActiveUserFixture(`TT${unique()}`.slice(0, 6))
    expect(await sessionCount(u)).toBe(0)

    const newHash = await hashPassword('a-completely-different-password')

    const result = await login(loginInput(u), undefined, {
      beforeWrite: async () => {
        await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
          withTenant((tx) =>
            tx
              .updateTable('users')
              .set({ password_hash: newHash, updated_by: null, version: sql`version + 1` })
              .where('id', '=', u.ownerId)
              .execute(),
          ),
        )
      },
    })

    expect(
      result.outcome,
      'the credential verified against is no longer current — must not succeed',
    ).toBe('failed')
    expect(await sessionCount(u)).toBe(0)
  })

  it('a password change with NO version bump is unreachable at the schema level (defence in depth, not a gap)', async () => {
    // users_enforce_transition (migration 007) requires version to increase
    // on EVERY update, unconditionally — there is no UPDATE statement,
    // through finsoft_app or otherwise, that can change password_hash
    // without also bumping version. This test proves that claim rather than
    // assuming it: the attempt itself is rejected by the trigger, before
    // login's own guard would ever be reached.
    const u = await createActiveUserFixture(`TT${unique()}`.slice(0, 6))
    const newHash = await hashPassword('another-password')

    const error = await runAs({ tenantId: u.tenantId, userId: u.ownerId }, () =>
      withTenant((tx) =>
        tx
          .updateTable('users')
          .set({ password_hash: newHash })
          .where('id', '=', u.ownerId)
          .execute(),
      ),
    ).then(
      () => null,
      (e: unknown) => e,
    )

    expect(
      error,
      'a version-unchanged update must be rejected by the trigger itself',
    ).not.toBeNull()
  })

  it('tenant suspended between verification and the write', async () => {
    const u = await createActiveUserFixture(`TT${unique()}`.slice(0, 6))
    expect(await sessionCount(u)).toBe(0)

    const result = await login(loginInput(u), undefined, {
      beforeWrite: async () => {
        // finsoft_app holds no UPDATE on tenants.status (ADR-0023 §1) — this
        // simulates the operator action, which goes through finsoft_migration
        // in production (a separately permissioned path, not built here).
        const { Client } = await import('pg')
        const url = process.env['TEST_MIGRATION_DATABASE_URL']
        if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
        const client = new Client({ connectionString: url })
        await client.connect()
        try {
          await client.query('UPDATE tenants SET status = $2 WHERE id = $1', [
            u.tenantId,
            'SUSPENDED',
          ])
        } finally {
          await client.end()
        }
      },
    })

    expect(result.outcome).toBe('failed')
    expect(await sessionCount(u)).toBe(0)
  })

  it('item 1d: the hashing queue cap is real, and the counter it would spend is a real Redis key', async () => {
    // login()'s own three-line catch-and-refund wiring — `catch (error) {
    // if (error instanceof HashingQueueFullError) await
    // refundLayers(layers) }` — is proved directly, without a timing race
    // against argon2's own latency, by packages/auth/src/login.spec.ts
    // (mocks the DB layer and password verification to force the error
    // deterministically). What this integration test proves instead: the
    // semaphore cap is REAL (not a mock), and the key it would refund is
    // the SAME key a real login increments.
    const u = await createActiveUserFixture(`TT${unique()}`.slice(0, 6))
    const normalisedEmail = u.email.toLowerCase()

    const redis = new Redis(process.env['REDIS_URL'] as string)
    const emailCounterKey = `throttle:login:email:${normalisedEmail}`
    await redis.del(emailCounterKey)

    try {
      // Saturate the semaphore for real (8 concurrent + a 64 queue = 72
      // capacity), then confirm the 73rd call is refused SYNCHRONOUSLY —
      // acquire() throws before any further await, so there is no race
      // against argon2's own latency in proving the cap itself.
      const fillers: Promise<void>[] = []
      for (let i = 0; i < 72; i++) {
        fillers.push(
          verifyCredential(null, 'irrelevant').then(
            () => undefined,
            () => undefined,
          ),
        )
      }
      await expect(verifyCredential(null, 'irrelevant')).rejects.toBeInstanceOf(
        HashingQueueFullError,
      )
      await Promise.all(fillers)

      // The queue has now drained. A real login increments exactly the key
      // item 1d's refund targets.
      expect(await redis.get(emailCounterKey)).toBeNull()
      await login(loginInput(u))
      expect(await redis.get(emailCounterKey)).toBe('1')
    } finally {
      await redis.del(emailCounterKey)
      await redis.quit()
    }
  }, 30_000)

  it('two genuinely concurrent valid logins for the same user both succeed (no 500, no lost update)', async () => {
    const u = await createActiveUserFixture(`TT${unique()}`.slice(0, 6))

    const [a, b] = await Promise.all([login(loginInput(u)), login(loginInput(u))])

    expect(a.outcome, 'first concurrent login must succeed').toBe('success')
    expect(
      b.outcome,
      'second concurrent login must succeed too — no optimistic-lock false negative',
    ).toBe('success')
    expect(await sessionCount(u), 'each successful login writes its own session').toBe(2)
  })
})
