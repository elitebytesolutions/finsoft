import { describe, expect, it } from 'vitest'
import { Decimal } from 'decimal.js'
import { FinDecimal, Rounding } from './decimal.ts'
import { AmountError, Money, Percentage, Quantity, UnitCost } from './money.ts'

/*
 * These tests are the Compliance section of ADR-0014, executed.
 * Where a test exists because a specific failure was found during review,
 * the comment says which one.
 */

describe('the configured constructor (ADR-0014)', () => {
  it('reports the frozen configuration', () => {
    expect(FinDecimal.precision).toBe(50)
    expect(FinDecimal.rounding).toBe(Decimal.ROUND_HALF_UP)
    expect(FinDecimal.modulo).toBe(Decimal.ROUND_DOWN)
    expect(FinDecimal.toExpNeg).toBe(-9e15)
    expect(FinDecimal.toExpPos).toBe(9e15)
  })

  it('cannot be reconfigured', () => {
    // A clone is mutable by default: M.set({rounding: ROUND_DOWN}) silently
    // repoints it and 2.5 then rounds to 2. Object.freeze makes that throw.
    //
    // The disable is the point of the test: this is the one file allowed to
    // attempt the call, because it is the file that proves the call fails.
    // eslint-disable-next-line no-restricted-syntax -- asserts ADR-0014's freeze holds
    expect(() => FinDecimal.set({ rounding: Decimal.ROUND_DOWN })).toThrow(TypeError)
    expect(new FinDecimal('2.5').toDecimalPlaces(0).toString()).toBe('3')
  })

  it('is isolated from the global Decimal', () => {
    // Deliberately corrupts the global constructor to prove the clone does
    // not follow it. Restored in `finally` so no other test inherits it.
    // eslint-disable-next-line no-restricted-syntax -- asserts clone isolation
    Decimal.set({ rounding: Decimal.ROUND_DOWN })
    try {
      expect(new FinDecimal('2.5').toDecimalPlaces(0).toString()).toBe('3')
    } finally {
      // eslint-disable-next-line no-restricted-syntax -- restores global state
      Decimal.set({ rounding: Decimal.ROUND_HALF_UP })
    }
  })

  it('truncates modulo, matching PostgreSQL % and JavaScript %', () => {
    // ROUND_HALF_UP modulo yields 11 mod 3 = -1: a negative remainder from
    // positive operands. Allocation residuals would be wrong-signed for
    // roughly half of all inputs, intermittently.
    expect(new FinDecimal(11).mod(3).toString()).toBe('2')
    expect(new FinDecimal(5).mod(3).toString()).toBe('2')
    expect(new FinDecimal(10).mod(3).toString()).toBe('1')
    expect(new FinDecimal(11).mod(3).toNumber()).toBe(11 % 3)
  })

  it('keeps 38-39 significant digits exact at the numeric(19,6) ceiling', () => {
    const ceiling = '9999999999999.999999'
    const squared = new FinDecimal(ceiling).times(ceiling)
    expect(squared.toFixed(12)).toBe('99999999999999999980000000.000000000001')
  })

  it('never emits exponential notation', () => {
    expect(new FinDecimal('0.000001').toString()).toBe('0.000001')
    expect(new FinDecimal('1000000000000000').toString()).toBe('1000000000000000')
  })
})

