# ADR-0011: Money as `numeric` with decimal arithmetic

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

A money value crosses four representations on its way from a form field to a filed return: JavaScript in the browser, JSON over HTTP, TypeScript in the API, and a PostgreSQL column. Each boundary is an opportunity to convert to binary floating point, and binary floating point cannot represent `0.1`:

```
0.1 + 0.2                    = 0.30000000000000004
1000.10 * 3                  = 3000.2999999999997
(0.615).toFixed(2)           = "0.61"     ← not 0.62; the stored value is below .615
JSON.parse('{"a":10000.10}') = 10000.1    ← already a float, before any arithmetic
```

Individually these are fractions of a paisa. In a ledger they are a trial balance that is off by Rs 0.01 with no explicable cause, an invoice whose lines do not sum to its total, and an inventory valuation that drifts from the GL a little more each month. Rule 1 requires `Σ debit = Σ credit` **exactly**, and "exactly" is not a property float arithmetic has.

Rule 6 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) already forbids `float`, `double precision` and JS `number` arithmetic on money. This ADR fixes the precision, the transport format, the library, the rounding rule and the currency posture so two implementations cannot disagree.

## Decision

### Storage

```
amounts                       numeric(19,4)   Rs 1,234,567.8900
unit costs, rates, prices     numeric(19,6)   Rs 86.666667
quantities                    numeric(19,6)   10.500000
percentages (tax, discount)   numeric(9,6)    17.000000  (as a percentage, not a fraction)
exchange rates                numeric(19,6)   1.000000   (PKR base, v1)
```

- **4 decimal places on amounts.** PKR is quoted to 2 places in practice; 4 gives headroom for line-level tax and discount computation without a second rounding step, and still rounds to 2 for presentation and for FBR filing.
- **6 decimal places on unit costs and rates** because they are produced by division — the weighted-average formula in [ADR-0007](ADR-0007-weighted-average-costing.md) divides, and 6 places is what keeps a 150-unit average from visibly drifting.
- **19 total digits** accommodates 15 integer digits, far beyond any plausible PKR balance.
- `numeric` is exact decimal arithmetic in PostgreSQL. `float4`, `float8`, `real`, `double precision` and `money` are **forbidden everywhere in the schema** — `money` included, because its behaviour depends on a server locale setting.
- Every monetary column is accompanied by a currency column, or belongs to a table with a single documented currency recorded in the schema comment (rule 6).

### Transport

**Money is a string in JSON. Never a JSON number.**

```json
{
  "netAmount":   "10000.0000",
  "taxAmount":   "1700.0000",
  "totalAmount": "11700.0000",
  "unitCost":    "86.666667",
  "quantity":    "10.000000",
  "currency":    "PKR"
}
```

`JSON.parse` turns a JSON number into an IEEE-754 double before any application code sees it — the precision is gone before the first line of business logic runs, and no downstream care can recover it. A string survives the boundary intact and is parsed into a decimal deliberately.

This applies to every JSON surface: API responses, request bodies, outbox payloads, queue jobs, export files, webhook bodies and stored `jsonb`. The `before_json`/`after_json` columns in `audit_log` carry money as strings too, so a replayed audit record reproduces the exact value.

Serialisation is centralised: the DTO layer in `packages/shared-types` and the schemas in `packages/validation` define `Money`, `UnitCost` and `Quantity` as branded string types with format validation. Hand-written serialisers are not permitted.

### Computation

A decimal library — `decimal.js` or `big.js`, one of them, chosen once in `packages/validation` and re-exported — is the only arithmetic path.

```
FORBIDDEN                          REQUIRED
a + b  on a money value            Money.add(a, b)
qty * price                        Money.multiply(qty, price)
total / count                      Money.divide(total, count, scale, rounding)
parseFloat(amountString)           Money.from(amountString)
Number(amountString)               Money.from(amountString)
amount.toFixed(2)                  Money.round(amount, 2)          ← half-up
```

`Money`, `UnitCost` and `Quantity` are branded types. A native `+` on one of them does not compile. Where a value legitimately leaves the money domain — a chart axis, a row count — the conversion is explicit and one-way.

