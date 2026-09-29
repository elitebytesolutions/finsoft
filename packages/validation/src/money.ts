import { FinDecimal, Rounding, type Dec, type RoundingMode } from './decimal.ts'

/*
 * Money, unit costs, quantities and percentages. ADR-0011, ADR-0014.
 *
 * These are wrappers, not bare Decimals, for three reasons:
 *   1. `a + b` on two of them is a TypeScript error, satisfying ADR-0011's
 *      requirement that native arithmetic on a money value does not compile.
 *   2. Money and UnitCost are not interchangeable: a 4-decimal amount assigned
 *      where a 6-decimal unit cost belongs is a defect, and the compiler
 *      should say so.
 *   3. Each value carries its scale at runtime, so toJSON can emit the
 *      fixed-scale string ADR-0014 requires. A type-level brand alone cannot
 *      do that, because it does not exist at runtime.
 *
 * Arithmetic returns FULL PRECISION. Nothing here rounds an intermediate.
 * Rounding happens once, explicitly, at the boundary — see `round` and
 * `serialize`.
 */

/**
 * Why an amount was refused, as a stable machine-readable fact. Callers that
 * translate a refusal into a domain error code (the posting kernel's
 * AMOUNT_NOT_STRING / AMOUNT_SCALE / AMOUNT_OUT_OF_RANGE) switch on this —
 * never on the message text, which is for developers and may be reworded.
 */
export type AmountErrorReason =
  'NOT_STRING' | 'NOTATION' | 'SCALE' | 'RANGE' | 'NON_FINITE' | 'DIVISION_BY_ZERO' | 'BOUNDARY'

export class AmountError extends Error {
  readonly reason: AmountErrorReason

  constructor(message: string, reason: AmountErrorReason = 'BOUNDARY') {
    super(message)
    this.name = 'AmountError'
    this.reason = reason
  }
}

/*
 * ADR-0014's BLOCKING PRECONDITION on the posting-engine contract, closed:
 * "Amount.value becomes internal before any code outside packages/validation
 * consumes an Amount." packages/accounting-kernel now consumes Amounts, so the
 * raw decimal is held under a module-private symbol instead of a public
 * `value` field. `Money.from('1').value.toNumber()` — the float-egress path
 * the ADR names — no longer compiles anywhere, and there is no supported way
 * to reach the decimal outside this package. `AMOUNT_VALUE` is exported from
 * this FILE for packages/validation's own tests; it is deliberately NOT
 * re-exported from the package index.
 */
export const AMOUNT_VALUE: unique symbol = Symbol('Amount.value')
const VALUE: typeof AMOUNT_VALUE = AMOUNT_VALUE

/** Scale and total digits, taken from the column definitions in ADR-0011. */
const SPEC = {
  Money: { scale: 4, totalDigits: 19 }, // numeric(19,4)
  UnitCost: { scale: 6, totalDigits: 19 }, // numeric(19,6)
  Quantity: { scale: 6, totalDigits: 19 }, // numeric(19,6)
  Percentage: { scale: 6, totalDigits: 9 }, // numeric(9,6), as a percentage not a fraction
} as const

export type Kind = keyof typeof SPEC

/**
 * A fixed-scale decimal value of a particular kind.
 *
 * `kind` is a literal discriminant, so `Amount<'Money'>` and
 * `Amount<'UnitCost'>` are not assignable to one another.
 */
export class Amount<K extends Kind> {
  readonly kind: K
  readonly [VALUE]: Dec
  readonly scale: number

  /** @internal Use Money.from, Quantity.from, and so on. */
  constructor(kind: K, value: Dec) {
    /*
     * NaN and Infinity are rejected HERE, at construction, not at the
     * boundary on the way out.
     *
     * The scale guard below could not catch them: `decimalPlaces()` returns
     * NaN for a non-finite value, `NaN > 4` is false, and the check fell
     * straight through to `toFixed` — which happily produced the string
     * "NaN". That string is accepted by PostgreSQL as `'NaN'::numeric`, and
     * in PostgreSQL `NaN = NaN` is TRUE, so a journal entry whose every line
     * was NaN would satisfy a database-level SUM(debit) = SUM(credit) check.
     *
     * An entry that balances because both sides are not-a-number is the
     * worst possible failure of Invariant 1: it passes the control designed
     * to catch it.
     */
    if (!value.isFinite()) {
      throw new AmountError(
        `${kind} cannot be ${value.isNaN() ? 'NaN' : 'Infinity'}. A non-finite amount ` +
          'serialises to a string PostgreSQL accepts as numeric, where NaN = NaN is TRUE — ' +
          'so an entry of NaN lines would satisfy a SUM(debit) = SUM(credit) check while ' +
          'balancing nothing (NON_NEGOTIABLES Invariant 1).',
        'NON_FINITE',
      )
    }

    this.kind = kind
    this[VALUE] = value
    this.scale = SPEC[kind].scale
    Object.freeze(this)
  }