describe('rounding (the golden boundary table)', () => {
  /*
   * String inputs only, deliberately. A table written with numeric literals
   * passes while proving nothing about float ingress, which is the exact
   * failure the table exists to detect.
   */
  const cases: Array<[string, number, string]> = [
    ['2.5', 0, '3'],
    ['-2.5', 0, '-3'],
    ['0.5', 0, '1'],
    ['-0.5', 0, '-1'],
    ['1.5', 0, '2'],
    ['0.615', 2, '0.62'],
    ['-0.615', 2, '-0.62'],
    ['2.675', 2, '2.68'],
    ['-2.675', 2, '-2.68'],
    ['1.0005', 3, '1.001'],
    ['1234.56785', 4, '1234.5679'],
    ['-1234.56785', 4, '-1234.5679'],
  ]

  it.each(cases)(
    'rounds %s at scale %i to %s, half-up away from zero',
    (input, scale, expected) => {
      expect(new FinDecimal(input).toDecimalPlaces(scale, Rounding.HALF_UP).toFixed(scale)).toBe(
        expected,
      )
    },
  )

  it('is symmetric about zero: round(-x) equals -round(x)', () => {
    // This is what keeps a directly computed negative amount — a credit note
    // line, a negative adjustment — the exact mirror of its positive twin.
    for (const [input, scale] of cases.map(([i, s]) => [i, s] as const)) {
      const positive = new FinDecimal(input).abs().toDecimalPlaces(scale, Rounding.HALF_UP)
      const negative = new FinDecimal(input)
        .abs()
        .negated()
        .toDecimalPlaces(scale, Rounding.HALF_UP)
      expect(negative.toFixed(scale)).toBe(positive.negated().toFixed(scale))
    }
  })

  it('differs from banker’s rounding, which is why half-even is forbidden', () => {
    // Half-even IS symmetric about zero, so a reversal test would not catch
    // it. What catches it is disagreement with PostgreSQL numeric on ties.
    const HalfEven = Decimal.clone({ rounding: Decimal.ROUND_HALF_EVEN })
    expect(new HalfEven('2.5').toDecimalPlaces(0).toString()).toBe('2')
    expect(new FinDecimal('2.5').toDecimalPlaces(0).toString()).toBe('3')
  })

  it('differs from Number.prototype.toFixed, which has already lost the value', () => {
    expect((0.615).toFixed(2)).toBe('0.61')
    expect(new FinDecimal('0.615').toFixed(2)).toBe('0.62')
  })
})

describe('Money.from rejects what decimal.js would accept', () => {
  it('rejects a JavaScript number', () => {
    expect(() => Money.from(0.615 as unknown as string)).toThrow(AmountError)
    expect(() => Money.from((0.1 + 0.2) as unknown as string)).toThrow(/already lost the value/)
  })

  it.each(['0x1f', '0b101', '0o17', '1e3', '1E3'])(
    'rejects radix and exponential notation: %s',
    (input) => {
      // Verified against decimal.js@10.6.0: '0x1f' parses as 31.
      expect(() => Money.from(input)).toThrow(AmountError)
    },
  )

  it.each(['NaN', 'Infinity', '-Infinity', '', '   ', '+1.5', '1.2.3', 'abc', '1,000'])(
    'rejects non-decimal input: %s',
    (input) => {
      expect(() => Money.from(input)).toThrow(AmountError)
    },
  )

  it.each([null, undefined, {}, [], true])('rejects non-string input: %s', (input) => {
    expect(() => Money.from(input as unknown as string)).toThrow(AmountError)
  })

  it('rejects more decimal places than the scale allows', () => {
    expect(() => Money.from('1.00001')).toThrow(/scale is 4/)
    expect(() => UnitCost.from('1.0000001')).toThrow(/scale is 6/)
    expect(Money.from('1.0001').toJSON()).toBe('1.0001')
    expect(UnitCost.from('1.000001').toJSON()).toBe('1.000001')
  })

  it('rejects values beyond the column precision', () => {
    expect(() => Money.from('1234567890123456')).toThrow(/numeric\(19,4\)/)
    expect(() => Percentage.from('1000')).toThrow(/numeric\(9,6\)/)
    expect(Percentage.from('999.999999').toJSON()).toBe('999.999999')
  })
})

describe('kinds carry their own scale (ADR-0011)', () => {
  it('serialises each kind at its column scale', () => {
    expect(Money.from('1').toJSON()).toBe('1.0000')
    expect(UnitCost.from('1').toJSON()).toBe('1.000000')
    expect(Quantity.from('1').toJSON()).toBe('1.000000')
    expect(Percentage.from('17').toJSON()).toBe('17.000000')
  })

  it('never emits a JSON number', () => {
    const body = JSON.stringify({ total: Money.from('10000.10') })
    expect(body).toBe('{"total":"10000.1000"}')
    expect(JSON.parse(body).total).toBeTypeOf('string')
  })
})

