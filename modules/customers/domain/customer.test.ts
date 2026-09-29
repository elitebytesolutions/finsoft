import { describe, expect, it } from 'vitest'
import {
  Customer,
  LEDGER_MAX_DAYS,
  assertLedgerRange,
  normalizeCustomerFields,
  normalizeCustomerPatch,
  type CustomerRow,
} from './customer.ts'
import { CustomerError } from './errors.ts'

/*
 * Domain unit tests — no database (ADR-0028 statement 10). Every rejection
 * case is exercised, per CLAUDE.md's DoD ("domain invariants, including
 * every rejection case").
 */

const VALID_FIELDS = {
  name: 'Acme Traders',
  phone: '0300-1234567',
  email: 'ap@acme.test',
  address: '12 Mall Road',
  city: 'Lahore',
  ntn: '1234567-8',
  creditDays: 30,
}

function row(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    code: 'CUST-000001',
    fields: VALID_FIELDS,
    status: 'ACTIVE',
    version: 0,
    createdAt: '2026-09-29T00:00:00.000000Z',
    createdBy: '22222222-2222-2222-2222-222222222222',
    updatedAt: '2026-09-29T00:00:00.000000Z',
    updatedBy: '22222222-2222-2222-2222-222222222222',
    ...overrides,
  }
}

describe('normalizeCustomerFields', () => {
  it('trims and accepts a valid field set', () => {
    const result = normalizeCustomerFields({ ...VALID_FIELDS, name: '  Acme Traders  ' })
    expect(result.name).toBe('Acme Traders')
  })

  it('accepts every optional field as null', () => {
    const result = normalizeCustomerFields({
      name: 'Bare Customer',
      phone: null,
      email: null,
      address: null,
      city: null,
      ntn: null,
      creditDays: 0,
    })
    expect(result).toEqual({
      name: 'Bare Customer',
      phone: null,
      email: null,
      address: null,
      city: null,
      ntn: null,
      creditDays: 0,
    })
  })

  it('treats a blank optional string as null after trimming', () => {
    const result = normalizeCustomerFields({ ...VALID_FIELDS, phone: '   ' })
    expect(result.phone).toBeNull()
  })

  it('rejects an empty name (VALIDATION_FAILED)', () => {
    expect(() => normalizeCustomerFields({ ...VALID_FIELDS, name: '   ' })).toThrow(CustomerError)
    try {
      normalizeCustomerFields({ ...VALID_FIELDS, name: '' })
    } catch (error) {
      expect(error).toBeInstanceOf(CustomerError)
      expect((error as CustomerError).code).toBe('VALIDATION_FAILED')
      expect((error as CustomerError).details['path']).toBe('name')
    }
  })

  it('rejects a name over 200 characters', () => {
    expect(() => normalizeCustomerFields({ ...VALID_FIELDS, name: 'x'.repeat(201) })).toThrow(
      CustomerError,
    )
  })

  it('rejects a phone over 50 characters', () => {
    expect(() => normalizeCustomerFields({ ...VALID_FIELDS, phone: '1'.repeat(51) })).toThrow(
      CustomerError,
    )
  })

  it('rejects an address over 500 characters', () => {
    expect(() => normalizeCustomerFields({ ...VALID_FIELDS, address: 'x'.repeat(501) })).toThrow(
      CustomerError,
    )
  })

  it('rejects a city over 100 characters', () => {
    expect(() => normalizeCustomerFields({ ...VALID_FIELDS, city: 'x'.repeat(101) })).toThrow(
      CustomerError,
    )
  })

  it.each(['not-an-ntn', '123456', '12345678901', 'abcdefg-1'])(
    'rejects a malformed ntn: %s',
    (bad) => {
      expect(() => normalizeCustomerFields({ ...VALID_FIELDS, ntn: bad })).toThrow(CustomerError)
    },
  )

  it.each(['1234567', '1234567-8'])('accepts a well-formed ntn: %s', (good) => {
    const result = normalizeCustomerFields({ ...VALID_FIELDS, ntn: good })
    expect(result.ntn).toBe(good)
  })

  it.each([-1, 366, 1.5, Number.NaN])(
    'rejects an out-of-range or non-integer creditDays: %s',
    (bad) => {
      expect(() => normalizeCustomerFields({ ...VALID_FIELDS, creditDays: bad })).toThrow(
        CustomerError,
      )
    },
  )

  it.each([0, 365])('accepts the boundary creditDays values: %s', (good) => {
    const result = normalizeCustomerFields({ ...VALID_FIELDS, creditDays: good })
    expect(result.creditDays).toBe(good)
  })
})

