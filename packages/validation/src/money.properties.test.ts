import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { AMOUNT_VALUE, Money, Quantity, UnitCost, AmountError } from './money.ts'

/*
 * Property tests for the money primitives. ADR-0014 deferral D5, closed.
 *
 * D5 read: "Property-based generation over `Money.from`'s rejections. The
 * repository has no property-testing dependency, and adding one is a tooling
 * decision rather than a gap in this ADR." The Product Owner adopted
 * `fast-check` on 2026-09-24 and asked for exactly four areas — money
 * parsing, finite-value rejection, scale, and rounding boundaries. Those are
 * the four describe blocks below.
 *
 * ── What a property test adds over the tables in money.test.ts ──────────
 *
 * The `it.each` tables there are hand-chosen boundaries: 0.615, 2.5, -2.5,
 * the numeric(19,6) ceiling. They are the cases someone thought of. A
 * property test is the cases nobody thought of, and its value is entirely in
 * whether the property is stated correctly — a property that restates the
 * implementation passes against any implementation, including a wrong one.
 *
 * So the rounding oracle below is written in BigInt string arithmetic,
 * independent of decimal.js. If both were decimal.js the test would assert
 * that the library agrees with itself.
 */

/* ------------------------------------------------------------------ *
 * An independent half-up oracle
 *
 * ADR-0014: ROUND_HALF_UP, away from zero, matching PostgreSQL `numeric`.
 * Implemented here on digit strings with BigInt, so it shares no code with
 * the thing it checks.
 * ------------------------------------------------------------------ */

function halfUpAwayFromZero(value: string, scale: number): string {
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [intPart = '0', fracPart = ''] = unsigned.split('.')

  const kept = fracPart.slice(0, scale).padEnd(scale, '0')
  const dropped = fracPart.slice(scale)

  let digits = BigInt(intPart + kept)

  /*
   * Away from zero on a tie: the FIRST dropped digit decides, and >= 5
   * rounds the magnitude up. Half-even would look at the digit before it;
   * half-toward-zero would truncate. Both would disagree with PostgreSQL,
   * which is the point of fixing this.
   */
  if (dropped.length > 0 && Number(dropped[0]) >= 5) digits += 1n

  const asString = digits.toString().padStart(scale + 1, '0')
  const head = scale === 0 ? asString : asString.slice(0, -scale)
  const tail = scale === 0 ? '' : `.${asString.slice(-scale)}`
  const magnitude = `${head}${tail}`

  // Avoid "-0.00": zero has no sign.
  return negative && BigInt(digits) !== 0n ? `-${magnitude}` : magnitude
}

/*
 * CANONICAL decimal notation: `0`, or a leading non-zero digit.
 *
 * Generated this way because `DECIMAL_NOTATION` deliberately rejects leading
 * zeros — `^-?(?:0|[1-9]\d*)(?:\.\d+)?$` — so that `0x1f` cannot arrive as
 * 31 rupees and so one value has one spelling. The first version of these
 * generators emitted `00` and `007`, and five properties failed on the very
 * first run.
 *
 * That was the generator being wrong, not the validator. Recorded because
 * the opposite conclusion — loosening the regex to make a test pass — is the
 * easy one to reach at speed, and it would have widened an input filter that
 * exists to keep hexadecimal out of a ledger.
 */
const integerPart = (maxDigits: number) =>
  fc.oneof(
    { weight: 1, arbitrary: fc.constant('0') },
    {
      weight: 9,
      arbitrary: fc.stringMatching(new RegExp(`^[1-9][0-9]{0,${Math.max(0, maxDigits - 1)}}$`)),
    },
  )

/** A decimal literal: optional sign, canonical integer part, bounded fraction. */
const decimalString = (maxIntDigits: number, maxFracDigits: number) =>
  fc
    .tuple(
      fc.boolean(),
      integerPart(maxIntDigits),
      fc.option(fc.stringMatching(new RegExp(`^[0-9]{1,${maxFracDigits}}$`)), { nil: undefined }),
    )
    .map(([neg, int, frac]) => `${neg ? '-' : ''}${int}${frac === undefined ? '' : `.${frac}`}`)

