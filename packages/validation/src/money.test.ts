import { describe, expect, it } from 'vitest'
import { Decimal } from 'decimal.js'
import { FinDecimal, Rounding } from './decimal.ts'
import { Amount, AmountError, Money, Percentage, Quantity, UnitCost } from './money.ts'

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
    /*
     * Scale 6 — the costing scale. This is the precision the weighted average
     * is stored at (ADR-0011), the number Golden Scenario A turns on, and the
     * one the inventory valuation ruling is about. The table covered 0, 2, 3
     * and 4 and stopped short of the scale that actually decides a COGS
     * figure.
     */
    ['86.6666665', 6, '86.666667'],
    ['-86.6666665', 6, '-86.666667'],
    ['0.0000005', 6, '0.000001'],
    ['-0.0000005', 6, '-0.000001'],
    ['86.6666664', 6, '86.666666'],
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

  it('refuses to serialise an unrounded intermediate rather than rounding it', () => {
    /*
     * The asymmetry this closes: Money.from('260.000001') THROWS because the
     * value carries more decimal places than the scale, yet toJSON would
     * happily have emitted "260.0000" for the same number — performing a
     * rounding nobody wrote and no document names as a boundary.
     *
     * Arithmetic returns full precision deliberately, so every product in the
     * system was one accidental JSON.stringify away from an undeclared
     * rounding boundary. That is the "rounded twice" failure ADR-0011 forbids.
     */
    const unrounded = Money.multiply(Quantity.from('3'), UnitCost.from('86.666667'))
    expect(unrounded.value.toFixed(6)).toBe('260.000001')

    expect(() => JSON.stringify({ total: unrounded })).toThrow(AmountError)
    expect(() => unrounded.toString()).toThrow(/Rounding once, explicitly, is the rule/)
  })

  it('serialises once the caller has rounded explicitly', () => {
    const unrounded = Money.multiply(Quantity.from('3'), UnitCost.from('86.666667'))
    expect(JSON.stringify({ total: Money.round(unrounded) })).toBe('{"total":"260.0000"}')
  })

  it('still rounds when a scale is asked for explicitly', () => {
    // An explicitly requested scale IS a documented boundary —
    // Money.serialize(total, 2) says what it does.
    const unrounded = Money.multiply(Quantity.from('3'), UnitCost.from('86.666667'))
    expect(Money.serialize(unrounded, 2)).toBe('260.00')
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
  /*
   * The CARRIED value, not `closingQuantity × average` (ADR-0015 §7).
   *
   * This was the recomputation until the ruling, named `inventoryValue` and
   * asserted as the inventory value. It passed only because 9533.3334 and
   * 9533.3333 both present as 9,533.33 at 2 dp — the exact coincidence the
   * ADR exists to stop relying on.
   */
  const inventoryValue = Money.subtract(totalValue, cogs)

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

  it('produces the carried value, which is what the GL will be debited to', () => {
    /*
     * This test used to assert a Rs 0.0001 residual as an open question, and
     * then — while fixing that — asserted `x − x = 0` with two identical
     * expressions named `carriedValue` and `glBalance`, presented as an
     * Invariant 10 reconciliation. It was the same fake reconciliation
     * removed from tests/accounting/golden-scenarios.spec.ts, left behind in
     * this file.
     *
     * There is no journal here and no independent GL side. What this can
     * prove is the figure; the reconciliation waits for Wave 2, and
     * Invariant 10 stays `pending` until then.
     */
    expect(Money.serialize(Money.subtract(totalValue, cogs))).toBe('9533.3333')
  })

  it('pins quantity × average as the forbidden recomputation', () => {
    // Rule 16 / ADR-0015 §7. Kept so the figure cannot come back as an
    // expectation. It differs from the carried value by 0.0001 here and by
    // 0.0005 at ten times the quantity — which is why no tolerance can cover
    // it. The full argument lives in tests/accounting/golden/scenario-a.json.
    const recomputed = Money.round(Money.multiply(closingQuantity, average))
    const carriedValue = Money.subtract(totalValue, cogs)

    expect(Money.serialize(recomputed)).toBe('9533.3334')
    expect(Money.serialize(Money.subtract(recomputed, carriedValue))).toBe('0.0001')
    expect(Money.equals(recomputed, carriedValue)).toBe(false)
  })
})

describe('a non-finite amount cannot exist', () => {
  /*
   * The failure this closes is specific and severe.
   *
   * `decimalPlaces()` returns NaN for a non-finite decimal, and `NaN > 4` is
   * false — so the over-scale guard passed it straight through to `toFixed`,
   * which produced the string "NaN". PostgreSQL accepts `'NaN'::numeric`, and
   * in PostgreSQL `NaN = NaN` is TRUE.
   *
   * So a journal entry whose every line was NaN would satisfy a database
   * SUM(debit) = SUM(credit) constraint. An entry that balances because both
   * sides are not-a-number passes the very control meant to catch it, which
   * is the worst shape an Invariant 1 failure can take.
   */
  it.each([NaN, Infinity, -Infinity])('refuses %s at construction', (bad) => {
    expect(() => new Amount('Money', new FinDecimal(bad))).toThrow(AmountError)
  })

  it('names why, rather than failing obscurely', () => {
    expect(() => new Amount('Money', new FinDecimal(NaN))).toThrow(/NaN = NaN is TRUE/)
  })

  it.each(['Quantity', 'UnitCost', 'Percentage'] as const)('applies to %s too', (kind) => {
    expect(() => new Amount(kind, new FinDecimal(NaN))).toThrow(AmountError)
  })

  it('never lets "NaN" reach a serialised form', () => {
    /*
     * Asserted at the boundary as well as the constructor. `value` is a
     * public readonly field holding a mutable decimal, so the constructor is
     * not the only way a non-finite value could arrive here.
     */
    const money = Money.from('1.00')
    expect(Money.serialize(money)).not.toContain('NaN')
    expect(JSON.stringify({ amount: money })).not.toContain('NaN')
  })

  it('still accepts every finite amount', () => {
    for (const good of ['0', '-0.0001', '9999999999999.9999', '2.5']) {
      expect(() => Money.from(good)).not.toThrow()
    }
  })
})
