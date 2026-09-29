import { randomUUID } from 'node:crypto'
import { withTenant, type TenantTx } from '@finsoft/database'
import {
  migrateTestDatabase,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  customerDirectory,
  createCustomer,
  deactivateCustomer,
  type Actor,
} from '../../../modules/customers/index.ts'
import { createCustomersTenant, type CustomersTenantFixture } from '../helpers/customers-fixture.ts'

/*
 * Accounting seat C2 (ruling R-2, Council review of M3-C @ 74be8a7,
 * 2026-09-29): requireForPayment must never throw CUSTOMER_INACTIVE, unlike
 * requireActiveForPosting — an inactive customer can still be paid, only
 * not invoiced. This exercises the REAL customerDirectory singleton
 * (modules/customers/index.ts) against real ACTIVE and INACTIVE rows in the
 * test database, through the module's published entry point.
 *
 * This does not live under modules/customers/application/ as a
 * *.test.ts: C6's connectionOwnershipSyntax bans forging a TenantTx with
 * `as` anywhere under modules/**, with no test-file exemption (that ban
 * IS the point — a forged handle is exactly what the runtime WeakSet
 * registry in packages/database/src/transaction.ts exists to catch), and
 * @finsoft/database/testing (runAs, the only way to get a real one outside
 * a live HTTP request) is banned there too (TESTING_IMPORT_BAN). Both
 * bans apply unconditionally to every file under modules/**, test or not.
 * tests/integration/** carries neither restriction and is where every
 * other DB-backed customers test already lives.
 */

let tenant: CustomersTenantFixture
let actor: Actor

function withRealTx<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () => withTenant(fn))
}

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
  tenant = await createCustomersTenant('CDR2')
  actor = { userId: tenant.ownerId }
}, 180_000)

afterAll(async () => {
  await teardownTestDatabase()
})

async function makeCustomer(name: string): Promise<string> {
  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, async () => {
    const { customer } = await createCustomer({
      fields: {
        name,
        phone: null,
        email: null,
        address: null,
        city: null,
        ntn: null,
        creditDays: 30,
      },
      idempotencyKey: randomUUID(),
      actor,
    })
    return customer.id
  })
}

async function makeInactiveCustomer(name: string): Promise<string> {
  const id = await makeCustomer(name)
  await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    deactivateCustomer({ id, expectedVersion: 0, actor }),
  )
  return id
}

describe('CustomerDirectory.requireForPayment (R-2) — real repository', () => {
  it('succeeds for an ACTIVE customer', async () => {
    const id = await makeCustomer('R-2 Active Co')
    const ref = await withRealTx((tx) => customerDirectory.requireForPayment(tx, id))
    expect(ref.status).toBe('ACTIVE')
  })

  it('ALSO succeeds for an INACTIVE customer — the whole point of R-2', async () => {
    const id = await makeInactiveCustomer('R-2 Inactive Co')
    const ref = await withRealTx((tx) => customerDirectory.requireForPayment(tx, id))
    expect(ref.status).toBe('INACTIVE')
  })

  it('still throws CUSTOMER_NOT_FOUND for a missing customer', async () => {
    await expect(
      withRealTx((tx) => customerDirectory.requireForPayment(tx, randomUUID())),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' })
  })
})

describe('CustomerDirectory.requireActiveForPosting — unchanged contrast', () => {
  it('still throws CUSTOMER_INACTIVE for an INACTIVE customer (I2/I4/I7 only)', async () => {
    const id = await makeInactiveCustomer('R-2 Contrast Co')
    await expect(
      withRealTx((tx) => customerDirectory.requireActiveForPosting(tx, id)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE' })
  })

  it('still succeeds for an ACTIVE customer', async () => {
    const id = await makeCustomer('R-2 Contrast Active Co')
    const ref = await withRealTx((tx) => customerDirectory.requireActiveForPosting(tx, id))
    expect(ref.status).toBe('ACTIVE')
  })
})
