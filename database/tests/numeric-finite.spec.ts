import { withGlobal } from '@finsoft/database'
import { prepareTestDatabase, scalarOn, teardownTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { columns, constraints } from './catalog.ts'

/*
 * Non-finite amounts, closed at the DATABASE as well as at the application.
 *
 * ── The failure being closed ────────────────────────────────────────────
 *
 * PostgreSQL accepts `'NaN'::numeric`. And in PostgreSQL — unlike IEEE 754,
 * unlike JavaScript — `NaN = NaN` is TRUE, and NaN sorts as GREATER than
 * every real number. All three are asserted below against the live engine.
 *
 * Invariant 1 requires Σ debit = Σ credit, enforced in three places
 * (NON_NEGOTIABLES §2). A journal entry whose every line is NaN SATISFIES a
 * database-level `SUM(debit) = SUM(credit)` check. It balances because both
 * sides are not-a-number — passing the control built to catch exactly that.
 *
 * ── The constraint that does NOT work ───────────────────────────────────
 *
 * The usual idiom for this is `CHECK (col IS NULL OR col = col)`, which
 * relies on IEEE 754's NaN ≠ NaN. PostgreSQL's `numeric` deliberately breaks
 * that so NaN can be indexed, grouped and sorted — so `col = col` is TRUE
 * for NaN and the constraint ACCEPTS it.
 *
 * Verified by writing it and inserting NaN: accepted. It is a constraint that
 * looks like a control and is not one. The tests below pin the distinction so
 * nobody "simplifies" the working form back into the broken one.
 *
 * The form that works is `col <> 'NaN'::numeric`, because `NaN <> NaN` is
 * FALSE, so the check fails and the row is refused.
 *
 * ── Why the application guard is not enough ─────────────────────────────
 *
 * `Amount` rejects non-finite values at construction, so no `'NaN'` leaves
 * TypeScript. That closes the application path and nothing else: a migration,
 * an admin script, a psql session, the reconciliation job and any future
 * import all bypass it, and rule 21 contemplates humans with direct access.
 *
 * ── Vacuous today, deliberately ─────────────────────────────────────────
 *
 * There is no `numeric` column in the schema yet, so the catalog rule asserts
 * nothing now and fires on the first monetary column in Wave 2. That is the
 * only moment it can be written without something to retrofit.
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

/**
 * The CHECK shape required on every numeric column.
 *
 * Matches `col <> 'NaN'` in the form PostgreSQL prints it back — the catalog
 * renders the literal as `'NaN'::numeric`.
 */
const FINITE_CHECK = /<>\s*'NaN'/i

/** The broken idiom, kept so the rule can prove it rejects it. */
const BROKEN_IDIOM = /\b(\w+)\s*=\s*\1\b/

describe('PostgreSQL really does behave this way', () => {
  /*
   * Asserted rather than assumed. The whole rule rests on these facts, and a
   * future PostgreSQL changing any of them should surface as a failing test
   * rather than as a constraint quietly enforcing nothing.
   */
  it('accepts NaN into a numeric value', async () => {
    expect(await withGlobal((tx) => scalarOn<string>(tx, "SELECT 'NaN'::numeric::text"))).toBe(
      'NaN',
    )
  })

  it('says NaN = NaN is TRUE, unlike IEEE 754 and unlike JavaScript', async () => {
    const equal = await withGlobal((tx) =>
      scalarOn<boolean>(tx, "SELECT 'NaN'::numeric = 'NaN'::numeric"),
    )
    expect(equal, 'this is what makes SUM(debit) = SUM(credit) pass for an all-NaN entry').toBe(
      true,
    )

    /*
     * The same `x = x` test, in JavaScript, where it gives the OPPOSITE
     * answer. Written through a function rather than as a literal comparison
     * because `use-isnan` correctly forbids the literal form — which is
     * itself the point: the idiom is well known enough to have a lint rule,
     * and that is exactly why someone reaches for it against a numeric
     * column where it does not work.
     */
    const selfEqual = (v: number): boolean => v === v
    expect(selfEqual(Number.NaN), 'JavaScript disagrees, which is why the idiom misleads').toBe(
      false,
    )
    expect(selfEqual(1.5), 'and agrees for every ordinary value').toBe(true)
  })

  it('sorts NaN as greater than every real number', async () => {
    expect(
      await withGlobal((tx) => scalarOn<boolean>(tx, "SELECT 'NaN'::numeric > 999999999")),
    ).toBe(true)
  })
})

describe('an all-NaN entry balances, which is the whole problem', () => {
  it('passes SUM(debit) = SUM(credit)', async () => {
    /*
     * A VALUES list rather than a table: finsoft_app has no TEMP privilege,
     * correctly — least privilege, and nothing in the application creates
     * tables. The engine's arithmetic is identical either way.
     */
    const balanced = await withGlobal((tx) =>
      scalarOn<boolean>(
        tx,
        `SELECT sum(d) = sum(c)
           FROM (VALUES ('NaN'::numeric, 'NaN'::numeric),
                        ('NaN'::numeric, 'NaN'::numeric)) AS t(d, c)`,
      ),
    )

    expect(
      balanced,
      'an entry of NaN lines satisfies the balance check — this is why a column constraint is needed',
    ).toBe(true)
  })

  it('and a real unbalanced entry does NOT pass, so the check is otherwise sound', async () => {
    const balanced = await withGlobal((tx) =>
      scalarOn<boolean>(
        tx,
        `SELECT sum(d) = sum(c)
           FROM (VALUES (100::numeric, 100::numeric),
                        (50::numeric,  49::numeric)) AS t(d, c)`,
      ),
    )
    expect(balanced).toBe(false)
  })
})

describe('the constraint shape', () => {
  /*
   * Evaluated as expressions rather than by creating a table, for the TEMP
   * reason above. The expression is exactly what a CHECK evaluates, so a
   * `false` here is a row refused there.
   */
  const evaluate = (expr: string): Promise<boolean | undefined> =>
    withGlobal((tx) => scalarOn<boolean>(tx, `SELECT ${expr}`))

  it('REJECTS the idiom that looks right and does nothing', async () => {
    /*
     * `col = col` for NaN. In IEEE 754 this is false and the row is refused;
     * in PostgreSQL numeric it is TRUE and the row is accepted.
     */
    expect(
      await evaluate("('NaN'::numeric IS NULL OR 'NaN'::numeric = 'NaN'::numeric)"),
      'the col = col idiom ACCEPTS NaN in PostgreSQL — it is not a control',
    ).toBe(true)
  })

  it('the required form refuses NaN', async () => {
    expect(await evaluate("('NaN'::numeric IS NULL OR 'NaN'::numeric <> 'NaN'::numeric)")).toBe(
      false,
    )
  })

  it.each(['0', '1.5', '-1234.5678', '9999999999999.9999'])(
    'the required form accepts %s',
    async (value) => {
      expect(
        await evaluate(`('${value}'::numeric IS NULL OR '${value}'::numeric <> 'NaN'::numeric)`),
      ).toBe(true)
    },
  )

  it('the required form accepts NULL', async () => {
    expect(await evaluate("(NULL::numeric IS NULL OR NULL::numeric <> 'NaN'::numeric)")).toBe(true)
  })

  it('Infinity is refused by the scale, not by this constraint', async () => {
    /*
     * Recorded because the reason differs. `numeric(19,4)` cannot hold an
     * infinite value — "A field with precision 19, scale 4 cannot hold an
     * infinite value" — so scaled money columns are covered without a second
     * clause. An UNSCALED `numeric` column would not be, and would need one.
     */
    expect(
      await evaluate("('Infinity'::numeric <> 'NaN'::numeric)"),
      'Infinity passes the NaN check; the scale is what stops it',
    ).toBe(true)
  })
})

describe('every numeric column must carry the finite CHECK', () => {
  it('has the constraint on each one (vacuous until the first is added)', async () => {
    const numericColumns = (await columns()).filter((c) => c.data_type === 'numeric')
    const checks = (await constraints()).filter((c) => c.contype === 'c')

    const unguarded = numericColumns
      .filter(
        (col) =>
          !checks.some(
            (c) =>
              c.table_name === col.table_name &&
              c.definition.includes(col.column_name) &&
              FINITE_CHECK.test(c.definition),
          ),
      )
      .map((c) => `${c.table_name}.${c.column_name}`)

    expect(
      unguarded,
      "ADR-0014 / Invariant 1: every numeric column needs CHECK (col IS NULL OR col <> 'NaN'). " +
        'PostgreSQL accepts NaN and treats NaN = NaN as TRUE, so without it an all-NaN entry ' +
        'satisfies SUM(debit) = SUM(credit) and balances nothing. Note the form: `col = col` ' +
        'is the usual idiom and it does NOT work here. The Amount guard covers TypeScript ' +
        'only — not a migration, an admin script, psql, or an import.',
    ).toEqual([])
  })

  it('the matcher recognises the working form and rejects the broken one', async () => {
    /*
     * A catalog rule over an empty set passes whatever it asserts. This proves
     * the matcher discriminates, so the rule above is dormant rather than
     * broken — and specifically that it will NOT accept the idiom that looks
     * right and enforces nothing.
     */
    expect(FINITE_CHECK.test(`CHECK (((amount IS NULL) OR (amount <> 'NaN'::numeric)))`)).toBe(true)
    expect(
      FINITE_CHECK.test('CHECK (((amount IS NULL) OR (amount = amount)))'),
      'the broken idiom must not satisfy the rule',
    ).toBe(false)
    expect(FINITE_CHECK.test('CHECK ((total_debit = total_credit))')).toBe(false)
    expect(FINITE_CHECK.test('CHECK ((attempts >= 0))')).toBe(false)

    // And the broken idiom really is what it looks like, so the comment above
    // is not describing a pattern nobody would write.
    expect(BROKEN_IDIOM.test('CHECK (((amount IS NULL) OR (amount = amount)))')).toBe(true)
  })
})
