# ADR-0015: Inventory valuation is the carried value, not a recomputation

**Status:** Proposed
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Supersedes:** [ADR-0007](ADR-0007-weighted-average-costing.md)

## Context

[ADR-0007](ADR-0007-weighted-average-costing.md) chose weighted average and decided precision, scope and the moment cost is fixed. Almost all of it is right and is carried forward here unchanged. But it contains a contradiction that Golden Scenario A exposes, and that a Wave 5 implementer would resolve the wrong way.

**ADR-0007:69 states the correct principle:**

> the stock ledger and the general ledger agree because they are recording the same stored number, not because two algorithms happen to produce the same answer.

**ADR-0007:155 then contradicts it**, defining valuation as a recomputation *and* admitting a tolerance:

> closing valuation equal to `qty_on_hand × current_avg` **within the documented rounding tolerance**, with any residual posted to the rounding account

And ADR-0007:97 writes the recomputation into its own worked reference: `Stock value = 110 × 86.666667`.

The tolerance clause also conflicts with a LEVEL 0 document. [NON_NEGOTIABLES §3](../NON_NEGOTIABLES.md) Invariant 10 requires the inventory ledger valuation to reconcile to the inventory GL account balance, and §4 forbids adding a tolerance to an invariant check. LEVEL 0 outranks LEVEL 1, so the clause cannot stand.

This ADR resolves the contradiction in favour of ADR-0007's own stated principle, and makes it structural rather than aspirational.

---

## The evidence

Golden Scenario A, computed with `packages/validation` under [ADR-0014](ADR-0014-decimal-js.md):

```
opening     100 @ 80.00      value 8,000.0000
purchase     50 @ 100.00     value 5,000.0000
                             ------------------
carried value_on_hand                13,000.0000    qty 150
avg = round(13000 / 150, 6)             86.666667

sale of 40
  COGS = round(40 × 86.666667, 4)    3,466.6667     ← the GL debit

CARRIED VALUE                RECOMPUTATION
13,000.0000                  110 × 86.666667
−  3,466.6667                = 9,533.33337
= 9,533.3333                 → 9,533.3334  (4 dp)

inventory GL = 13,000.0000 − 3,466.6667 = 9,533.3333
```

The carried value equals the GL **because both subtract the same stored number**. The Rs 0.0001 appears only when the valuation is recomputed from quantity and a rounded average. It is not a residual needing somewhere to go; it is the error of a calculation that rule 16 already forbids.

**It is not a fixed quantum, and this is why a tolerance cannot be sized.** The same scenario at ten times the quantity:

```
×10 quantities, one transaction
  carried value_on_hand after   95,333.3332  = GL, exactly
  recomputation                 95,333.3337  → off by 0.0005
```

Five times the gap for ten times the quantity, because the average's rounding error is per-unit and the recomputation multiplies it by the whole quantity on hand. It also vanishes entirely for some splits and changes sign for others. A tolerance wide enough to cover it at scale is wide enough to hide an inventory movement that never reached the GL — which is the failure Invariant 10 exists to detect.

**The defect is not cosmetic.** Selling the remaining 110 at the held average, under ADR-0007 as written:

```
COGS = round(110 × 86.666667, 4) = 9,533.3334
inventory GL = 9,533.3333 − 9,533.3334 = −0.0001   with zero stock behind it
```

An asset account with a credit balance and nothing on the shelf.

---

## Decision

> **Inventory valuation is a carried value, not a recomputation.**
>
> The subledger's valuation for a costing scope is the sum of the value amounts stored on its movement rows — the same stored numbers the accounting kernel posts to the GL. It is never `quantity_on_hand × average_cost`.
>
> The average cost is a **rate applied to the next outward movement**. It is not a valuation input.

### 1. Authoritative stored values

| Value | Where it lives | Scale | Written by |
|---|---|---|---|
| `stock_balances.quantity_on_hand` | balance row | `numeric(19,6)` | inventory kernel |
| `stock_balances.value_on_hand` | balance row | `numeric(19,4)` | inventory kernel |
| `stock_balances.average_cost` | balance row | `numeric(19,6)` | inventory kernel |
| `stock_movements.unit_cost` | movement row | `numeric(19,6)` | inventory kernel |
| `stock_movements.cogs_amount` | movement row | `numeric(19,4)` | inventory kernel |
| `stock_movements.inventory_value_delta` | movement row | `numeric(19,4)` | inventory kernel |
| `stock_movements.rounding_amount` | movement row | `numeric(19,4)` | inventory kernel |

