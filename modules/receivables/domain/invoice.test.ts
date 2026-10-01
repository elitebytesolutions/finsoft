import { describe, expect, it } from 'vitest'
import {
  buildSalePostedPayload,
  computeInvoiceLines,
  deriveSettlement,
  previewInvoiceLines,
} from './invoice.ts'
import { ReceivablesError } from './errors.ts'

describe('computeInvoiceLines (service-sale.md §4, §6)', () => {
  it('rounds each line half-up to 4dp and sums unrounded (P04: 10,000.0000)', () => {
    const result = computeInvoiceLines(
      [
        { description: 'Monthly maintenance', quantity: '1.000000', unitPrice: '7500.000000' },
        { description: 'Site visit', quantity: '3.000000', unitPrice: '833.333333' },
      ],
      { requireAtLeastOne: true },
    )
    expect(result.lines[0]?.lineNet).toBe('7500.0000')
    expect(result.lines[1]?.lineNet).toBe('2500.0000') // 3 * 833.333333 = 2499.999999 -> 2500.0000
    expect(result.netAmount).toBe('10000.0000')
  })

  it('pins a true half-way tie at the line boundary (P10)', () => {
    const result = computeInvoiceLines(
      [{ description: 'Half-way tie', quantity: '2.500000', unitPrice: '1234.567700' }],
      { requireAtLeastOne: true },
    )
    // 2.5 * 1234.5677 = 3086.41925 -> half-up rounds to 3086.4193, never
    // 3086.4192 (half-even/truncation).
    expect(result.lines[0]?.lineNet).toBe('3086.4193')
  })

  it('rejects a zero-line invoice when at least one is required', () => {
    expect(() => computeInvoiceLines([], { requireAtLeastOne: true })).toThrowError(
      expect.objectContaining({ code: 'SALE_NO_LINES' }),
    )
  })

  it('allows a zero-line draft when a draft is being saved', () => {
    const result = computeInvoiceLines([], { requireAtLeastOne: false })
    expect(result.lines).toEqual([])
    expect(result.netAmount).toBe('0.0000')
  })

  it('rejects more than 200 lines', () => {
    const lines = Array.from({ length: 201 }, (_, i) => ({
      description: `Line ${i + 1}`,
      quantity: '1.000000',
      unitPrice: '1.000000',
    }))
    expect(() => computeInvoiceLines(lines, { requireAtLeastOne: true })).toThrowError(
      expect.objectContaining({ code: 'SALE_TOO_MANY_LINES' }),
    )
  })

  it('rejects a zero or negative quantity', () => {
    expect(() =>
      computeInvoiceLines([{ description: 'Bad', quantity: '0.000000', unitPrice: '1.000000' }], {
        requireAtLeastOne: true,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'SALE_LINE_NON_POSITIVE', details: { lineNo: 1 } }),
    )

    expect(() =>
      computeInvoiceLines([{ description: 'Bad', quantity: '-1.000000', unitPrice: '1.000000' }], {
        requireAtLeastOne: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SALE_LINE_NON_POSITIVE' }))
  })

  it('rejects a zero or negative unit price', () => {
    expect(() =>
      computeInvoiceLines([{ description: 'Bad', quantity: '1.000000', unitPrice: '0.000000' }], {
        requireAtLeastOne: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SALE_LINE_NON_POSITIVE' }))
  })

  it('rejects a malformed amount string, never coercing a JSON number', () => {
    expect(() =>
      computeInvoiceLines([{ description: 'Bad', quantity: '1.0000001', unitPrice: '1.000000' }], {
        requireAtLeastOne: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'AMOUNT_SCALE' }))
  })

  it('rejects an empty description', () => {
    expect(() =>
      computeInvoiceLines([{ description: '   ', quantity: '1.000000', unitPrice: '1.000000' }], {
        requireAtLeastOne: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
  })

  it('is a ReceivablesError instance on every rejection', () => {
    try {
      computeInvoiceLines([], { requireAtLeastOne: true })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ReceivablesError)
    }
  })
})

describe('previewInvoiceLines (I6 — never throws, collects problems)', () => {
  it('flags a non-positive line as a problem without throwing', () => {
    const result = previewInvoiceLines([
      { description: 'Bad', quantity: '0.000000', unitPrice: '5.000000' },
    ])
    expect(result.problems).toEqual([{ code: 'SALE_LINE_NON_POSITIVE', lineNo: 1 }])
    expect(result.lines[0]?.lineNet).toBe('0.0000')
  })

  it('flags more than 200 lines as a problem, without truncating the list', () => {
    const lines = Array.from({ length: 201 }, () => ({
      description: 'x',
      quantity: '1.000000',
      unitPrice: '1.000000',
    }))
    const result = previewInvoiceLines(lines)
    expect(result.problems).toContainEqual({ code: 'SALE_TOO_MANY_LINES', lineNo: null })
    expect(result.lines).toHaveLength(201)
  })
})

describe('buildSalePostedPayload (service-sale.md §3)', () => {
  it('builds the exact payload shape the kernel verifies', () => {
    const calc = computeInvoiceLines(
      [{ description: 'A', quantity: '1.000000', unitPrice: '100.000000' }],
      { requireAtLeastOne: true },
    )
    const payload = buildSalePostedPayload('11111111-1111-1111-1111-111111111111', calc)
    expect(payload).toEqual({
      settlement: 'CREDIT',
      customerId: '11111111-1111-1111-1111-111111111111',
      lines: [
        {
          kind: 'SERVICE',
          description: 'A',
          quantity: '1.000000',
          unitPrice: '100.000000',
          lineNet: '100.0000',
        },
      ],
      netAmount: '100.0000',
    })
  })
})

describe('deriveSettlement (modules.md §5 — derived, never stored)', () => {
  it('is OPEN when outstanding equals net, PAID at zero, else PARTIALLY_PAID', () => {
    expect(deriveSettlement('10000.0000', '10000.0000')).toBe('OPEN')
    expect(deriveSettlement('10000.0000', '0.0000')).toBe('PAID')
    expect(deriveSettlement('10000.0000', '4000.0000')).toBe('PARTIALLY_PAID')
  })
})
