# ADR-0014: decimal.js as the single decimal implementation

**Status:** Accepted
**Accepted:** 2026-09-24, by the Product Owner, on the guardian evidence recorded in the Signatures block below
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

**`NaN` must also be rejected at the database.** NON_NEGOTIABLES §2 requires the balance check in three places, one of them a database constraint. `nan.eq(nan)` is `false` in TypeScript, so the posting engine rejects — but `nan.toFixed(4)` is the string `"NaN"`, PostgreSQL `numeric` accepts `'NaN'`, and PostgreSQL treats `NaN = NaN` as **true**. A journal entry composed entirely of NaN would satisfy a database-level `SUM(debit) = SUM(credit)` check. Every monetary column therefore carries a non-NaN constraint, written in the migration alongside its precision:

```sql
CHECK (col IS NULL OR col <> 'NaN'::numeric)
```

**Note the form. `col = col` does NOT work and must not be used.** That is the usual idiom, and it relies on IEEE 754's `NaN ≠ NaN`; PostgreSQL's `numeric` deliberately breaks that so NaN can be indexed, grouped and sorted, so `col = col` is TRUE for NaN and the constraint **accepts** it. An earlier version of this line published the broken form here, in the section a migration author actually reads, with the correction fifty lines below in a compliance appendix. Verified against the running engine both ways, and `database/tests/numeric-finite.spec.ts` asserts that its matcher rejects the broken idiom, so a Wave-2 migration writing `col = col` fails CI rather than shipping a control that enforces nothing.

The scale is load-bearing too, and for a different reason: `numeric(19,4)` cannot hold an infinite value, so **the scale is what refuses `'Infinity'`, not this constraint.** An unscaled `numeric` column would satisfy every rule in the repository today and accept `'Infinity'`. Requiring `numeric` columns to be scaled is owed with the first monetary column — see the deferrals.

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

Every bullet below states what enforces it and, where a mechanism does not exist, says so. An unimplemented claim in a LEVEL 1 record is worse than an absent one: the next reviewer trusts it.

### Enforced, with the mechanism named

- **`decimal.js` is importable only from `packages/validation`.** Two mechanisms, deliberately: `.dependency-cruiser.cjs` `one-decimal-library` matches `^node_modules/(decimal\.js|decimal\.js-light|big\.js|bignumber\.js)/`, which also catches a subpath import like `decimal.js/decimal.mjs`. Quoted exactly as committed — an earlier version of this line omitted `decimal.js-light`, and a reader checking coverage against the ADR would have concluded it was unguarded; and `eslint.config.mjs` `no-restricted-imports`, repo-wide including `tests/`. Negative control: `tests/security/lint-boundaries.spec.ts`.
- **Non-half-up rounding modes are visible, not forbidden.** `Rounding.DOWN` and `Rounding.UP` are exported and accepted by `round()` and `divide()`; the defaults are half-up and nothing mechanically prevents another mode. That per-operation visibility is why decimal.js was chosen over big.js. The standing rule, recorded here because no lint rule expresses it: **any non-half-up mode applied to a `Money` or `UnitCost` value must be written down in `docs/posting-rules/` before it is used**, and is rejected at review otherwise.
- **`.set(` on the exported constructor is forbidden.** `eslint.config.mjs`, matching the identifier allowlist `/^(FinDecimal|Decimal|Big|BigNumber|D|M)$/` — see the correction below about what that does and does not cover.
- **The constructor is frozen** — `.set()` throws `TypeError`, direct assignment throws (the module is ESM, so the write is in strict mode and fails loudly rather than silently), and `toFixed` is pinned with a non-writable, non-configurable descriptor. All three asserted in `packages/validation/src/money.test.ts`, the descriptor as a descriptor and the throw as behaviour.

  The citation previously read `decimal.test.ts`, which does not exist, and the second and third clauses had no test at all — the code was right and the claim was unearned. Both are now covered, along with a test asserting what is **not** frozen: the rest of the prototype stays writable, which is the narrowing in the corrections below made checkable rather than merely stated.
