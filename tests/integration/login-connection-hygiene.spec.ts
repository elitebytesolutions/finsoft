import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { login } from '@finsoft/auth'
import {
  poolStats,
  prepareTestDatabase,
  TEST_TARGET,
  teardownTestDatabase,
  unique,
} from '@finsoft/database/testing'
import { Client } from 'pg'
import { createActiveUserFixture, type ActiveUserFixture } from './helpers/auth-seed.ts'

/*
 * C1, architecture re-review 2026-09-27: prove that the login split (see
 * packages/database/src/auth/login.ts's own header on C2/the two
 * transactions) actually delivers the property it claims — that no
 * `finsoft_app` connection sits checked out of the pool, or idle in a
 * transaction, while `decide()` runs argon2id.
 *
 * There is no hook that fires DURING decide() itself (argon2 is a single
 * opaque await, not interruptible mid-hash), so this observes the moment
 * immediately AFTER decide() resolves and BEFORE the write's transaction
 * opens — `testHooks.beforeWrite`, the same hook login-toctou.spec.ts uses.
 * That moment is a valid witness for the whole window: if a regression ever
 * held transaction one open across decide() (the exact bug the C2 split
 * exists to avoid), that connection would still be checked out / still be
 * `idle in transaction` right here, because nothing between decide()
 * returning and this hook firing does any I/O that could have released it.
 * A clean reading at this point is only possible if the read transaction
 * had already committed and released its connection before decide() ran.
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

describe('login() holds no connection across argon2id verification (C1)', () => {
  beforeAll(prepareTestDatabase, 60_000)
  afterAll(teardownTestDatabase)

  it('no pool connection is checked out, and no finsoft_app backend is idle in transaction, at the read/write boundary', async () => {
    const u = await createActiveUserFixture(`TT${unique()}`.slice(0, 6))

    // A SEPARATE connection, not drawn from @finsoft/database's own pool —
    // otherwise probing the pool's state would itself check out the one
    // connection being measured. Connects as finsoft_app (same role the
    // pool uses): pg_stat_activity hides `state` for another role's
    // backends from a non-superuser, but a role can always see its own.
    const url = process.env['TEST_DATABASE_URL']
    if (!url) throw new Error('TEST_DATABASE_URL is not set')
    const probe = new Client({ connectionString: url })
    await probe.connect()

    let observed: { poolCheckedOut: number; idleInTransaction: number } | undefined

    try {
      const result = await login(loginInput(u), undefined, {
        beforeWrite: async () => {
          const stats = poolStats()
          const { rows } = await probe.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_stat_activity
             WHERE application_name = $1 AND state = 'idle in transaction'`,
            [TEST_TARGET.applicationName],
          )
          observed = {
            poolCheckedOut: stats.total - stats.idle,
            idleInTransaction: Number(rows[0]?.n ?? '-1'),
          }
        },
      })

      // The hook must actually have run (proves the assertions below are not
      // silently vacuous), and the login itself must still succeed normally.
      expect(result.outcome, 'the hook must not itself break a valid login').toBe('success')
    } finally {
      await probe.end()
    }

    expect(observed, 'testHooks.beforeWrite must have run').toBeDefined()
    expect(
      observed?.poolCheckedOut,
      'no connection from the shared pool is checked out while decide() has already run and the write has not yet started',
    ).toBe(0)
    expect(
      observed?.idleInTransaction,
      'no finsoft_app backend is sitting idle in transaction at this point',
    ).toBe(0)
  })
})
