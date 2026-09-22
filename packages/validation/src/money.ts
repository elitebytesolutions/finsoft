import { FinDecimal, Rounding, type Dec, type RoundingMode } from './decimal.js'

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

export class AmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmountError'
  }
}

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
  readonly value: Dec
  readonly scale: number

  /** @internal Use Money.from, Quantity.from, and so on. */
  constructor(kind: K, value: Dec) {
    this.kind = kind
    this.value = value
    this.scale = SPEC[kind].scale
    Object.freeze(this)
  }

  /** ADR-0014: money crosses every boundary as a fixed-scale string. */
  toJSON(): string {
    return this.value.toFixed(this.scale)
  }

  toString(): string {
    return this.value.toFixed(this.scale)
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
    )
  }
  if (!DECIMAL_NOTATION.test(input)) {
    throw new AmountError(
      `${kind}: "${input}" is not plain decimal notation. ` +
        'Hexadecimal, binary, octal, exponential, NaN and Infinity are rejected.',
    )
  }

  const [intPart = '', fracPart = ''] = input.replace('-', '').split('.')
  if (fracPart.length > scale) {
    throw new AmountError(
      `${kind}: "${input}" carries ${fracPart.length} decimal places but the scale is ${scale}. ` +
        'Round explicitly — rounding never happens implicitly.',
    )
  }
  if (intPart.length + scale > totalDigits) {
    throw new AmountError(`${kind}: "${input}" exceeds numeric(${totalDigits},${scale}).`)
  }

  const value = new FinDecimal(input)
  /* Belt and braces: the regex already excludes these. */
  if (!value.isFinite()) {
    throw new AmountError(`${kind}: "${input}" is not finite.`)
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
    add: (a: Amount<K>, b: Amount<K>): Amount<K> => wrap(a.value.plus(b.value)),

    /** Full precision — does not round. */
    subtract: (a: Amount<K>, b: Amount<K>): Amount<K> => wrap(a.value.minus(b.value)),

    /** ADR-0006: a reversal negates the original exactly. */
    negate: (a: Amount<K>): Amount<K> => wrap(a.value.negated()),

    abs: (a: Amount<K>): Amount<K> => wrap(a.value.abs()),

    sum: (xs: readonly Amount<K>[]): Amount<K> =>
      wrap(xs.reduce((acc, x) => acc.plus(x.value), new FinDecimal(0))),

    /**
     * Round once, explicitly, half-up. ADR-0011.
     * Defaults to this kind's own scale.
     */
    round: (a: Amount<K>, toScale: number = scale, mode: RoundingMode = Rounding.HALF_UP) =>
      wrap(a.value.toDecimalPlaces(toScale, mode)),

    /** Division never has an implicit scale. ADR-0011. */
    divide: (
      a: Amount<K>,
      by: Amount<Kind>,
      toScale: number,
      mode: RoundingMode = Rounding.HALF_UP,
    ): Amount<K> => {
      if (by.value.isZero()) throw new AmountError(`${kind}: division by zero.`)
      return wrap(a.value.div(by.value).toDecimalPlaces(toScale, mode))
    },

    compare: (a: Amount<K>, b: Amount<K>): -1 | 0 | 1 => a.value.comparedTo(b.value) as -1 | 0 | 1,
    equals: (a: Amount<K>, b: Amount<K>): boolean => a.value.equals(b.value),
    isZero: (a: Amount<K>): boolean => a.value.isZero(),
    isNegative: (a: Amount<K>): boolean => a.value.isNegative() && !a.value.isZero(),

    /** The fixed-scale string that crosses HTTP, the outbox and exports. */
    serialize: (a: Amount<K>, toScale: number = scale): string => a.value.toFixed(toScale),
  }
}

export const Money = {
  ...ops('Money'),

  /**
   * quantity × unit cost. Full precision — the caller rounds once, at the
   * point the figure is persisted or presented.
   */
  multiply: (quantity: Quantity, unitCost: UnitCost): Money =>
    new Amount('Money', quantity.value.times(unitCost.value)),

  /** amount × percentage (as a percentage, not a fraction). Full precision. */
  applyPercentage: (amount: Money, percentage: Percentage): Money =>
    new Amount('Money', amount.value.times(percentage.value).div(100)),
}

export const UnitCost = {
  ...ops('UnitCost'),

  /**
   * The weighted-average recomputation of ADR-0007: total value / total
   * quantity, rounded once to 6 decimal places.
   */
  weightedAverage: (totalValue: Money, totalQuantity: Quantity): UnitCost => {
    if (totalQuantity.value.isZero()) {
      throw new AmountError('UnitCost: weighted average of a zero quantity is undefined.')
    }
    return new Amount(
      'UnitCost',
      totalValue.value.div(totalQuantity.value).toDecimalPlaces(6, Rounding.HALF_UP),
    )
  },
}

export const Quantity = { ...ops('Quantity') }
export const Percentage = { ...ops('Percentage') }
