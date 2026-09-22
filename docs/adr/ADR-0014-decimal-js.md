# ADR-0014: decimal.js as the single decimal implementation

**Status:** Proposed
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

[ADR-0011](ADR-0011-money-representation.md) settled money representation: `numeric(19,4)` and `numeric(19,6)` in PostgreSQL, strings in JSON, branded `Money` / `UnitCost` / `Quantity` types, half-up rounding applied once. It settled everything except one thing, which it left as a choice:

> A decimal library — `decimal.js` or `big.js`, one of them, chosen once in `packages/validation` and re-exported — is the only arithmetic path.

That sentence has sat unresolved since. It cannot stay unresolved: a library is not an implementation detail here, because its default rounding mode, its tie-breaking behaviour, its precision ceiling, its modulo semantics and its `toString()` format each decide whether the figures the system files with the FBR are the figures the accountant computed. Two agents picking differently in two packages would produce a trial balance that disagrees with itself.

Every behavioural claim in this ADR was executed against `decimal.js@10.6.0` before acceptance.

## Decision

### decimal.js, configured once, in `packages/validation`

`decimal.js` is the only decimal library in the repository. It is a dependency of `packages/validation` and nowhere else, as ADR-0011 already requires.

It is chosen over big.js on two properties that matter to a ledger and that big.js does not offer:

1. **Clone isolation.** A configured constructor can be created with `Decimal.clone()`, independent of global state (see below). big.js configures through mutable statics on the single exported constructor.
2. **Per-operation rounding modes.** `toDecimalPlaces(scale, mode)` takes the mode explicitly at each call site, so ADR-0011's "rounding applied once, half-up" is visible in the code rather than inherited from ambient configuration.

A secondary benefit is that [AGENTS.md](../../AGENTS.md) anti-pattern 2 already writes its example in decimal.js API — `Decimal(qty).times(price)` and `.toDecimalPlaces(4, ROUND_HALF_UP)` — so agents imitating the operating rules produce compliant code by default.

### The configured constructor is a frozen clone, never the global

decimal.js exposes global mutable configuration through `Decimal.set()`. A call to it anywhere — a test, a seed script, a transitive dependency — silently changes the arithmetic of the entire process. That is an unacceptable failure mode for a ledger, because it is invisible and retroactive.

`packages/validation` therefore constructs a **cloned constructor** and the global `Decimal` is never used:

```
precision   50        significant digits; see the ceiling computation below
rounding    ROUND_HALF_UP
modulo      ROUND_DOWN
toExpNeg    -9e15     toString() must never yield exponential notation
toExpPos     9e15     because money crosses boundaries as a string
```

A clone is **not** immutable by default — `M.set({ rounding: ROUND_DOWN })` silently repoints it, and `2.5` then rounds to `2`. The exported constructor is therefore `Object.freeze`d at the clone site, which makes `.set()` throw a `TypeError` while leaving arithmetic intact. Configuration exists at exactly one line in the repository.

### `modulo: ROUND_DOWN`, because half-up modulo is wrong

decimal.js computes `mod` using a quotient rounded by the `modulo` setting. Under `ROUND_HALF_UP` this yields **negative remainders from positive operands**:

```
             modulo: ROUND_HALF_UP    modulo: ROUND_DOWN    PostgreSQL %    JS %
11 mod 3              -1                       2                 2            2
 5 mod 3              -1                       2                 2            2
10 mod 3               1                       1                 1            1
```

It disagrees intermittently, which is the worst possible failure shape. ADR-0011 requires allocation residuals to be posted to the rounding account "to the paisa"; an apportionment routine using `.mod()` under half-up would post a wrong-signed residual for roughly half its inputs, and every layer above it would still balance. `ROUND_DOWN` is truncated division, matching both PostgreSQL `%` and JavaScript `%`.

### Half-up means away from zero, and this matches PostgreSQL `numeric`

decimal.js `ROUND_HALF_UP` rounds to the nearest neighbour and, when equidistant, away from zero: `2.5` to `3`, `-2.5` to `-3`. PostgreSQL's `round()` on `numeric` breaks ties the same way.

