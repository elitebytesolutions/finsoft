import { withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  scalarOn,
  sqlstate,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * Tenant isolation under CONCURRENCY.
 *
 * tenant-isolation.spec.ts proves the policy holds for one request at a time.
 * This proves it holds when requests overlap, which is a different claim and
 * the one that matters in production.
 *
 * The specific failure it is built to catch: `app.tenant_id` is set with
 * `set_config(..., true)` — LOCAL to the transaction. If it were ever set
 * without that flag, or if a pooled connection were reused without the
 * setting being reset, tenant A's context would leak into tenant B's request.
 * That failure is invisible in a serial test, because there is never a second
 * context to leak into.
 *
 * `DATABASE_POOL_MAX` is 1 in the harness, which makes this SHARPER rather
 * than weaker: every interleaved request is forced through the same physical
 * connection, so a context that outlives its transaction has nowhere to hide.
 */

let alpha: TenantFixture
let beta: TenantFixture

beforeAll(async () => {
  await prepareTestDatabase()
  alpha = await createTenantFixture('CONA')
  beta = await createTenantFixture('CONB')
}, 60_000)

afterAll(teardownTestDatabase)

/** Count the users this tenant's context can see. */
const visibleUsers = (t: TenantFixture): Promise<number> =>
  runAs({ tenantId: t.tenantId, userId: null }, () =>
    withTenant(async (tx) =>
      Number(await scalarOn<string>(tx, 'SELECT count(*)::text FROM users')),
    ),
  )

/** What tenant id does the database itself believe this transaction carries? */
const observedTenant = (t: TenantFixture): Promise<string | undefined> =>
  runAs({ tenantId: t.tenantId, userId: null }, () =>
    withTenant((tx) => scalarOn<string>(tx, "SELECT current_setting('app.tenant_id', true)")),
  )

describe('interleaved reads stay in their own tenant', () => {
  it('never observes another tenant rows, over many overlapping requests', async () => {
    /*
     * Interleaved deliberately — alpha, beta, alpha, beta — rather than run
     * as two separate batches. A batch of A followed by a batch of B can pass
     * while a leak exists, because the context happens to be correct for the
     * whole of each batch.
     */
    const work = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? visibleUsers(alpha) : visibleUsers(beta),
    )

    const counts = await Promise.all(work)

    // Each tenant has exactly its provisioned owner and nothing else.
    for (const [i, count] of counts.entries()) {
      expect(count, `request ${i} saw ${count} users; each tenant has exactly 1`).toBe(1)
    }
  })

  it('reports its own tenant id in every concurrent transaction', async () => {
    const observed = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        i % 2 === 0
          ? observedTenant(alpha).then((v) => ['alpha', v] as const)
          : observedTenant(beta).then((v) => ['beta', v] as const),
      ),
    )

    for (const [who, value] of observed) {
      const expected = who === 'alpha' ? alpha.tenantId : beta.tenantId
      expect(value, `${who} observed ${value}`).toBe(expected)
    }
  })
})

describe('interleaved writes cannot cross tenants', () => {
  it('rejects a write stamped with another tenant id, under concurrency', async () => {
    /*
     * The adversarial case: tenant alpha's context, deliberately inserting a
     * row that claims to belong to beta. The policy's WITH CHECK has to
     * refuse it — and has to keep refusing it while beta is doing legitimate
     * work on the same pooled connection.
     */
    const attempts = Array.from({ length: 10 }, () =>
      runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
        withTenant((tx) =>
          tx
            .insertInto('users')
            .values({
              tenant_id: beta.tenantId, // ← another tenant's id
              email: `cross.${unique().toLowerCase()}@example.test`,
              full_name: 'Cross tenant write',
              status: 'INVITED',
              created_by: alpha.ownerId,
              updated_by: alpha.ownerId,
            })
            .execute(),
        ),
      ).then(
        () => 'ACCEPTED' as const,
        (error: unknown) => sqlstate(error) ?? 'REJECTED',
      ),
    )

    // Legitimate traffic from beta, running at the same time.
    const legitimate = Array.from({ length: 10 }, () => visibleUsers(beta))

    const [outcomes, counts] = await Promise.all([Promise.all(attempts), Promise.all(legitimate)])

    for (const outcome of outcomes) {
      expect(outcome, 'a cross-tenant insert must never be accepted').not.toBe('ACCEPTED')
    }

    // And beta never saw a row that alpha tried to plant in it.
    for (const count of counts) {
      expect(count, 'beta must still see only its own single user').toBe(1)
    }

    expect(await visibleUsers(beta)).toBe(1)
  })

  it('leaves no trace of the rejected writes afterwards', async () => {
    expect(await visibleUsers(alpha)).toBe(1)
    expect(await visibleUsers(beta)).toBe(1)
  })
})