`value_on_hand`, `inventory_value_delta` and `rounding_amount` are **new**. `cogs_amount` keeps ADR-0007's definition exactly — `round(quantity × unit_cost, 4)` — so an accountant can still verify a COGS line with a calculator.

All are maintained under the same `FOR UPDATE` lock [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) already takes, and are immutable once written ([ADR-0006](ADR-0006-immutable-posted-transactions.md)).

### 2. Calculation and storage scales

Unchanged from ADR-0007 and [ADR-0011](ADR-0011-money-representation.md):

```
quantities              numeric(19,6)
unit costs / averages   numeric(19,6)    6 dp, because the average divides
amounts                 numeric(19,4)    4 dp, PKR
intermediate            50 significant digits (ADR-0014), never stored
```

### 3. Rounding boundaries — named, and there are exactly three

| # | Boundary | Rule |
|---|---|---|
| 1 | `average_cost` on an inward movement | `round(…, 6)` half-up, once, when stored |
| 2 | `cogs_amount` on an outward movement | `round(quantity × unit_cost, 4)` half-up, once, when the row is written |
| 3 | Presentation | `round(…, 2)` at the display boundary, never re-used as an input |

No other rounding occurs. `value_on_hand` is a running total of already-rounded stored amounts, so it is **never itself rounded** — it is exact by construction at 4 dp.

### 4. The average is derived from the carried value

```
new_avg = round( (value_on_hand + receipt_value) / (quantity_on_hand + quantity_received), 6 )
```

Not `quantity_on_hand × current_avg + …`. The two are identical in exact arithmetic and differ only by accumulated rounding; taking the numerator from the carried value stops that rounding compounding into every subsequent average.

`receipt_value` is the landed total actually debited to inventory — not `quantity × rounded unit cost`. Landed cost composition is ADR-0007's, unchanged.

Outward movements do not move the average. ADR-0007's edge-case table — zero quantity on hand, negative stock, purchase return, sales return, transfer — is carried forward **verbatim and unchanged**, with `value_on_hand` maintained alongside quantity in each case.

### 5. Residual allocation — one case, and it is explicit

A residual arises in exactly one place: when an outward movement takes the quantity to **zero**, and the COGS computed from the rate does not equal the value carried.

```
inventory_value_delta = −value_on_hand              (flush the carried value)
rounding_amount       = cogs_amount − value_on_hand
```

Both are posted in the same journal entry, to ADR-0011's designated rounding account:

```
Dr  Cost of Goods Sold                  9,533.3334
    Cr  Inventory                                   9,533.3333
    Cr  Rounding account                                0.0001
                                        ----------  ----------
                                        9,533.3334  9,533.3334
```

Quantity reaches zero and value reaches zero **together**. The residual is visible, attributable and reportable — which is what ADR-0011 asks of the rounding account, and what a tolerance destroys.

For every other movement, `rounding_amount = 0` and `inventory_value_delta = −cogs_amount` (outward) or `+receipt_value` (inward). Inter-location transfers are `0` on both legs: the costing scope is the tenant, so a transfer moves quantity, not value.

### 6. Exact balance at posting scale

Every journal entry balances **exactly** at `numeric(19,4)`, the posting scale. `Σ debit = Σ credit` with no tolerance parameter anywhere, as rule 1 and Invariant 1 require. The rounding leg above is what makes that true in the flush case — it is not an adjustment to make an unbalanced entry balance, it is the entry's correct third line.

### 7. Forbidden recomputation

`quantity_on_hand × average_cost` **is not the inventory valuation** and may not be presented as one.

This is rule 16 applied to the specific error: no report may recompute cost differently from the ledger. A report, a module, an export or an API response that needs the inventory valuation reads `value_on_hand`, or sums `inventory_value_delta`. Multiplying a quantity by an average anywhere outside `packages/inventory-kernel` is a build failure.

The kernel itself uses `quantity × unit_cost` for exactly one thing: computing `cogs_amount` at boundary 2.

### 8. Reversal

A reversal **copies the three stored amounts and negates them**. It never recomputes. Reversing the flush above restores `value_on_hand = 9,533.3333`, `quantity_on_hand = 110`, the held average, and debits the rounding account back by 0.0001. Invariant 6 — a reversal neutralises the original exactly — holds by construction rather than by arithmetic agreement.

### 9. Ten transactions are not one transaction ten times larger

This follows from boundary 2 and is **expected behaviour, not a defect**:

```
ONE sale of 40    COGS 3,466.6667    value_on_hand after  9,533.3333
TEN sales of 4    COGS 3,466.6670    value_on_hand after  9,533.3330
                  differ by 0.0003
```

