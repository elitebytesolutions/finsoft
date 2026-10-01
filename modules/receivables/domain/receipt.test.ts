import { describe, expect, it } from 'vitest'
import {
  assertAllocatable,
  assertComplete,
  assertAllocationAmountsShapeValid,
  buildCustomerPaymentPayload,
  previewAllocationProblems,
  suggestAllocations,
  type AllocatableInvoice,
} from './receipt.ts'
import { ReceivablesError } from './errors.ts'

const INV_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const INV_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CUSTOMER = '11111111-1111-1111-1111-111111111111'
const OTHER_CUSTOMER = '22222222-2222-2222-2222-222222222222'

function invoice(overrides: Partial<AllocatableInvoice> = {}): AllocatableInvoice {
  return {
    id: INV_A,
    number: 'INV-2027-000001',
    customerId: CUSTOMER,
    status: 'POSTED',
    invoiceDate: '2026-09-01',
    outstanding: '10000.0000',
    ...overrides,
  }
}

describe('assertComplete (customer-receipt.md §3 rows 1-4)', () => {
  it('rejects a receipt missing method or amount, naming what is missing', () => {
    expect(() => assertComplete({ method: null, amount: null, allocations: [] })).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_INCOMPLETE' }),
    )
  })

  it('rejects a non-positive amount', () => {
    expect(() =>
      assertComplete({ method: 'CASH', amount: '0.0000', allocations: [] }),
    ).toThrowError(expect.objectContaining({ code: 'AMOUNT_NON_POSITIVE' }))
  })

  it('rejects zero allocations', () => {
    expect(() =>
      assertComplete({ method: 'CASH', amount: '100.0000', allocations: [] }),
    ).toThrowError(expect.objectContaining({ code: 'RECEIPT_NO_ALLOCATION' }))
  })

  it('rejects the same invoice allocated twice', () => {
    expect(() =>
      assertComplete({
        method: 'CASH',
        amount: '200.0000',
        allocations: [
          { invoiceId: INV_A, amount: '100.0000' },
          { invoiceId: INV_A, amount: '100.0000' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ALLOCATION_DUPLICATE_INVOICE' }))
  })

  it('rejects an unallocated remainder (Σ allocations must equal amount exactly)', () => {
    expect(() =>
      assertComplete({
        method: 'BANK',
        amount: '6000.0000',
        allocations: [{ invoiceId: INV_A, amount: '5000.0000' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'RECEIPT_UNALLOCATED_AMOUNT' }))
  })

  it('accepts a complete receipt (P05: 6,000.0000)', () => {
    const complete = assertComplete({
      method: 'BANK',
      amount: '6000.0000',
      allocations: [{ invoiceId: INV_A, amount: '6000.0000' }],
    })
    expect(complete.method).toBe('BANK')
    expect(complete.amount).toBe('6000.0000')
  })
})

describe('assertAllocatable (customer-receipt.md §3 rows 5-7 — re-validated at post, under lock)', () => {
  it('rejects an allocation to an invoice not found under the lock', () => {
    expect(() =>
      assertAllocatable(
        CUSTOMER,
        '2026-09-20',
        [{ invoiceId: INV_A, amount: '100.0000' }],
        new Map(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVOICE_NOT_FOUND' }))
  })

  it('rejects an invoice belonging to a different customer', () => {
    const invoices = new Map([[INV_A, invoice({ customerId: OTHER_CUSTOMER })]])
    expect(() =>
      assertAllocatable(
        CUSTOMER,
        '2026-09-20',
        [{ invoiceId: INV_A, amount: '100.0000' }],
        invoices,
      ),
    ).toThrowError(expect.objectContaining({ code: 'ALLOCATION_PARTY_MISMATCH' }))
  })

  it('rejects an invoice that is not POSTED', () => {
    const invoices = new Map([[INV_A, invoice({ status: 'DRAFT' })]])
    expect(() =>
      assertAllocatable(
        CUSTOMER,
        '2026-09-20',
        [{ invoiceId: INV_A, amount: '100.0000' }],
        invoices,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVOICE_NOT_OPEN' }))
  })

  it('rejects a receipt dated before its invoice', () => {
    const invoices = new Map([[INV_A, invoice({ invoiceDate: '2026-09-25' })]])
    expect(() =>
      assertAllocatable(
        CUSTOMER,
        '2026-09-20',
        [{ invoiceId: INV_A, amount: '100.0000' }],
        invoices,
      ),
    ).toThrowError(expect.objectContaining({ code: 'ALLOCATION_INVOICE_AFTER_RECEIPT' }))
  })

  it('rejects an allocation exceeding outstanding, naming the invoice and the figures (a stale proposal)', () => {
    const invoices = new Map([[INV_A, invoice({ outstanding: '4000.0000' })]])
    expect(() =>
      assertAllocatable(
        CUSTOMER,
        '2026-09-20',
        [{ invoiceId: INV_A, amount: '6000.0000' }],
        invoices,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'ALLOCATION_EXCEEDS_OUTSTANDING',
        details: expect.objectContaining({ outstanding: '4000.0000', requested: '6000.0000' }),
      }),
    )
  })

  it('accepts an allocation exactly equal to outstanding (full payment)', () => {
    const invoices = new Map([[INV_A, invoice({ outstanding: '10000.0000' })]])
    expect(() =>
      assertAllocatable(
        CUSTOMER,
        '2026-09-20',
        [{ invoiceId: INV_A, amount: '10000.0000' }],
        invoices,
      ),
    ).not.toThrow()
  })
})

describe('assertAllocationAmountsShapeValid', () => {
  it('rejects a zero or negative allocation amount', () => {
    expect(() =>
      assertAllocationAmountsShapeValid([{ invoiceId: INV_A, amount: '0.0000' }]),
    ).toThrowError(expect.objectContaining({ code: 'AMOUNT_NON_POSITIVE' }))
  })
  it('rejects a duplicate invoice id across proposals', () => {
    expect(() =>
      assertAllocationAmountsShapeValid([
        { invoiceId: INV_A, amount: '1.0000' },
        { invoiceId: INV_A, amount: '2.0000' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'ALLOCATION_DUPLICATE_INVOICE' }))
  })
})

describe('previewAllocationProblems (R2 — advisory, never throws)', () => {
  it('collects a stale-proposal rejection as a problem instead of throwing', () => {
    const invoices = new Map([[INV_A, invoice({ outstanding: '1000.0000' })]])
    const problems = previewAllocationProblems(
      CUSTOMER,
      '2026-09-20',
      [{ invoiceId: INV_A, amount: '4000.0000' }],
      invoices,
    )
    expect(problems).toEqual([
      expect.objectContaining({ code: 'ALLOCATION_EXCEEDS_OUTSTANDING', invoiceId: INV_A }),
    ])
  })
})

describe('suggestAllocations (oldest-first — a suggestion, never applied implicitly)', () => {
  it('fills invoices oldest first, up to each outstanding, until the amount is used up', () => {
    const invoices = [
      invoice({ id: INV_A, number: 'INV-A', invoiceDate: '2026-09-01', outstanding: '3000.0000' }),
      invoice({ id: INV_B, number: 'INV-B', invoiceDate: '2026-09-10', outstanding: '5000.0000' }),
    ]
    const result = suggestAllocations(invoices, '6000.0000')
    expect(result.allocations).toEqual([
      { invoiceId: INV_A, amount: '3000.0000' },
      { invoiceId: INV_B, amount: '3000.0000' },
    ])
    expect(result.unallocated).toBe('0.0000')
  })

  it('leaves a remainder unallocated when the amount exceeds total outstanding', () => {
    const invoices = [invoice({ id: INV_A, outstanding: '1000.0000' })]
    const result = suggestAllocations(invoices, '2500.0000')
    expect(result.allocations).toEqual([{ invoiceId: INV_A, amount: '1000.0000' }])
    expect(result.unallocated).toBe('1500.0000')
  })
})

describe('buildCustomerPaymentPayload (customer-receipt.md §2, §4 — exactly two GL lines whatever the allocation count)', () => {
  it('builds the payload with every allocation, still one amount', () => {
    const complete = assertComplete({
      method: 'CASH',
      amount: '10000.0000',
      allocations: [
        { invoiceId: INV_A, amount: '4000.0000' },
        { invoiceId: INV_B, amount: '6000.0000' },
      ],
    })
    const payload = buildCustomerPaymentPayload(CUSTOMER, complete)
    expect(payload).toEqual({
      customerId: CUSTOMER,
      method: 'CASH',
      amount: '10000.0000',
      allocations: [
        { invoiceId: INV_A, amount: '4000.0000' },
        { invoiceId: INV_B, amount: '6000.0000' },
      ],
    })
  })
})

describe('every rejection is a ReceivablesError', () => {
  it('is true for assertComplete', () => {
    try {
      assertComplete({ method: null, amount: null, allocations: [] })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ReceivablesError)
    }
  })
})