describe('arithmetic', () => {
  it('does not round intermediates', () => {
    const raw = Money.multiply(Quantity.from('3'), UnitCost.from('86.666667'))
    expect(raw.value.toFixed(6)).toBe('260.000001')
  })

  it('negates exactly, so a reversal neutralises the original (ADR-0006)', () => {
    const original = Money.from('1234.5678')
    const reversal = Money.negate(original)
    expect(Money.isZero(Money.add(original, reversal))).toBe(true)
    expect(Money.serialize(reversal)).toBe('-1234.5678')
  })

  it('sums a set exactly', () => {
    const lines = ['0.1', '0.2', '0.3'].map(Money.from)
    expect(Money.serialize(Money.sum(lines))).toBe('0.6000')
  })

  it('requires an explicit scale for division', () => {
    const third = Money.divide(Money.from('10'), Quantity.from('3'), 4)
    expect(Money.serialize(third)).toBe('3.3333')
  })

  it('refuses to divide by zero', () => {
    expect(() => Money.divide(Money.from('10'), Quantity.zero(), 4)).toThrow(AmountError)
    expect(() => UnitCost.weightedAverage(Money.from('10'), Quantity.zero())).toThrow(AmountError)
  })

  it('applies a percentage as a percentage, not a fraction', () => {
    const tax = Money.applyPercentage(Money.from('1000'), Percentage.from('17'))
    expect(Money.serialize(Money.round(tax))).toBe('170.0000')
  })
})

describe('Golden Scenario A (NON_NEGOTIABLES §3)', () => {
  // opening 100 @ Rs 80, purchase 50 @ Rs 100, sale 40 @ Rs 140
  const openingValue = Money.multiply(Quantity.from('100'), UnitCost.from('80'))
  const purchaseValue = Money.multiply(Quantity.from('50'), UnitCost.from('100'))
  const totalValue = Money.add(openingValue, purchaseValue)
  const totalQuantity = Quantity.add(Quantity.from('100'), Quantity.from('50'))
  const average = UnitCost.weightedAverage(totalValue, totalQuantity)

  const sold = Quantity.from('40')
  const cogs = Money.round(Money.multiply(sold, average))
  const revenue = Money.multiply(sold, UnitCost.from('140'))
  const grossProfit = Money.subtract(revenue, cogs)
  const closingQuantity = Quantity.subtract(totalQuantity, sold)
  const inventoryValue = Money.round(Money.multiply(closingQuantity, average))

  it('reproduces the hand-computed weighted average', () => {
    expect(UnitCost.serialize(average)).toBe('86.666667')
  })

  it('reproduces the hand-computed figures to the paisa', () => {
    expect(Money.serialize(totalValue, 2)).toBe('13000.00')
    expect(Money.serialize(revenue, 2)).toBe('5600.00')
    expect(Money.serialize(cogs, 2)).toBe('3466.67')
    expect(Money.serialize(grossProfit, 2)).toBe('2133.33')
    expect(Money.serialize(inventoryValue, 2)).toBe('9533.33')
    expect(Quantity.serialize(closingQuantity, 0)).toBe('110')
  })

  it('records the Invariant 10 residual that ADR-0007 must rule on', () => {
    // The inventory ledger valuation and the inventory GL balance differ by
    // Rs 0.0001 at 4dp. Both present as Rs 9,533.33, so the golden figures
    // stand — but Invariant 10 asserts exact reconciliation and §4 forbids
    // tolerances. Asserted here so the gap cannot drift unnoticed while the
    // ruling is outstanding.
    const glBalance = Money.subtract(totalValue, cogs)
    expect(Money.serialize(inventoryValue)).toBe('9533.3334')
    expect(Money.serialize(glBalance)).toBe('9533.3333')
    expect(Money.serialize(Money.subtract(inventoryValue, glBalance))).toBe('0.0001')
  })
})