Business logic lives in the backend domain layer (rule 19). React never computes a monetary figure; if a number is on screen, the backend produced it. A front-end agent summing line totals in the browser has taken the wrong ticket.

### Rounding

**Half-up, applied once, at a documented boundary.**

```
HALF_UP:   0.5 rounds away from zero      2.345 → 2.35      −2.345 → −2.35
```

Half-up is what Pakistani commercial practice and FBR-facing calculations expect. Banker's rounding (half-even) is statistically nicer and is **not** used, because it produces figures that disagree with a hand-recomputation by an accountant or an FBR reviewer — a correctness dispute is worse than a rounding bias.

"Applied once, at a documented boundary" is the operative part. Each calculation names the single point where its result is rounded, and intermediate values keep full precision:

```
line net      = round(quantity × unitPrice − discount,  4)   ← boundary: per line
line tax      = round(lineNet × taxRate / 100,          4)   ← boundary: per line
invoice total = Σ line net + Σ line tax                      ← no rounding: summing
                                                                 already-rounded values
presentation  = round(amount, 2)                             ← boundary: display / filing
average cost  = round(weighted average formula,         6)   ← boundary: on store (ADR-0007)
COGS          = round(quantity × unitCost,              4)   ← boundary: on movement row
```

Rounding twice — rounding a line to 2 places, then summing, then rounding again — produces a total that differs from the same calculation done once, and is the usual cause of an invoice whose lines do not add up to its total. Every posting rule in `docs/posting-rules/` states its rounding boundary explicitly.

### Rounding differences go to a rounding account

When an allocation cannot divide exactly — apportioning landed cost across lines, splitting a payment across invoices, a tax computation whose parts do not reconstruct the whole — the residual is **posted**, to a designated rounding account in the tenant's chart of accounts:

```
Dr / Cr  <configured rounding account>    the residual, to the paisa
```

It is never silently absorbed into the last line, never dropped, never hidden in a tolerance. A tolerance in an invariant check is explicitly forbidden ([NON_NEGOTIABLES §4](../NON_NEGOTIABLES.md)): if the trial balance does not balance to the paisa, the answer is to find the residual and post it, not to widen the comparison. Every posting to the rounding account is visible in the ledger and reportable, so systematic drift is discoverable rather than absorbed.

### Currency

- **PKR is the base currency.** Only PKR is transacted in v1 ([PRD.md §9](../PRD.md)).
- **The schema is currency-aware from day one.** Every monetary column has an accompanying currency, transactional tables carry `currency_code` plus `exchange_rate numeric(19,6)`, and a base-currency amount alongside the transaction-currency amount. In v1 `currency_code = 'PKR'` and `exchange_rate = 1.000000` on every row.
- Carrying the columns now costs almost nothing. Retrofitting them into a ledger with years of history is a migration project touching every financial table, every report and every posting rule.
- **No multi-currency behaviour is implemented.** No FX revaluation, no realised/unrealised gain accounts, no rate tables, no multi-currency reporting. Endpoints reject a non-PKR `currency_code`. Building that behaviour speculatively is forbidden — the columns are structural preparation, not a feature.