- **Modulo carries the dividend's sign.** `11 mod 3 → 2`, `-11 mod 3 → -2`, `11 mod -3 → 2`, `-11 mod -3 → -2` — all four combinations, in both `money.test.ts` and the cross-engine table, matching PostgreSQL `%` and JavaScript `%`.

  This bullet previously claimed all four while **every assertion used a positive dividend** — and its own next sentence said the negative dividend is the only case that carries the property. The misconfiguration was still detected, because `11 mod 3` gives `-1` under half-up, so the detector was live and the *coverage claim* was what was false. A wrong-signed allocation residual is the failure `modulo: ROUND_DOWN` exists to prevent: apportioning a credit note must leave a negative residual to post against a negative total, and under half-up the sign inverts on exactly those inputs — wrong in the direction that still lets the containing entry balance.
- **Rounding boundary table** at scales 2, 4 and 6, string inputs only, including a negative case asserting `Money.from(0.615)` is rejected.
- **Cross-engine test:** the same table against `SELECT round(v::numeric, s)`, compared as **strings** — an earlier version compared `Number(...)` of both sides, which is float coercion inside an exact-decimal test. It also exercises `toFixed()` with **no mode argument**, so it resolves the constructor's configured rounding; flipping that default to half-even now fails in four places.
- **Non-finite values are rejected at construction.** `Amount` refuses `NaN` and `±Infinity`, and `fixedOrThrow` refuses them again at the boundary. `money.test.ts`.
- **Every `numeric` column must carry a non-NaN `CHECK`.** `database/tests/numeric-finite.spec.ts`, catalog-driven. Vacuous today — no `numeric` column exists — and fires on the first monetary column.

  **The required form is `CHECK (col IS NULL OR col <> 'NaN'::numeric)`, NOT `col = col`.** The usual idiom relies on IEEE 754's `NaN ≠ NaN`; PostgreSQL's `numeric` deliberately breaks that so NaN can be indexed, so `col = col` is TRUE for NaN and the constraint **accepts** it. Verified against the running engine, both forms. The test's matcher asserts it rejects the broken idiom, so the dormant rule is dormant rather than useless.
- **Serialisation** yields a fixed-scale string, never a number and never exponential notation.

### Corrected — these claimed more than the mechanism does

- **"Any other decimal library in any `package.json` fails the dependency audit."** Nothing scans `package.json` files. What exists is the import-level enforcement above, and `npm run depcruise` is scoped to `apps packages modules`, so it does not cross `tests/` or `database/`. The undeclared-transitive half is moot: `decimal.js` is now declared in `packages/validation/package.json`.
- **"…tests included"** for the unconfigured global. `eslint.config.mjs` turns `no-restricted-imports` **off for all of `packages/validation`**, and `money.test.ts` imports the raw global and calls `Decimal.set()` on it. The exemption is the clone site *and its own test file*, which is what the config implements.
- **"under any local binding name."** It is an identifier allowlist. `import { FinDecimal as Dec2 }` followed by `Dec2.set(…)` is not matched. Stated accurately rather than aspirationally.
- **CI job name.** The job is `tests`, not `database integration`.
- **The freeze is narrower than "no test or dependency can alter rounding."** `.set()` throws and `toFixed` is pinned. The remaining prototype methods are writable, `FinDecimal.clone()` returns an unfrozen constructor, and `Amount.value` exposes the underlying decimal. Those are deliberate-act paths, not accidents, and the claim now says so.

### Deferred, with a reason

