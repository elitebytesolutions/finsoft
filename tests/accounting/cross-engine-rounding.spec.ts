import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withGlobal } from '@finsoft/database'
import { prepareTestDatabase, scalarOn, teardownTestDatabase } from '@finsoft/database/testing'
import { FinDecimal, Money, Quantity, Rounding, UnitCost } from '@finsoft/validation'

/*
 * ADR-0014's central claim, executed against a real PostgreSQL.
 *
 * The ADR rejects banker's rounding for one specific reason: half-even
 * disagrees with PostgreSQL `numeric` on ties. It says so plainly — "what
 * catches it is the golden boundary table and the cross-engine test, not the
 * invariant suite." Half of that named detector did not exist, so the claim
 * the whole rounding decision rests on was unverified.
 *
 * It matters because the two engines both handle money. A figure rounded in
 * TypeScript and the same figure rounded by an aggregate in SQL must agree,
 * or a report and the ledger it summarises disagree by a paisa with no
 * explicable cause.
 *
 * Runs through withGlobal as finsoft_app — the restricted role, not a
 * superuser. Rounding is not privileged, and the test should exercise the
 * identity the application actually uses.
 */

/**
 * String inputs only, deliberately.
 *
 * A table of numeric literals would pass while proving nothing about float
 * ingress: `0.615` as a JS number is not the decimal 0.615, and the test
 * would be comparing two roundings of an already-lost value.
 */
const BOUNDARY: ReadonlyArray<readonly [value: string, scale: number]> = [
  ['2.5', 0],
  ['-2.5', 0],
  ['0.5', 0],
  ['-0.5', 0],
  ['1.5', 0],
  ['0.615', 2],
  ['-0.615', 2],
  ['2.675', 2],
  ['-2.675', 2],
  ['1.0005', 3],
  ['1234.56785', 4],
  ['-1234.56785', 4],
  // Scale 6: the costing scale, where the weighted average lives.
  ['86.6666665', 6],
  ['-86.6666665', 6],
  ['0.0000005', 6],
]

describe('Money.round agrees with PostgreSQL numeric', () => {
  beforeAll(prepareTestDatabase, 120_000)
  afterAll(teardownTestDatabase)

  it.each(BOUNDARY)('round(%s, %i) matches SQL round()', async (value, scale) => {
    const ours = new FinDecimal(value).toDecimalPlaces(scale, Rounding.HALF_UP).toFixed(scale)

    const theirs = await withGlobal((tx) =>
      scalarOn<string>(tx, 'select round($1::numeric, $2)::text', [value, scale]),
    )

    expect(
      ours,
      `TypeScript and PostgreSQL disagree on round(${value}, ${scale}). ADR-0014 chose ` +
        'ROUND_HALF_UP precisely because it ties away from zero like numeric does; a ' +
        'disagreement here means a report and the ledger it summarises differ by a paisa.',
    ).toBe(theirs)
  })

  it.each(BOUNDARY)(
    'the CONFIGURED default rounds %s at scale %i the same way SQL does',
    async (value, scale) => {
      /*
       * The cases above pass Rounding.HALF_UP explicitly, so they would pass
       * no matter how the constructor is configured — they prove half-up
       * matches PostgreSQL, not that OUR configuration does. Flipping the
       * clone to ROUND_HALF_EVEN left 30 of 31 green, which is how this gap
       * was found.
       *
       * toFixed() takes no mode and uses the constructor's configured
       * rounding. It is also the method every money value is serialised
       * through — Amount.toJSON, toString and serialize all end here — so
       * this is the path that actually decides what leaves the process.
       */
      const ours = new FinDecimal(value).toFixed(scale)

      const theirs = await withGlobal((tx) =>
        scalarOn<string>(tx, 'select round($1::numeric, $2)::text', [value, scale]),
      )

      expect(
        ours,
        `The configured rounding disagrees with PostgreSQL on ${value} at scale ${scale}. ` +
          'Something has changed FinDecimal’s rounding mode away from ROUND_HALF_UP.',
      ).toBe(theirs)
    },
  )

  it('disagrees with banker’s rounding, which is why half-even is forbidden', async () => {
    // Half-even IS symmetric about zero, so a reversal test cannot catch it.
    // This is the test that can: PostgreSQL gives 3 for round(2.5), half-even
    // gives 2.
    const HalfEven = FinDecimal.clone({ rounding: 6 /* ROUND_HALF_EVEN */ })
    const postgres = await withGlobal((tx) =>
      scalarOn<string>(tx, 'select round(2.5::numeric, 0)::text'),
    )

    expect(postgres).toBe('3')
    expect(new HalfEven('2.5').toDecimalPlaces(0).toString()).toBe('2')
    expect(new FinDecimal('2.5').toDecimalPlaces(0).toString()).toBe('3')
  })

  it('agrees on the implicit rounding of an assignment into numeric(19,4)', async () => {
    /*
     * Not the same code path as round(). PostgreSQL rounds on assignment when
     * a value exceeds a column's scale, and that is how most figures actually
     * land — nobody writes round() in an INSERT. If the implicit cast used a
     * different rule, every stored amount would disagree with the one the
     * application computed.
     */
    for (const [value] of BOUNDARY) {
      const cast = await withGlobal((tx) =>
        scalarOn<string>(tx, 'select ($1::numeric(19,4))::text', [value]),
      )
      const ours = new FinDecimal(value).toDecimalPlaces(4, Rounding.HALF_UP).toFixed(4)

      // Compared as STRINGS. An earlier version of this compared
      // Number(cast) to Number(ours) — coercing both sides through a binary
      // float inside the test whose entire purpose is to prove exact decimal
      // agreement. A disagreement in the fifth decimal would have coerced
      // away and passed.
      expect(cast, `implicit cast of ${value} into numeric(19,4)`).toBe(ours)
    }
  })

  it('agrees on the modulo operator', async () => {
    // ADR-0014 sets modulo: ROUND_DOWN specifically so .mod() matches SQL %.
    // Under ROUND_HALF_UP, 11 mod 3 is -1 — a negative remainder from
    // positive operands, which would post a wrong-signed allocation residual.
    for (const [a, b] of [
      [11, 3],
      [5, 3],
      [10, 3],
      [100, 7],
    ] as const) {
      const sql = await withGlobal((tx) =>
        scalarOn<string>(tx, 'select ($1::numeric % $2::numeric)::text', [a, b]),
      )
      // String comparison again — see the note above.
      expect(new FinDecimal(a).mod(b).toString(), `${a} % ${b}`).toBe(sql)
    }
  })

  it('agrees on Golden Scenario A’s weighted average', async () => {
    // The figure the constitution publishes, computed on both engines.
    const ours = UnitCost.weightedAverage(Money.from('13000'), Quantity.from('150'))

    const theirs = await withGlobal((tx) =>
      scalarOn<string>(tx, 'select round(13000::numeric / 150::numeric, 6)::text'),
    )

    expect(UnitCost.serialize(ours)).toBe('86.666667')
    expect(theirs).toBe('86.666667')
    expect(UnitCost.serialize(ours)).toBe(theirs)
  })
})