describe('the oracle itself is right, before it is trusted', () => {
  /*
   * A property test is only as good as its oracle. These are the hand-checked
   * cases from ADR-0014's boundary table, run against the BigInt
   * implementation above rather than against decimal.js.
   */
  it.each([
    ['2.5', 0, '3'],
    ['-2.5', 0, '-3'],
    ['0.5', 0, '1'],
    ['-0.5', 0, '-1'],
    ['1.4', 0, '1'],
    ['0.615', 2, '0.62'],
    ['-0.615', 2, '-0.62'],
    ['86.6666665', 6, '86.666667'],
    ['0.00004', 4, '0.0000'],
    ['0.00005', 4, '0.0001'],
  ])('halfUpAwayFromZero(%s, %i) = %s', (value, scale, expected) => {
    expect(halfUpAwayFromZero(value, scale)).toBe(expected)
  })
})

describe('D5 · money parsing', () => {
  it('round-trips any in-scale decimal string exactly', () => {
    fc.assert(
      fc.property(decimalString(13, 4), (value) => {
        /*
         * The serialisation contract: a money value leaves at its kind's
         * scale, and parsing then serialising must not change it. This is the
         * property that would catch a parser doing arithmetic on the way in.
         */
        const expected = halfUpAwayFromZero(value, 4)
        expect(Money.from(value).toString()).toBe(expected)
      }),
      { numRuns: 500 },
    )
  })

  it('REJECTS every numeric input, whatever its value', () => {
    /*
     * ADR-0011. A JS number cannot hold 19 significant digits exactly, so
     * accepting one would silently lose precision before validation could
     * see it. The type system stops most of this; the runtime guard stops
     * the rest, and JSON.parse is where "the rest" comes from.
     */
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (n) => {
        expect(() => Money.from(n as unknown as string)).toThrow(AmountError)
      }),
      { numRuns: 300 },
    )
  })

  it('REJECTS anything that is not plain decimal notation', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.stringMatching(/^0x[0-9a-f]{1,8}$/),
          fc.stringMatching(/^0b[01]{1,16}$/),
          fc.stringMatching(/^0o[0-7]{1,8}$/),
          fc.stringMatching(/^[0-9]{1,6}e[+-]?[0-9]{1,2}$/),
          fc.constantFrom('', ' ', '.', '-', '+', '1.2.3', '1,000', '١٢٣'),
        ),
        (value) => {
          expect(() => Money.from(value)).toThrow(AmountError)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('D5 · finite-value rejection', () => {
  it('REJECTS NaN and infinities in every spelling', () => {
    /*
     * The failure this closes is not a type error. `'NaN'` survives
     * serialisation, PostgreSQL accepts `'NaN'::numeric`, and there
     * `NaN = NaN` is TRUE — so a journal entry of NaN lines SATISFIES
     * SUM(debit) = SUM(credit). It balances because both sides are
     * not-a-number, passing the control built to catch exactly that.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(
          'NaN',
          'nan',
          'NAN',
          'Infinity',
          '-Infinity',
          'infinity',
          '+Infinity',
          'inf',
          '-inf',
        ),
        (value) => {
          expect(() => Money.from(value)).toThrow(AmountError)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('never produces a non-finite value from finite inputs, however combined', () => {
    /*
     * The constructor guard is one half. The other is that arithmetic on
     * accepted values cannot manufacture a non-finite one — which is where
     * division would, if it were allowed to divide by zero.
     */
    fc.assert(
      fc.property(decimalString(6, 4), decimalString(6, 4), (a, b) => {
        const x = Money.from(a)
        const y = Money.from(b)

        for (const result of [Money.add(x, y), Money.subtract(x, y), Money.negate(x)]) {
          expect(result[AMOUNT_VALUE].isFinite()).toBe(true)
        }
      }),
      { numRuns: 400 },
    )
  })

  it('refuses division by zero rather than returning an infinity', () => {
    fc.assert(
      fc.property(decimalString(6, 4), (a) => {
        expect(() => Money.divide(Money.from(a), Money.from('0'), 4)).toThrow(AmountError)
      }),
      { numRuns: 100 },
    )
  })
})

describe('D5 · scale', () => {
  it('REJECTS any input carrying more decimals than the kind allows', () => {
    /*
     * ADR-0011's refinement: rounding is explicit or it does not happen. An
     * input with more precision than the column can hold is a caller who has
     * not decided where to round, and accepting it would decide for them
     * silently.
     */
    fc.assert(
      fc.property(integerPart(6), fc.stringMatching(/^[0-9]{5,10}$/), (int, frac) => {
        expect(() => Money.from(`${int}.${frac}`)).toThrow(AmountError)
      }),
      { numRuns: 300 },
    )
  })

  it('accepts every kind at its own scale and rejects one digit more', () => {
    const kinds = [
      { name: 'Money', scale: 4, from: (v: string) => Money.from(v) },
      { name: 'UnitCost', scale: 6, from: (v: string) => UnitCost.from(v) },
      { name: 'Quantity', scale: 6, from: (v: string) => Quantity.from(v) },
    ]

    fc.assert(
      fc.property(integerPart(6), (int) => {
        for (const kind of kinds) {
          const atScale = `${int}.${'1'.repeat(kind.scale)}`
          const overScale = `${int}.${'1'.repeat(kind.scale + 1)}`

          expect(() => kind.from(atScale), `${kind.name} must accept its own scale`).not.toThrow()
          expect(() => kind.from(overScale), `${kind.name} must reject one digit more`).toThrow(
            AmountError,
          )
        }
      }),
      { numRuns: 200 },
    )
  })

  it('serialises at a fixed scale, padding rather than trimming', () => {
    fc.assert(
      fc.property(integerPart(8), (int) => {
        expect(Money.from(int).toString()).toBe(`${int}.0000`)
      }),
      { numRuns: 200 },
    )
  })
})

describe('D5 · rounding boundaries', () => {
  it('rounds half-up away from zero, at every scale, against an independent oracle', () => {
    fc.assert(
      fc.property(decimalString(10, 6), fc.integer({ min: 0, max: 6 }), (value, scale) => {
        const ours = Money.round(Money.from(halfUpAwayFromZero(value, 4)), scale)
        const oracle = halfUpAwayFromZero(halfUpAwayFromZero(value, 4), scale)

        /*
         * STRING TO STRING. No `Number()` on either side.
         *
         * The first version compared `ours.value.toFixed(scale)` against
         * `Number(oracle).toFixed(scale)`, and fast-check found the
         * counterexample on the third run: 9000000000.001 at scale 6. The
         * oracle string is exact; putting it through a JS number makes it
         * 9000000000.000999, because a float cannot hold thirteen
         * significant digits.
         *
         * A property test for exact decimal arithmetic that routes its
         * expected value through a float is the ADR-0011 failure appearing
         * inside the test written to check for it. Worth the comment: the
         * float was in the ASSERTION, which is the last place anyone looks.
         */
        expect(ours[AMOUNT_VALUE].toFixed(scale)).toBe(oracle)
      }),
      { numRuns: 600 },
    )
  })

  it('is symmetric: round(-x) = -round(x)', () => {
    /*
     * The property that fails under half-EVEN and under round-half-toward-
     * zero, and the one a tie-heavy generator finds fast. Away from zero is
     * the only common mode that is symmetric.
     */
    fc.assert(
      fc.property(decimalString(8, 6), fc.integer({ min: 0, max: 6 }), (value, scale) => {
        const positive = Money.from(halfUpAwayFromZero(value.replace('-', ''), 4))
        const rounded = Money.round(positive, scale)
        const roundedNegated = Money.round(Money.negate(positive), scale)

        expect(Money.equals(Money.negate(rounded), roundedNegated)).toBe(true)
      }),
      { numRuns: 400 },
    )
  })

  it('rounding at or above a value’s own precision changes nothing', () => {
    fc.assert(
      fc.property(decimalString(8, 4), (value) => {
        const amount = Money.from(value)
        expect(Money.equals(Money.round(amount, 4), amount)).toBe(true)
        expect(Money.equals(Money.round(amount, 6), amount)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  it('sums are order-independent, which floats are not', () => {
    /*
     * 0.1 + 0.2 !== 0.3 in binary floating point, and the error depends on
     * ORDER — so a float-backed ledger produces a different trial balance
     * depending on how the rows were sorted. This is the property that makes
     * that impossible, and shuffling is how it gets tested rather than
     * asserted.
     */
    fc.assert(
      fc.property(fc.array(decimalString(6, 4), { minLength: 2, maxLength: 40 }), (values) => {
        const amounts = values.map((v) => Money.from(halfUpAwayFromZero(v, 4)))
        const forwards = Money.sum(amounts)
        const backwards = Money.sum([...amounts].reverse())

        expect(Money.equals(forwards, backwards)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})