- ~~**Property-based generation over `Money.from`'s rejections.**~~ **CLOSED, 2026-09-24.** The Product Owner adopted `fast-check`: *"Adopt fast-check now: security-review and pin it, then close D5 with property tests for money parsing, finite-value rejection, scale, and rounding boundaries."*

  **Security review, before adoption.** `fast-check@4.10.2`, MIT, one transitive dependency — `pure-rand@8.4.2`, MIT, itself dependency-free. Pinned exactly (`--save-exact`), dev-only, declared in `packages/validation`'s own devDependencies as well as the root so the workspace that uses it says so. `npm audit` before and after: the same two advisories, both the pre-existing `postcss`-via-`next` chain recorded as [GAP-002](../COMPLIANCE_GAPS.md). **It introduced nothing.**

  **`packages/validation/src/money.properties.test.ts`** — the four areas asked for, in four blocks. The rounding oracle is written in **BigInt string arithmetic, independent of decimal.js**: if both were decimal.js the test would assert only that the library agrees with itself. The oracle is itself checked against this ADR's hand-computed boundary table before anything trusts it.

  What the properties add over the `it.each` tables is the cases nobody thought of — order-independent summation across shuffled arrays, `round(-x) = -round(x)` at every scale, and every kind accepting its own scale while rejecting one digit more.

  **They found something on the first run**, and it was the generator: five properties failed because it emitted `00` and `007`, which `DECIMAL_NOTATION` rejects. That rejection is deliberate — `^-?(?:0|[1-9]\d*)(?:\.\d+)?$` keeps one value to one spelling and is why `0x1f` cannot arrive as 31 rupees. The generator was corrected. Recorded because the opposite conclusion, loosening the regex to make a test pass, is the easy one to reach at speed and would have widened an input filter that exists to keep hexadecimal out of a ledger.
- **A `numeric` round-trip integration test, and the negative type test.** Both need a `numeric` column, and migrations 001–004 create none. **Deferred to the wave that adds the first monetary column**, where they become writable and non-vacuous.
- **A rule requiring every `numeric` column to be SCALED.** `database/tests/schema.spec.ts` forbids `real`, `double precision`, `money` and `float`; nothing requires `numeric` to carry precision and scale. A bare `numeric amount` satisfies every rule in the repository and accepts `'Infinity'`, which the non-NaN CHECK does not stop — the scale is what stops it. **Owed with the first monetary column**, in the same migration.
- **`Money.serialize(x)` with a defaulted scale is a second, undeclared rounding boundary.** `toJSON()` and `toString()` *throw* on a value carrying more decimals than its scale, deliberately, because an implicit `toFixed` on the way out is the "rounded twice" failure ADR-0011 forbids. But `serialize: (a, toScale = scale) => a.value.toFixed(toScale)` rounds **silently**, and with the default argument no scale was explicitly requested — so `260.000001` throws through `toJSON()` and becomes `"260.0000"` through `serialize(x)`. The justification in the code, that an explicitly requested scale is a documented boundary, holds for `serialize(x, 2)` and not for `serialize(x)`. **Resolve before the posting engine**, by requiring the argument or by recording the kind's own scale as a documented boundary — that is where a full-precision intermediate first meets a serialiser.
- **A lint rule forbidding float egress** — `Number.prototype.toFixed`, `.toNumber()`, `Number()` on a decimal receiver outside `packages/validation`. It does not exist. The live path is `Amount.value`, a public field holding the raw decimal; `Money.from('1').value.toNumber()` compiles today.

  **Deferred in favour of the cheaper fix, and that fix is a GATE rather than an intention.** Making `Amount.value` internal closes the whole class and costs nothing today, because nothing outside `packages/validation` consumes an `Amount`.

  > **BLOCKING PRECONDITION on the Wave 2 posting-engine contract: `Amount.value` becomes internal before any code outside `packages/validation` consumes an `Amount`.**

  Written as a gate because a preference slips, and the first module to read `.value` establishes it as a supported access path — after which closing it is a breaking change to every caller rather than a one-line edit. This wording replaces "recorded as the next change to this package", which was a preference with no gate attached.

## Signatures

`Deciders: Product Owner, Architecture Guardian, Accounting Guardian`. All three are required, recorded as separate dated lines rather than a combined approval so that an outstanding one stays visible.

| | |
|---|---|
| **Architecture Guardian** | ✅ **ACCEPTED**, 2026-09-23. Three citations corrected: the freeze assertion lives in `packages/validation/src/money.test.ts`, not a `decimal.test.ts` that does not exist; direct assignment and the `toFixed` descriptor pin are now asserted rather than merely implemented; the `one-decimal-library` rule is quoted as committed, including `decimal.js-light`. |
| **Accounting Guardian** | ✅ **SIGNED** — see the line below. Refused first, over three findings; signed after all three landed and were independently re-verified. |
| **Product Owner** | ✅ **SIGNED**, 2026-09-24 — see below |