This symmetry is the property that matters, and it matters in a narrower place than it might appear. Under [ADR-0006](ADR-0006-immutable-posted-transactions.md) a reversal negates *stored, already-rounded* amounts with equal magnitudes and opposite signs — no second rounding occurs, so tie-breaking is not engaged in the GL leg at all. Likewise [ADR-0007](ADR-0007-weighted-average-costing.md) re-enters a sales return at the average recorded on the original outward movement, reproducing the same positive-signed computation.

Where `round(−x) = −round(x)` genuinely binds is a **directly computed negative amount**: a credit note line, a negative inventory adjustment, a negative discount. There the value is rounded on its own, and an asymmetric tie rule would produce a magnitude that differs from its positive twin by a paisa.

The asymmetric nearest-modes are `ROUND_HALF_CEIL` and `ROUND_HALF_FLOOR` — and those alone. **Banker's rounding is not among them:** half-even is an odd function (`2.5 → 2`, `−2.5 → −2`), so it is symmetric about zero and would not produce a reversal residual. It is nonetheless forbidden here, because it disagrees with PostgreSQL `numeric` on ties — `round(2.5, 0)` gives `2` in half-even and `3` in PostgreSQL — and a figure rounded in TypeScript must equal the same figure rounded in SQL wherever a report aggregates in the database. Half-even is the realistic misconfiguration, arriving as someone "correcting" the statistical bias ADR-0011 accepted; what catches it is the golden boundary table and the cross-engine test, not the invariant suite.

*(This symmetry holds for `numeric` only. PostgreSQL's `round()` on `double precision` is half-to-even and platform-dependent — a reason beyond ADR-0011's to keep floats out of the schema entirely.)*

### `precision: 50`, set by multiplication at the schema ceiling

The binding constraint is not division. decimal.js `precision` caps significant digits on *every* operation, and the worst case is multiplication at the `numeric(19,6)` limits:

```
9,999,999,999,999.999999 × 9,999,999,999,999.999999
  = 9.9999999999999999980000000000000000001e+25     38 significant digits, exact at precision 40
  = 9.999999999999999998e+25                        LOSSY at precision 20 (the default)

weighted-average numerator (that product, twice, summed)   39 significant digits
```

40 is sufficient for every documented chain but leaves one digit of headroom at the absolute ceiling. 50 costs nothing on any path that matters — posting is dominated by database round-trips, not arithmetic — and removes the question. This computation is recorded so that a future agent does not "optimise" the value back towards the default on the strength of a division-only rationale.

Precision is working headroom, not an output format. No value is persisted or serialised at 50 digits: `Money.round` is applied once, at the documented scale, per ADR-0011. Division never has an implicit scale — `Money.divide` requires scale and rounding arguments.

### The constructor is not a validation boundary; `Money.from` is

decimal.js accepts several inputs that must never become money. Verified:

```
new D(0.1 + 0.2)   → 0.30000000000000004     a JS number, silently accepted
new D('0x1f')      → 31                       hexadecimal string
new D('0b101')     → 5                        binary string
new D('0o17')      → 15                       octal string
new D(NaN)         → NaN
new D(Infinity)    → Infinity
new D(null)        → throws                   (already handled by the library)
new D(undefined)   → throws
new D('')          → throws
```

`Money.from` therefore rejects, by throwing: any `typeof v === 'number'` input; any string that is not decimal notation, which excludes the `0x` / `0b` / `0o` forms; `NaN` and `±Infinity`; and any input carrying more decimal places than the target scale. The last of these is a deliberate refinement of ADR-0011 rather than a library choice, and it has a consequence worth stating: a SQL-side aggregate or division returning more decimals than its target scale will throw at runtime in a report path rather than silently truncating. That is the intended behaviour — rounding is explicit or it does not happen.