Each of the ten roundings is independently correct: every movement's `cogs_amount` is the auditable `quantity × stored average`, rounded once. Ten roundings simply accumulate more than one does.

**In both cases `value_on_hand` equals the inventory GL balance exactly**, because both subtract the same stored deltas. Invariant 10 holds either way. What differs is a path-dependent total, and that is a property of transaction-level rounding, not an error to be engineered away. Anyone tempted to make the two paths agree is proposing to round somewhere other than boundary 2.

---

## What this supersedes, precisely

| ADR-0007 provision | Disposition |
|---|---|
| §The formula (line 22) — numerator `qty_on_hand × current_avg` | **Superseded** by §4: numerator is `value_on_hand` |
| §The formula — edge-case table | **Carried forward unchanged**, extended to maintain `value_on_hand` |
| §Costing scope — tenant, not location | **Carried forward unchanged** |
| §COGS at the outward movement, stored on the row, immutable | **Carried forward unchanged** |
| §Precision and rounding | **Carried forward**, with the three boundaries named explicitly in §3 |
| §Worked reference (line 97) — `Stock value = 110 × 86.666667` | **Superseded** by §7. The presented figure Rs 9,533.33 is unchanged |
| Compliance (line 155) — `closing valuation equal to qty_on_hand × current_avg` | **Superseded** by §7 |
| Compliance (line 155) — *"within the documented rounding tolerance"* | **Struck.** Conflicts with NON_NEGOTIABLES §4, which is LEVEL 0 |
| Compliance (line 156) — reports read `cogs_amount` or the GL, never a recomputation | **Carried forward and strengthened** |
| Everything in Consequences and Alternatives | **Carried forward unchanged** |

**[NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) is not changed.** Invariant 10 stands as written — exact, no tolerance. Golden Scenario A's published figures stand: `inventory value = Rs 9,533.33` is what both the carried value (9,533.3333) and the superseded recomputation (9,533.3334) present as at 2 dp.

One point needs the Product Owner's and Architecture Guardian's confirmation when approving this ADR. Rule 16's expansion writes the average's numerator as `qty_on_hand × current_avg`; §4 substitutes `value_on_hand`. In exact arithmetic these are the same quantity — *the value on hand* — and rules 6, 10 and 11 decide which **representation** of it is authoritative: the ledger's stored total, not the product of two rounded numbers. This ADR treats that as an implementation refinement consistent with LEVEL 0 rather than an amendment to it. No published figure in §3 changes under either reading.

---

## Consequences

### Positive

- Invariant 10 becomes provable by construction: both sides accumulate the same stored numbers by two paths, so agreement is structural rather than arithmetic coincidence.
- An asset account can no longer be left negative with zero stock behind it.
- The residual is posted where ADR-0011 says residuals go — visible, attributable, and reportable — instead of being absorbed by a tolerance.
- Invariant 10 keeps its power as a fraud and integrity control: it still detects an inventory movement that never reached the GL, which any tolerance would mask.
- The average stops compounding its own rounding error, because the numerator comes from the carried value rather than from a previously rounded average.

### Negative / accepted costs

- Three new columns on two tables, all maintained under the existing lock. `stock_balances` gains a second value that must be kept consistent with the movement ledger — the reconciliation job ADR-0008 already specifies for quantity now covers value too, and drift is a Sev-2.
- A report cannot answer "what is this stock worth at today's average" by multiplying. If that figure is genuinely wanted it is a *different*, clearly-labelled measure, and it is not the inventory valuation.
- Flushing at zero means an outward movement's inventory leg is not always `−cogs_amount`. The kernel carries one branch that a naive implementation would not have.

---

## Alternatives considered

**Post the residual to the rounding account per movement**, forcing the GL to agree with a recomputed `quantity × average`. Rejected. It inverts rules 11 and 16 — the ledger would be adjusted to match a report — and demands a journal entry where no economic event occurred. The required posting is zero for some splits and Rs 0.50 for others, so the rounding account becomes a noise channel rather than a record.

**Derive the valuation from the GL.** Rejected. A check comparing the GL to a figure read from the GL is vacuous, and Invariant 10 would stop detecting the failure it exists for. The winning form is the inverse: the subledger accumulates its own stored per-movement amounts, the GL accumulates the journal, and the invariant proves they agree because they are the same numbers arriving by two independent paths.

**Derive the GL from a recomputed valuation.** Rejected outright. It makes the journal a function of a report, and a back-dated receipt would retroactively move a posted balance — rules 2 and 3.

