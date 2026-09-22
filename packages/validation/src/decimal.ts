import { Decimal } from 'decimal.js'

/*
 * The one decimal configuration in FinSoft. ADR-0014.
 *
 * This is a clone, not the global Decimal, because decimal.js exposes global
 * mutable configuration through Decimal.set(). A call to it anywhere — a test,
 * a seed script, a transitive dependency — would silently change the arithmetic
 * of the whole process, retroactively and invisibly. A ledger cannot carry that
 * failure mode.
 *
 * The clone is frozen, because a clone is not immutable by default:
 * `M.set({ rounding: ROUND_DOWN })` silently repoints it and 2.5 then rounds to
 * 2. Object.freeze makes that throw while leaving arithmetic intact.
 */
export const FinDecimal = Decimal.clone({
  /*
   * Significant digits, not decimal places. The binding constraint is
   * multiplication at the numeric(19,6) ceiling, not division:
   *
   *   9,999,999,999,999.999999 squared  →  38 significant digits
   *   the weighted-average numerator    →  39 significant digits
   *   at the default precision of 20    →  LOSSY
   *
   * 40 is sufficient for every documented chain but leaves one digit of
   * headroom. 50 costs nothing on any path that matters.
   */
  precision: 50,

  /* Ties away from zero: 2.5 → 3, -2.5 → -3. Matches PostgreSQL numeric. */
  rounding: Decimal.ROUND_HALF_UP,

  /*
   * Truncated division, matching PostgreSQL % and JavaScript %.
   * NOT ROUND_HALF_UP, which yields negative remainders from positive
   * operands (11 mod 3 = -1) and would post wrong-signed allocation
   * residuals for roughly half of all inputs — intermittently, with every
   * layer above still balancing.
   */
  modulo: Decimal.ROUND_DOWN,

  /* toString() must never yield exponential notation: money travels as a string. */
  toExpNeg: -9e15,
  toExpPos: 9e15,
})

Object.freeze(FinDecimal)

export type Dec = InstanceType<typeof FinDecimal>

/** Rounding modes permitted in FinSoft. Half-up is the default everywhere. */
export const Rounding = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  /* Truncation towards zero. Only for deliberate truncation, never for money. */
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
} as const

export type RoundingMode = (typeof Rounding)[keyof typeof Rounding]