**`NaN` must also be rejected at the database.** NON_NEGOTIABLES §2 requires the balance check in three places, one of them a database constraint. `nan.eq(nan)` is `false` in TypeScript, so the posting engine rejects — but `nan.toFixed(4)` is the string `"NaN"`, PostgreSQL `numeric` accepts `'NaN'`, and PostgreSQL treats `NaN = NaN` as **true**. A journal entry composed entirely of NaN would satisfy a database-level `SUM(debit) = SUM(credit)` check. Every monetary column therefore carries a `CHECK (col IS NULL OR col = col)` style non-NaN constraint, written in the migration alongside its precision.

### Serialisation is fixed-scale

Money crosses HTTP, the outbox and export files as a string with an explicit scale, produced by `Decimal.prototype.toFixed(scale)` — which is exact and honours the configured rounding mode. `toJSON` on the branded types emits that fixed-scale string, so an accidental `JSON.stringify` cannot emit a number or an exponential form.

This is a different method from `Number.prototype.toFixed`, which operates on an already-lost double and is forbidden. A lint rule written against the bare token `toFixed(` would forbid the one method this ADR requires; the rule must be written against the receiver's type.

## Consequences

### Positive

- Configuration lives at one frozen line. No test, seed script or dependency can alter rounding for the process, and attempting it throws rather than succeeding quietly.
- Tie-breaking matches PostgreSQL `numeric`, so a figure rounded in TypeScript and the same figure rounded in SQL agree.
- Explicit per-operation rounding modes make `Money.round` testable against a golden boundary table, as ADR-0011 requires.
- The code matches the examples in [AGENTS.md](../../AGENTS.md), so the most-read document and the codebase agree.

### Negative / accepted costs

- decimal.js is larger than big.js (roughly 32 KB minified against roughly 8 KB) and exposes a far wider API, including trigonometric and logarithmic methods with no business here. The surface is constrained by the branded types, not by the library.
- The constructor is permissive where big.js would throw — numbers, radix-prefixed strings, `NaN`, `±Infinity`. Validation is therefore our boundary's job. This is the real cost of the choice, and it is bought back by `Money.from`, the database non-NaN constraint, and property-based tests, not by the library.
- `precision: 50` is slower than the default for long chains. Not on any path where it is measurable.

## Alternatives considered

**big.js.** Rejected, narrowly. It is smaller, its API is small enough to hold in your head, and it throws on garbage input instead of producing `NaN` or parsing hexadecimal — a genuine advantage this ADR has to pay for. It was rejected because it configures through mutable statics on its single exported constructor, with no clone facility, so the isolation property above is unavailable; and because per-operation rounding modes are not part of its API, making ADR-0011's "rounded once, half-up" ambient rather than visible. Its default division precision (`Big.DP = 20`) would also need raising, so the configuration burden is not lower.

**bignumber.js.** Rejected. Same author and near-identical API to decimal.js, occupying a middle ground with no advantage over either neighbour here.

**Native `BigInt` with fixed-point scaling.** Rejected. Exact and fast with no dependency, but every operation carries its scale by convention rather than by type, division requires hand-written rounding, and a single misplaced scale factor is a silent off-by-10,000. The branded types would be doing all the work the library should do.

**`Number.prototype.toFixed` / `Intl.NumberFormat` for rounding.** Rejected, and forbidden. Both operate on a binary float that has already lost the value: `(0.615).toFixed(2)` returns `"0.61"`, where `new D('0.615').toFixed(2)` returns `"0.62"`.

## Compliance