**Store COGS at higher precision.** Rejected. It attacks the smaller of two error sources and leaves the dominant one — the per-unit average error multiplied by the whole quantity on hand — untouched. At ×10 quantity the 4 dp roundings contribute nothing and the gap is still 0.0005. It also changes `numeric(19,4)`, which is ADR-0011's FBR-facing amount scale.

**Carry the unrounded average.** Rejected. `13000/150` does not terminate, so "unrounded" means "rounded at 50 significant digits" — the residual moves to the 44th place rather than disappearing. It cannot be stored in `numeric(19,6)`, so the ledger would hold a rate that is not the rate used, and `cogs_amount = quantity × stored unit_cost` would stop being hand-checkable.

**Accept a tolerance.** Rejected on three independent grounds. NON_NEGOTIABLES §4 forbids it and is LEVEL 0. It is unsizable — 0.0000 for some splits, 0.0001 here, 0.0005 at ×10, growing with quantity. And a tolerance on Invariant 10 is a permanent blind spot for an unposted movement.

---

## Compliance

- **Schema:** `stock_balances.value_on_hand numeric(19,4) NOT NULL`, `stock_movements.inventory_value_delta numeric(19,4) NOT NULL`, `stock_movements.rounding_amount numeric(19,4) NOT NULL DEFAULT 0`. All covered by the immutability trigger (ADR-0006).
- **Schema:** `CHECK ((quantity_on_hand = 0) = (value_on_hand = 0))` on `stock_balances`. This is what makes §5's flush non-optional rather than a convention a kernel might forget.
- **FinancialInvariantSuite Invariant 10:** `Σ stock_movements.inventory_value_delta` per tenant **equals** the inventory control account GL balance. Exact equality, **no tolerance parameter**. A tolerance argument added to this assertion fails review (NON_NEGOTIABLES §4).
- **FinancialInvariantSuite Invariant 10 (second form):** `stock_balances.value_on_hand` equals `Σ inventory_value_delta` for its costing scope.
- **FinancialInvariantSuite Invariant 1:** every journal entry including a rounding leg balances exactly at 4 dp.
- **Lint rule:** ADR-0007's existing "valuation arithmetic only in `packages/inventory-kernel`" rule is extended to name the pattern — a quantity multiplied by an average cost outside the kernel fails the build, in `packages/reporting`, `modules/*` and `apps/*` alike.
- **Golden scenario:** Scenario A asserts `value_on_hand` and the GL balance are equal at storage scale, and pins `quantity_on_hand × average_cost` as the **forbidden** figure so the recomputation cannot creep back in as an expectation.
- **Golden scenario A2 (sell-out):** quantity and value both reach zero, the rounding leg is Rs 0.0001, and debits equal credits exactly.
- **Golden scenario A3 (×10):** the carried value equals the GL exactly at ten times the quantity, while the recomputation is off by 0.0005 — the case that proves a tolerance cannot be sized.
- **Golden scenario A4 (split transactions):** ten sales of 4 and one sale of 40 differ by 0.0003 in total COGS, and `value_on_hand` equals the GL in **both**. Documents §9 as expected behaviour.
- **Reconciliation job:** ADR-0008's `stock_balances.quantity = Σ movements` job is extended to `value_on_hand = Σ inventory_value_delta`. Drift is a Sev-2 incident.
- **Report test:** every report exposing a cost, margin or stock-value figure sources it from `cogs_amount`, `value_on_hand`, `inventory_value_delta` or the GL — never from a recomputation.

## Related

- [ADR-0007](ADR-0007-weighted-average-costing.md) — superseded by this record
- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — the movement ledger, locking and the reconciliation job this extends. See the open question below
- [ADR-0011](ADR-0011-money-representation.md) — precision, and the rounding account §5 posts to
- [ADR-0014](ADR-0014-decimal-js.md) — the arithmetic these boundaries are performed with
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — why a reversal copies and negates rather than recomputing
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 1, 6, 10, 11, 16; §3 Invariants 1, 6, 10; §4

## Open — needs ADR-0008's owner

ADR-0008 specifies `stock_balances(tenant_id, product_id, location_id, quantity, avg_cost)` — an average **per location**. ADR-0007 and this ADR put the costing scope at the **tenant**. As specified, either every location's `avg_cost` holds a duplicate of a tenant-level number that can drift between rows, or a transfer silently moves value. Adding `value_on_hand` to the same row inherits the ambiguity and the locking discipline compounds it.

The likely resolution is that quantity is per location while value and average are per costing scope, on separate rows with separate locks acquired in a deterministic order — but that is ADR-0008's decision and it has a concurrency consequence the Architecture Guardian should rule on. **Not resolved here.** Wave 5 cannot start until it is.
