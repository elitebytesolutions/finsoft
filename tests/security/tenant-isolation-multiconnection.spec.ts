import { closeDatabase, openDatabase, withTenant } from '@finsoft/database'
import {
  TEST_TARGET,
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  scalarOn,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * Tenant isolation across SEPARATE CONNECTIONS, with transactions genuinely
 * open at the same time.
 *
 * This exists because of a precise limit in the sibling suite. The harness
 * pins DATABASE_POOL_MAX to 1, so `tenant-isolation-concurrent.spec.ts`
 * interleaves requests that are serialised onto one physical connection. That
 * is a strong test of one thing — a context leaking between SEQUENTIAL users
 * of a connection — and it is silent about another: two tenants whose
 * transactions are open simultaneously on different backends.
 *
 * The two failures are different. Sequential leakage comes from a setting
 * that outlives its transaction. Concurrent leakage would come from a policy
 * evaluated against something shared between backends, or from a setting
 * stored somewhere per-database rather than per-session. Only overlapping
 * transactions can show the second.
 *
 * So the pool is deliberately reopened wider here, and a barrier holds both
 * transactions open until each has seen the other exist.
 */

let alpha: TenantFixture
let beta: TenantFixture

beforeAll(async () => {
  await prepareTestDatabase()
  alpha = await createTenantFixture('MCA')
  beta = await createTenantFixture('MCB')

  /*
   * prepareTestDatabase sets DATABASE_POOL_MAX=1 on purpose. Reopen with room
   * for several backends, which is the whole point of this file — and closer
   * to production, where the pool is sized for real traffic.
   */
  await closeDatabase()
  process.env['DATABASE_POOL_MAX'] = '6'
  await openDatabase(TEST_TARGET)
}, 60_000)

afterAll(async () => {
  await closeDatabase()
  process.env['DATABASE_POOL_MAX'] = '1'
  await teardownTestDatabase()
})

/** A two-party rendezvous: neither side proceeds until both have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0
  let release: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return async () => {
    arrived += 1
    if (arrived >= parties) release()
    await gate
  }
}

describe('two tenants with transactions open at the same time', () => {
  it('each sees only its own rows, on different backends', async () => {
    const meet = barrier(2)

    const observe = (t: TenantFixture) =>
      runAs({ tenantId: t.tenantId, userId: null }, () =>
        withTenant(async (tx) => {
          const backend = await scalarOn<number>(tx, 'SELECT pg_backend_pid()')

          // Hold the transaction open until the other one is also open.
          await meet()

          const visible = Number(await scalarOn<string>(tx, 'SELECT count(*)::text FROM users'))
          const context = await scalarOn<string>(
            tx,
            "SELECT current_setting('app.tenant_id', true)",
          )

          return { backend, visible, context }
        }),
      )

    const [a, b] = await Promise.all([observe(alpha), observe(beta)])

    /*
     * The precondition. If both ran on one backend the barrier would have
     * deadlocked rather than reaching here, but asserting it makes the test
     * state its own assumption instead of relying on a timeout to enforce it.
     */
    expect(a.backend, 'the two transactions must be on different backends').not.toBe(b.backend)

    expect(a.context).toBe(alpha.tenantId)
    expect(b.context).toBe(beta.tenantId)

    expect(a.visible, 'alpha saw rows that are not its own').toBe(1)
    expect(b.visible, 'beta saw rows that are not its own').toBe(1)
  })

  it('a write by one is invisible to the other while both are open', async () => {
    const meet = barrier(2)

    /*
     * alpha inserts and holds the transaction open. beta, on its own backend,
     * counts. The isolation claim is not merely "beta cannot see uncommitted
     * work" — that is ordinary MVCC — but that beta never sees it at all,
     * because the row belongs to another tenant.
     */
    const writer = runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant(async (tx) => {
        await tx
          .insertInto('users')
          .values({
            tenant_id: alpha.tenantId,
            email: `mc.${unique().toLowerCase()}@example.test`,
            full_name: 'Concurrent writer',
            status: 'INVITED',
            created_by: alpha.ownerId,
            updated_by: alpha.ownerId,
          })
          .execute()

        await meet()
        return Number(await scalarOn<string>(tx, 'SELECT count(*)::text FROM users'))
      }),
    )

    const reader = runAs({ tenantId: beta.tenantId, userId: null }, () =>
      withTenant(async (tx) => {
        await meet()
        return Number(await scalarOn<string>(tx, 'SELECT count(*)::text FROM users'))
      }),
    )

    const [writerSaw, readerSaw] = await Promise.all([writer, reader])

    expect(writerSaw, 'alpha should see its own uncommitted insert').toBe(2)
    expect(readerSaw, 'beta must never see a row belonging to alpha').toBe(1)
  })

  it('holds under many overlapping transactions at once', async () => {
    /*
     * Its own tenants, not alpha and beta.
     *
     * The preceding test COMMITS an insert into alpha, so by the time this
     * runs alpha legitimately has two users — and an earlier version of this
     * test asserted a hard-coded 1 and failed, looking exactly like an
     * isolation breach. A test whose expected value depends on which tests
     * ran before it reports the wrong thing when it breaks.
     */
    const [one, two] = await Promise.all([createTenantFixture('MCC'), createTenantFixture('MCD')])

    const parties = 6
    const meet = barrier(parties)

    const work = Array.from({ length: parties }, (_, i) => {
      const t = i % 2 === 0 ? one : two
      return runAs({ tenantId: t.tenantId, userId: null }, () =>
        withTenant(async (tx) => {
          await meet()
          const context = await scalarOn<string>(
            tx,
            "SELECT current_setting('app.tenant_id', true)",
          )
          const visible = Number(await scalarOn<string>(tx, 'SELECT count(*)::text FROM users'))
          return { expected: t.tenantId, context, visible }
        }),
      )
    })

    for (const result of await Promise.all(work)) {
      expect(result.context).toBe(result.expected)
      expect(result.visible).toBe(1)
    }
  })
})