  /*
   * ADR-0014: money crosses every boundary as a fixed-scale string.
   *
   * Both of these REFUSE a value carrying more decimal places than its scale,
   * rather than quietly rounding it.
   *
   * Arithmetic here returns full precision on purpose — `Money.multiply`
   * gives 260.000001 for 3 × 86.666667 — and rounding is meant to happen
   * once, explicitly, at a documented boundary. An implicit `toFixed` on the
   * way out is a second, undeclared boundary: it would mean a value that
   * `Money.from` REFUSES to accept ("carries 6 decimal places but the scale
   * is 4") is one that `JSON.stringify` emits happily, having rounded it.
   * That asymmetry is the "rounded twice" failure ADR-0011 forbids, and every
   * product in the system would have been one accidental serialisation away
   * from it.
   *
   * `serialize(amount, scale)` still rounds, because an explicitly requested
   * scale IS a documented boundary — `Money.serialize(total, 2)` for
   * presentation says what it does.
   */
  toJSON(): string {
    return this.fixedOrThrow('toJSON')
  }

  toString(): string {
    return this.fixedOrThrow('toString')
  }

  private fixedOrThrow(via: string): string {
    /*
     * Belt and braces. The constructor rejects non-finite values, so this is
     * unreachable through the sanctioned path — but the decimal held under
     * the private symbol is still a mutable object, and the scale check below
     * silently passes anything non-finite (NaN > scale is false).
     */
    if (!this[VALUE].isFinite()) {
      throw new AmountError(
        `${this.kind}.${via}() refused: the value is not finite. See the constructor.`,
      )
    }

    if (this[VALUE].decimalPlaces() > this.scale) {
      throw new AmountError(
        `${this.kind}.${via}() refused: the value carries ${this[VALUE].decimalPlaces()} decimal ` +
          `places but the scale is ${this.scale}. Rounding once, explicitly, is the rule — ` +
          `call ${this.kind}.round() first, or ${this.kind}.serialize(value, scale) if you ` +
          'mean to round for presentation.',
      )
    }
    return this[VALUE].toFixed(this.scale)
  }
}

export type Money = Amount<'Money'>
export type UnitCost = Amount<'UnitCost'>
export type Quantity = Amount<'Quantity'>
export type Percentage = Amount<'Percentage'>

/*
 * Decimal notation only. This deliberately rejects what decimal.js would
 * otherwise accept (all verified against decimal.js@10.6.0):
 *   '0x1f'  → 31        hexadecimal
 *   '0b101' → 5         binary
 *   '0o17'  → 15        octal
 *   '1e3'   → 1000      exponential
 *   'NaN' / 'Infinity'
 * An import file or API body containing "0x1f" must not become 31 rupees.
 */
const DECIMAL_NOTATION = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

function parse<K extends Kind>(kind: K, input: string): Amount<K> {
  const { scale, totalDigits } = SPEC[kind]

  if (typeof input !== 'string') {
    throw new AmountError(
      `${kind} must be constructed from a string, received ${typeof input}. ` +
        'A JavaScript number has already lost the value (ADR-0011).',
      'NOT_STRING',
    )
  }
  if (!DECIMAL_NOTATION.test(input)) {
    throw new AmountError(
      `${kind}: "${input}" is not plain decimal notation. ` +
        'Hexadecimal, binary, octal, exponential, NaN and Infinity are rejected.',
      'NOTATION',
    )
  }

  const [intPart = '', fracPart = ''] = input.replace('-', '').split('.')
  if (fracPart.length > scale) {
    throw new AmountError(
      `${kind}: "${input}" carries ${fracPart.length} decimal places but the scale is ${scale}. ` +
        'Round explicitly — rounding never happens implicitly.',
      'SCALE',
    )
  }
  if (intPart.length + scale > totalDigits) {
    throw new AmountError(`${kind}: "${input}" exceeds numeric(${totalDigits},${scale}).`, 'RANGE')
  }

  const value = new FinDecimal(input)
  /* Belt and braces: the regex already excludes these. */
  if (!value.isFinite()) {
    throw new AmountError(`${kind}: "${input}" is not finite.`, 'NON_FINITE')
  }
  return new Amount(kind, value)
}