- Lint rule: `decimal.js` is importable only from `packages/validation`. Any other decimal library in any `package.json` fails the dependency audit — including an **undeclared transitive** one, since `decimal.js` is currently resolved in `node_modules` without being declared.
- Lint rule: the unconfigured global from `decimal.js` may not be imported anywhere outside the clone site, tests included.
- Lint rule: `.set(` on the exported constructor is forbidden repository-wide, under any local binding name. A rule matching only the literal `Decimal.set(` would miss `Money.set(` and `D.set(`.
- Unit test: the exported constructor is frozen — `.set()` throws `TypeError` — and reports `precision: 50`, `rounding: ROUND_HALF_UP`, `modulo: ROUND_DOWN`, `toExpNeg: -9e15`, `toExpPos: 9e15`.
- Modulo test: `11 mod 3 === 2` and `5 mod 3 === 2`, matching PostgreSQL `%` and JavaScript `%`. Catches a reverted `modulo` setting.
- **Rounding test (golden boundary table):** `Money.round` asserted at scales 2, 4 and 6 across positive, negative and exact-half cases — `2.5`, `-2.5`, `0.615`, `-0.615`, `2.675` — with **string inputs only**. A table written with numeric literals passes while proving nothing about float ingress, which is the failure it exists to detect. Includes a negative case asserting `Money.from(0.615)` (a number) is rejected. This table, not Invariant 6, is what catches a rounding mode changed to half-even.
- **Cross-engine test:** for the same table, `Money.round(v, s)` equals `SELECT round(v::numeric, s)`. Runs in the `database integration` CI job against the PostgreSQL service from the Wave 0 Docker stack ([IMPLEMENTATION.md §13](../IMPLEMENTATION.md)). Extends to implicit cast rounding on assignment into `numeric(19,4)` and to the `%` operator, not only `round()`.
- Boundary test: `Money.from` rejects — by throwing — JS numbers, `0x`/`0b`/`0o` strings, `NaN`, `±Infinity`, and over-scale input. Property-based over a generated sample.
- Schema test: every monetary column carries a non-NaN `CHECK` constraint. PostgreSQL accepts `'NaN'::numeric` and treats `NaN = NaN` as true, so without it the database-level balance check in NON_NEGOTIABLES §2 is satisfiable by an all-NaN entry.
- Serialisation test: `JSON.stringify` of any branded money value yields a fixed-scale string, never a number and never exponential notation.
- Lint rule: `Number.prototype.toFixed` is forbidden; `Decimal.prototype.toFixed` is required for serialisation. The rule is written against the receiver's type, not the bare token.

## Related

- [ADR-0011](ADR-0011-money-representation.md) — the decision this completes; precision, transport, rounding policy and currency
- [ADR-0013](ADR-0013-kysely-and-sql-migrations.md) — how `numeric` reaches TypeScript as a string for `Money.from`, in both directions
- [ADR-0007](ADR-0007-weighted-average-costing.md) — the weighted-average chain; see the note below
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — why reversals do not re-round, narrowing where symmetry binds
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 1 and 6; §2 three-place enforcement; §3 Golden Scenario A; §4 no tolerances
- [../../AGENTS.md](../../AGENTS.md) — anti-pattern 2, whose example this ADR ratifies

## Verification against Golden Scenario A

Executed through this configuration, applying ADR-0011's boundaries (average at 6 dp, COGS at 4 dp on the movement row, presentation at 2 dp):

```
weighted average   13000 / 150  → 86.666667      matches NON_NEGOTIABLES §3
COGS               40 × avg     → 3466.6667      → Rs 3,466.67
revenue            40 × 140     → 5600.0000      → Rs 5,600.00
gross profit       5600 − 3466.6667              → Rs 2,133.33
inventory value    110 × avg    → 9533.3334      → Rs 9,533.33
closing quantity   150 − 40 = 110
```

All four hand-computed figures reproduce exactly.

## Observed — outside this ADR, requires a ruling

The same scenario surfaces a conflict that belongs to [ADR-0007](ADR-0007-weighted-average-costing.md), not here, and is reported rather than fixed per [NON_NEGOTIABLES §4](../NON_NEGOTIABLES.md):

```
inventory ledger valuation   110 × 86.666667 → 4dp  =  9,533.3334
inventory GL balance         13000 − 3466.6667      =  9,533.3333
                                                       -----------
Invariant 10 residual                                      0.0001
```

Both present as `Rs 9,533.33`, so the golden figures stand. But Invariant 10 asserts subledger-to-GL reconciliation exactly, with §4 forbidding tolerances, while ADR-0007's compliance section says "within the documented rounding tolerance". The correct resolution is ADR-0011's rounding account, not a tolerance. ADR-0007 is Accepted and immutable, so this needs a clarifying or superseding ADR before the first inventory posting exists — and `tests/accounting/golden/` must state which figure is asserted and where the residual posts.