> Accounting Guardian — Accounting Domain Guardian (FinSoft), 2026-09-23 — signed for half-up rounding, modulo sign and non-finite rejection, all recomputed independently; the database non-NaN CHECK is dormant until the first numeric column in Wave 2, and Amount.value must be internal before any code outside packages/validation consumes an Amount.

**What the refusal caught**, recorded because the findings are more useful than the outcome:

1. **The normative Decision section published the broken constraint form.** It read `CHECK (col IS NULL OR col = col)` — the exact idiom this document's own Compliance section and `database/tests/numeric-finite.spec.ts` prove **accepts** NaN — with the correction fifty lines below in an appendix. The Decision section is what a migration author reads. A Wave-2 migration would have written a control that enforces nothing at the moment the first monetary column appears.
2. **A coverage claim that was false.** The modulo bullet claimed all four sign combinations were asserted; every assertion used a positive dividend, while the same bullet's next sentence said the negative dividend is the only case that carries the property. The detector was live — `11 mod 3` gives `-1` under half-up — so what was false was the claim, not the control. Fixed by writing the tests rather than narrowing the claim.
3. **A gate recorded as a preference.** The float-egress closure read "the next change to this package". It is now a blocking precondition on the Wave 2 posting-engine contract.

**Two obligations in that signature line come due in Wave 2, at different moments.** The dormant `CHECK` fires when the first monetary column is written; the `Amount.value` gate fires when the first module imports `Money`. Likely different tickets. Both are in the deferrals above.

> Product Owner — 2026-09-24 — "Accept ADR-0013, ADR-0014, ADR-0016, and ADR-0019 after the PO signs each dated signature block. Guardian evidence is present; no financial invariant violation was found."

The last box now carries a date, so the status is **Accepted**.

**D5 is no longer deferred.** The same decision adopted `fast-check`: *"Adopt fast-check now: security-review and pin it, then close D5 with property tests for money parsing, finite-value rejection, scale, and rounding boundaries."* See the deferrals above for what replaced it.

The two obligations in the Accounting Guardian's signature line still come due in Wave 2, at different moments: the dormant `CHECK` fires when the first monetary column is written, the `Amount.value` gate when the first module imports `Money`.

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
inventory value    13000.0000 − 3466.6667        → Rs 9,533.33
                                = 9533.3333
closing quantity   150 − 40 = 110
```

All four hand-computed figures reproduce exactly.

**The inventory value is the CARRIED value, and this line was previously wrong.** It read `110 × avg → 9533.3334` — the product of a quantity and a rounded average, which is the recomputation [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) §7 forbids and rule 16 has always forbidden. The two figures differ by Rs 0.0001 and both present as `Rs 9,533.33` at two decimals, which is why it survived.

The repository already agreed with ADR-0015 rather than with this document: `tests/accounting/golden/scenario-a.json` files `9533.3334` under `forbiddenRecomputation`, and `golden-scenarios.spec.ts` asserts the carried value is `9533.3333` and that the recomputation is **not equal** to it. An ADR must not publish, as a verified figure, the number three test files call forbidden.

## Depends on ADR-0015

This section previously recorded the Invariant 10 residual as an open question requiring a ruling. **The ruling was raised**: [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) establishes that the inventory valuation is the carried value, never `quantity × average_cost`, and `tests/accounting/golden/` now states which figure is asserted and where the residual posts — the two things this section asked for.

The dependency that remains is a status one, and it is stated plainly rather than left implicit:

- ADR-0014 cannot be Accepted while publishing a figure ADR-0015 forbids. That is corrected above.
- ADR-0015 is itself `Proposed` and requires a LEVEL 0 amendment to rule 16 before it can be Accepted.

So the two may move together, or ADR-0014 may move first now that its own figure is right. What must not happen is ADR-0014 being Accepted with the old line intact, which would put a LEVEL 1 record in conflict with the golden suite.