describe('normalizeCustomerPatch', () => {
  it('returns an empty object when nothing is present', () => {
    expect(normalizeCustomerPatch({})).toEqual({})
  })

  it('normalises only the keys that are present', () => {
    const patch = normalizeCustomerPatch({ city: '  Karachi  ' })
    expect(patch).toEqual({ city: 'Karachi' })
  })

  it('still validates a present field (rejects an empty name)', () => {
    expect(() => normalizeCustomerPatch({ name: '   ' })).toThrow(CustomerError)
  })

  it('allows explicitly clearing an optional field to null', () => {
    const patch = normalizeCustomerPatch({ phone: null })
    expect(patch).toEqual({ phone: null })
  })
})

describe('Customer.assertVersion', () => {
  it('passes when the version matches', () => {
    const customer = Customer.fromRow(row({ version: 3 }))
    expect(() => customer.assertVersion(3)).not.toThrow()
  })

  it('throws VERSION_CONFLICT with the current version in details when it does not', () => {
    const customer = Customer.fromRow(row({ version: 3 }))
    try {
      customer.assertVersion(2)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(CustomerError)
      expect((error as CustomerError).code).toBe('VERSION_CONFLICT')
      expect((error as CustomerError).details['currentVersion']).toBe(3)
    }
  })
})

describe('Customer.assertDeactivatable', () => {
  it('allows deactivating an ACTIVE customer with a zero balance', () => {
    const customer = Customer.fromRow(row({ status: 'ACTIVE' }))
    expect(customer.assertDeactivatable({ isZero: true })).toEqual({ alreadyInactive: false })
  })

  it('refuses deactivating an ACTIVE customer with a non-zero balance (CUSTOMER_HAS_BALANCE)', () => {
    const customer = Customer.fromRow(row({ status: 'ACTIVE' }))
    try {
      customer.assertDeactivatable({ isZero: false })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(CustomerError)
      expect((error as CustomerError).code).toBe('CUSTOMER_HAS_BALANCE')
    }
  })

  it('is a no-op success for an already-INACTIVE customer, regardless of balance', () => {
    const customer = Customer.fromRow(row({ status: 'INACTIVE' }))
    expect(customer.assertDeactivatable({ isZero: false })).toEqual({ alreadyInactive: true })
  })
})

describe('Customer.assertReactivatable', () => {
  it('allows reactivating an INACTIVE customer', () => {
    const customer = Customer.fromRow(row({ status: 'INACTIVE' }))
    expect(customer.assertReactivatable()).toEqual({ alreadyActive: false })
  })

  it('is a no-op success for an already-ACTIVE customer', () => {
    const customer = Customer.fromRow(row({ status: 'ACTIVE' }))
    expect(customer.assertReactivatable()).toEqual({ alreadyActive: true })
  })
})

describe('Customer.assertActiveForPosting', () => {
  it('passes for an ACTIVE customer', () => {
    const customer = Customer.fromRow(row({ status: 'ACTIVE' }))
    expect(() => customer.assertActiveForPosting()).not.toThrow()
  })

  it('throws CUSTOMER_INACTIVE for an INACTIVE customer', () => {
    const customer = Customer.fromRow(row({ status: 'INACTIVE' }))
    try {
      customer.assertActiveForPosting()
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(CustomerError)
      expect((error as CustomerError).code).toBe('CUSTOMER_INACTIVE')
    }
  })
})

describe('assertLedgerRange', () => {
  it(`allows exactly ${LEDGER_MAX_DAYS} days`, () => {
    expect(() => assertLedgerRange('2026-01-01', '2026-12-31')).not.toThrow()
  })

  it(`rejects ${LEDGER_MAX_DAYS + 1} days`, () => {
    try {
      // 2026-01-01..2027-01-01 inclusive is exactly 366 days (2026 has 365
      // days) — the allowed boundary. One day past it is 2027-01-02.
      assertLedgerRange('2026-01-01', '2027-01-02')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(CustomerError)
      expect((error as CustomerError).code).toBe('LEDGER_RANGE_TOO_LARGE')
      expect((error as CustomerError).details['maxDays']).toBe(LEDGER_MAX_DAYS)
    }
  })

  it('allows a single day', () => {
    expect(() => assertLedgerRange('2026-06-15', '2026-06-15')).not.toThrow()
  })
})

describe('Customer is immutable', () => {
  it('freezes the constructed instance', () => {
    const customer = Customer.fromRow(row())
    expect(Object.isFrozen(customer)).toBe(true)
  })
})
