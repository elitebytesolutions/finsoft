import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextError } from '@finsoft/database'
import {
  migrateTestDatabase,
  prepareTestDatabase,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import {
  createCustomer,
  deactivateCustomer,
  getCustomer,
  getCustomerLedger,
  listCustomers,
  reactivateCustomer,
  updateCustomer,
} from '../../../modules/customers/index.ts'

/*
 * S5 (ADR-0028): "a use case run outside a tenant context fails" — every
 * modules/customers use case opens its own `withTenant`, which reads
 * `TenantContext.require()` internally (packages/database). Called with no
 * ambient tenant context (no TenantGuard, no runAs fixture wrapper), that
 * throws BEFORE any repository method runs — so a caller cannot reach
 * `assertIssuedTenantTx`'s check with a forged handle either, because there
 * is no handle to forge until a real `withTenant` call succeeds. This file
 * proves the first, structural half of S5 for every one of this module's
 * exported use cases. The second half of S5 ("a cross-tenant id returns the
 * same 404 as a missing one, on every customer route") is proven per route
 * in customers-api.spec.ts.
 */

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
}, 60_000)

afterAll(teardownTestDatabase)

describe('every modules/customers use case fails closed with no TenantContext (S5)', () => {
  it('createCustomer', async () => {
    await expect(
      createCustomer({
        fields: {
          name: 'No Context',
          phone: null,
          email: null,
          address: null,
          city: null,
          ntn: null,
          creditDays: 0,
        },
        idempotencyKey: 'no-context-create',
        actor: { userId: '00000000-0000-0000-0000-000000000000' },
      }),
    ).rejects.toBeInstanceOf(TenantContextError)
  })

  it('updateCustomer', async () => {
    await expect(
      updateCustomer({
        id: '00000000-0000-0000-0000-000000000000',
        patch: { name: 'X' },
        expectedVersion: 0,
        actor: { userId: '00000000-0000-0000-0000-000000000000' },
      }),
    ).rejects.toBeInstanceOf(TenantContextError)
  })

  it('deactivateCustomer', async () => {
    await expect(
      deactivateCustomer({
        id: '00000000-0000-0000-0000-000000000000',
        expectedVersion: 0,
        actor: { userId: '00000000-0000-0000-0000-000000000000' },
      }),
    ).rejects.toBeInstanceOf(TenantContextError)
  })

  it('reactivateCustomer', async () => {
    await expect(
      reactivateCustomer({
        id: '00000000-0000-0000-0000-000000000000',
        expectedVersion: 0,
        actor: { userId: '00000000-0000-0000-0000-000000000000' },
      }),
    ).rejects.toBeInstanceOf(TenantContextError)
  })

  it('getCustomer', async () => {
    await expect(getCustomer('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      TenantContextError,
    )
  })

  it('listCustomers', async () => {
    await expect(
      listCustomers({ q: null, status: null, limit: 50, cursor: null }),
    ).rejects.toBeInstanceOf(TenantContextError)
  })

  it('getCustomerLedger', async () => {
    await expect(
      getCustomerLedger({
        id: '00000000-0000-0000-0000-000000000000',
        from: null,
        to: null,
      }),
    ).rejects.toBeInstanceOf(TenantContextError)
  })
})