function ops<K extends Kind>(kind: K) {
  const { scale } = SPEC[kind]
  const wrap = (d: Dec): Amount<K> => new Amount(kind, d)

  return {
    scale,

    /** Parse from a decimal string. The only way in. */
    from: (input: string): Amount<K> => parse(kind, input),

    zero: (): Amount<K> => wrap(new FinDecimal(0)),

    /** Full precision — does not round. */
    add: (a: Amount<K>, b: Amount<K>): Amount<K> => wrap(a[VALUE].plus(b[VALUE])),

    /** Full precision — does not round. */
    subtract: (a: Amount<K>, b: Amount<K>): Amount<K> => wrap(a[VALUE].minus(b[VALUE])),

    /** ADR-0006: a reversal negates the original exactly. */
    negate: (a: Amount<K>): Amount<K> => wrap(a[VALUE].negated()),

    abs: (a: Amount<K>): Amount<K> => wrap(a[VALUE].abs()),

    sum: (xs: readonly Amount<K>[]): Amount<K> =>
      wrap(xs.reduce((acc, x) => acc.plus(x[VALUE]), new FinDecimal(0))),

    /**
     * Round once, explicitly, half-up. ADR-0011.
     * Defaults to this kind's own scale.
     */
    round: (a: Amount<K>, toScale: number = scale, mode: RoundingMode = Rounding.HALF_UP) =>
      wrap(a[VALUE].toDecimalPlaces(toScale, mode)),

    /** Division never has an implicit scale. ADR-0011. */
    divide: (
      a: Amount<K>,
      by: Amount<Kind>,
      toScale: number,
      mode: RoundingMode = Rounding.HALF_UP,
    ): Amount<K> => {
      if (by[VALUE].isZero())
        throw new AmountError(`${kind}: division by zero.`, 'DIVISION_BY_ZERO')
      return wrap(a[VALUE].div(by[VALUE]).toDecimalPlaces(toScale, mode))
    },

    compare: (a: Amount<K>, b: Amount<K>): -1 | 0 | 1 =>
      a[VALUE].comparedTo(b[VALUE]) as -1 | 0 | 1,
    equals: (a: Amount<K>, b: Amount<K>): boolean => a[VALUE].equals(b[VALUE]),
    isZero: (a: Amount<K>): boolean => a[VALUE].isZero(),
    isNegative: (a: Amount<K>): boolean => a[VALUE].isNegative() && !a[VALUE].isZero(),

    /**
     * The fixed-scale string that crosses HTTP, the outbox and exports.
     *
     * ADR-0014's open item, resolved: `toScale` has no default. A defaulted
     * scale made this a second, undeclared rounding boundary — `toJSON()` and
     * `toString()` THROW on a value carrying more decimals than its scale,
     * deliberately, because an implicit `toFixed` on the way out is the
     * "rounded twice" failure ADR-0011 forbids; but the old
     * `serialize: (a, toScale = scale) => a.value.toFixed(toScale)` rounded
     * SILENTLY when no scale was named, so `260.000001` threw through
     * `toJSON()` and became `"260.0000"` through `serialize(x)`. Requiring the
     * argument — matching `divide`, above, which has never had a default —
     * makes every rounding boundary in this module the same shape: explicit,
     * at the call site, or not at all.
     */
    serialize: (a: Amount<K>, toScale: number): string => {
      /*
       * The type makes `toScale` required; this makes it required at RUNTIME
       * too. A JavaScript caller (or a cast) that omits it would otherwise
       * reach `toFixed(undefined)`, which does not round but emits however
       * many decimals the value happens to carry — an unscaled string on a
       * boundary whose whole contract is a fixed scale.
       */
      if (!Number.isInteger(toScale) || toScale < 0) {
        throw new AmountError(
          `${kind}.serialize: toScale must be an explicit non-negative integer, got ${String(toScale)}. ` +
            'There is no default scale: naming it is what makes the rounding boundary explicit (ADR-0014).',
        )
      }
      return a[VALUE].toFixed(toScale)
    },
  }
}

export const Money = {
  ...ops('Money'),

  /**
   * quantity × unit cost. Full precision — the caller rounds once, at the
   * point the figure is persisted or presented.
   */
  multiply: (quantity: Quantity, unitCost: UnitCost): Money =>
    new Amount('Money', quantity[VALUE].times(unitCost[VALUE])),

  /** amount × percentage (as a percentage, not a fraction). Full precision. */
  applyPercentage: (amount: Money, percentage: Percentage): Money =>
    new Amount('Money', amount[VALUE].times(percentage[VALUE]).div(100)),
}

export const UnitCost = {
  ...ops('UnitCost'),

  /**
   * The weighted-average recomputation of ADR-0007: total value / total
   * quantity, rounded once to 6 decimal places.
   */
  weightedAverage: (totalValue: Money, totalQuantity: Quantity): UnitCost => {
    if (totalQuantity[VALUE].isZero()) {
      throw new AmountError('UnitCost: weighted average of a zero quantity is undefined.')
    }
    return new Amount(
      'UnitCost',
      totalValue[VALUE].div(totalQuantity[VALUE]).toDecimalPlaces(6, Rounding.HALF_UP),
    )
  },
}

export const Quantity = { ...ops('Quantity') }
export const Percentage = { ...ops('Percentage') }