Display follows Pakistani conventions ([PRD.md §5](../PRD.md)): `Rs` prefix, 2 decimals, and thousands grouping in the local convention (`Rs 12,34,567.89` where the tenant's locale setting selects it). Formatting is presentation only and never feeds back into computation.

## Consequences

### Positive

- Exact arithmetic end to end, so `Σ debit = Σ credit` is a statement about equality rather than about tolerance, and golden scenarios can assert exact expected numbers.
- The float class of bug is eliminated at the type level and at the schema level, rather than being found in testing.
- A documented rounding boundary per calculation means two implementations — and an accountant with a calculator — reach the same figure.
- Rounding residuals are visible in the ledger, so systematic drift is discoverable instead of silently absorbed.
- Currency-aware schema keeps multi-currency a feature project later rather than a data migration.

### Negative / accepted costs

- Decimal arithmetic is slower and allocates objects, and every expression is a method call rather than `a + b`. Irrelevant at this volume; measured, not assumed.
- Money as a string means every client must parse deliberately, and branded types add friction at parsing, ORM mapping and chart boundaries.
- Carrying `currency_code` and `exchange_rate` on every transactional table adds columns that are constant in v1 and look like dead weight until the day they are not. An agent may not "simplify" them away.
- Half-up carries a slight upward bias over many roundings versus half-even. Accepted deliberately in favour of agreeing with a hand recomputation.
- A rounding account appears in the chart of accounts and must be explained to accountants who expect differences to vanish.

## Alternatives considered

**Integer minor units (paisa) as `bigint`.** A respectable choice — exact, fast, and unambiguous. Rejected because unit costs and quantities need 6 decimal places, so a single scale factor does not serve both amounts and costs, and mixed scales in integer arithmetic is precisely where scaling bugs live. `numeric` also keeps the database itself able to `SUM` correctly, which matters for reports and for the invariant checks that run in SQL.

**`float8` / `double precision` with careful rounding.** Rejected absolutely by rule 6. "Careful" is not a guarantee, and the errors are not reproducible across operation ordering.

**PostgreSQL `money` type.** Rejected. Fixed at 2 decimal places and locale-dependent, so a server locale change would alter stored semantics.

**JSON numbers with a documented precision contract.** Rejected. `JSON.parse` destroys precision before any contract can be honoured — unenforceable at exactly the point it matters.

**Banker's rounding (half-even).** Rejected. Less biased statistically, but it disagrees with the arithmetic an accountant or an FBR reviewer performs by hand, and defending a rounding convention is worse than accepting a negligible bias.

**Absorbing rounding differences into the largest line.** Rejected. It hides the residual inside a business figure, so the line no longer equals quantity × price and nobody can find where the difference went.

**Full multi-currency in v1.** Rejected as out of scope ([PRD.md §9](../PRD.md)). FX revaluation, realised and unrealised gains and rate sourcing are a substantial accounting project with no v1 demand. Only the schema is prepared.

## Compliance

- Schema test: no column anywhere is `float4`, `float8`, `real`, `double precision` or `money`. Build failure (rule 6).
- Schema test: amount columns are exactly `numeric(19,4)`; unit cost, rate and quantity columns exactly `numeric(19,6)`. A new column with a different precision fails the test.
- Schema test: every monetary column has an accompanying currency column or a documented single-currency table comment.
- Type rule: `Money`, `UnitCost` and `Quantity` are branded types; native `+ - * /`, `parseFloat`, `Number()` and `toFixed()` on them do not compile.
- Lint rule: direct imports of `decimal.js` / `big.js` outside `packages/validation` are forbidden — one library, one configuration, one rounding mode.
- Serialisation test: every DTO exposing a monetary field emits a string; a JSON number in any response body, outbox payload or export file fails the contract test. Round-trip: `Money.from(serialize(m))` equals `m` for a property-based sample including `.5` boundaries.
- Rounding test: `Money.round` is asserted half-up across positive, negative and exact-half cases, against a maintained golden table of boundary values.
- Allocation test: apportionment routines post the residual to the rounding account, and `Σ allocated = original` exactly, to the paisa.
- FinancialInvariantSuite Invariants 1 and 2 — exact equality, no tolerance parameter. A tolerance added to an invariant check fails review ([NON_NEGOTIABLES §4](../NON_NEGOTIABLES.md)).
- API test: a request with `currency_code` other than `PKR` is rejected in v1. Golden scenarios assert exact figures to the documented precision.

## Related

- [ADR-0007](ADR-0007-weighted-average-costing.md) — the 6-decimal average and the COGS rounding boundary
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — where the balance assertion and the rounding account posting happen
- [ADR-0002](ADR-0002-postgresql-and-redis.md) — `numeric` as a deciding reason for PostgreSQL
- [ADR-0010](ADR-0010-transactional-outbox.md) — payloads carry identifiers, and any money in them is a string
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 1, 6, 19; §3 golden scenarios; §4 no tolerances
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §3 currency and precision in the accounting kernel
- [../PRD.md](../PRD.md) — §5 localisation, §9 multi-currency out of scope for v1
