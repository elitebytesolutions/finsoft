import { describe, expect, it } from 'vitest'
import type { TenantTx } from '@finsoft/database'
import { Customer, type CustomerRow } from '../domain/customer.ts'
import { createCustomerDirectory } from './customer-directory.ts'
import { CustomerDirectoryError } from './published.ts'
import type { CustomersRepository } from './ports.ts'

/*
 * Accounting seat C2 (R-2, Council review, 2026-09-29): requireForPayment
 * must never throw CUSTOMER_INACTIVE, unlike requireActiveForPosting. A
 * fake repository (no database — the interface takes a TenantTx only as a
 * pass-through value here, never used) is enough to prove the branching,
 * without needing modules/receivables (M3-P) to exist to exercise it.
 */

const FAKE_TX = {} as TenantTx

function row(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'c1',
    code: 'CUST-000001',
    fields: {
      name: 'Test Customer',
      phone: null,
      email: null,
      address: null,
      city: null,
      ntn: null,
      creditDays: 30,
    },
    status: 'ACTIVE',
    version: 0,
    createdAt: '2026-09-29T00:00:00.000000Z',
    createdBy: 'u1',
    updatedAt: '2026-09-29T00:00:00.000000Z',
    updatedBy: 'u1',
    ...overrides,
  }
}

function fakeRepo(customer: Customer | null): CustomersRepository {
  return {
    findByCreateIdempotencyKey: async () => null,
    insert: async () => {
      throw new Error('not used')
    },
    findById: async () => customer,
    lockForUpdate: async () => customer,
    lockForShare: async () => customer,
    update: async () => {
      throw new Error('not used')
    },
    list: async () => ({ items: [], next: null }),
    findByIds: async () => new Map(),
    currentBalance: async () => ({ balance: '0.0000', asOf: '2026-09-29' }),
    hasAnyBalance: async () => false,
    ledger: async () => ({ openingBalance: '0.0000', closingBalance: '0.0000', lines: [] }),
  }
}

describe('CustomerDirectory.requireForPayment (R-2)', () => {
  it('succeeds for an ACTIVE customer', async () => {
    const directory = createCustomerDirectory(fakeRepo(Customer.fromRow(row({ status: 'ACTIVE' }))))
    const ref = await directory.requireForPayment(FAKE_TX, 'c1')
    expect(ref.status).toBe('ACTIVE')
  })

  it('ALSO succeeds for an INACTIVE customer — the whole point of R-2', async () => {
    const directory = createCustomerDirectory(
      fakeRepo(Customer.fromRow(row({ status: 'INACTIVE' }))),
    )
    const ref = await directory.requireForPayment(FAKE_TX, 'c1')
    expect(ref.status).toBe('INACTIVE')
  })

  it('still throws CUSTOMER_NOT_FOUND for a missing customer', async () => {
    const directory = createCustomerDirectory(fakeRepo(null))
    await expect(directory.requireForPayment(FAKE_TX, 'missing')).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_FOUND',
    })
    await expect(directory.requireForPayment(FAKE_TX, 'missing')).rejects.toBeInstanceOf(
      CustomerDirectoryError,
    )
  })
})

describe('CustomerDirectory.requireActiveForPosting — unchanged contrast', () => {
  it('still throws CUSTOMER_INACTIVE for an INACTIVE customer (I2/I4/I7 only)', async () => {
    const directory = createCustomerDirectory(
      fakeRepo(Customer.fromRow(row({ status: 'INACTIVE' }))),
    )
    await expect(directory.requireActiveForPosting(FAKE_TX, 'c1')).rejects.toMatchObject({
      code: 'CUSTOMER_INACTIVE',
    })
  })
})
