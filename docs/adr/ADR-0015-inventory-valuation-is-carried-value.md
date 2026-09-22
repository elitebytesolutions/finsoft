# ADR-0015: Inventory valuation is the carried value, not a recomputation

**Status:** Proposed
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Would supersede on acceptance:** [ADR-0007](ADR-0007-weighted-average-costing.md) — a `Proposed` record is not in force and cannot be the terminus of a supersession, so ADR-0007 remains `Accepted` with a conflict notice until this ADR is accepted. The two statuses change together or not at all.

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

Outward movements do not move the average.

### 4a. Edge cases, restated

ADR-0007's edge-case table cannot be carried forward unchanged: one of its rows is **false** wherever a negative balance is reachable, and three are undefined once value is carried separately from quantity. Restated here in full, so no implementation improvises.

> **The negative-balance rows below are a fallback, not an operating mode.** [ADR-0017](ADR-0017-stock-availability-enforced-at-posting.md) prevents a posting from creating a negative balance — availability is enforced inside the posting transaction, under the stock locks, and an insufficient balance is **rejected rather than costed**. ADR-0007's phrase *"authorised negative stock"* is **withdrawn**: it described the legacy system's behaviour, and nothing in FinSoft authorises it.
>
> These rules exist because prevention cannot cover data it did not create. A negative balance can still arrive from legacy migration, a bulk import or corruption, and when it does the costing engine must have defined, auditable behaviour rather than undefined behaviour. They are the reason `v_negative_stock` is a monitored exception report — and the reason the negative-stock variance of the fifth row must stay separate and individually reportable, since every amount reaching it originates in data that bypassed the posting paths.

`outward_value` is the driving amount for **every** outward movement. `cogs_amount` is the sale-specific case of it, and is the only one that debits Cost of Goods Sold — a purchase return, a write-off and a shrinkage adjustment are outward movements that are not COGS, and ADR-0007's table left them with no rule.

| Situation | Rule |
|---|---|
| `quantity_on_hand = 0` on an inward movement | `average_cost = receipt_cost`, `value_on_hand = receipt_value`. No residual. |
| `quantity_on_hand < 0` (an exception state — see the note above) | `value_on_hand` is the **sum of deltas**, and **may** be negative. It is *not* `quantity × held average` — that is the recomputation §7 forbids. The held `average_cost` is what the negative quantity was issued at, and is used for nothing until the balance returns to positive. |
| **Any receipt while `quantity_on_hand + quantity_received ≤ 0`** | `average_cost` is **held, not re-derived**. `receipt_value` accumulates into `value_on_hand` and `quantity_on_hand` rises toward zero. §4's division does not run at all, so it cannot divide by zero or by a negative. This is the rule an earlier draft omitted: it claimed a "split at the zero boundary" that never fires when the balance does not actually reach zero — `−3 + 1 = −2` stays negative, and the division would have run against `−2`. |
| **The movement that crosses to positive** | Split at the zero boundary. The portion clearing the negative is applied under the row above, taking `value_on_hand` to zero with the clearing treated as below. The remainder is then an ordinary receipt against zero quantity, taking `average_cost = receipt_cost`. The denominator is strictly positive whenever §4 runs. |
| **Clearing a negative balance — the variance** | When the negative is cleared, `negative_stock_variance = receipt_value_of_that_portion + value_on_hand` is generally **not zero**, and it is **not a rounding difference**. The form is **signed throughout**, matching §5; an earlier draft wrote `receipt_value − \|value_on_hand\|`, which agrees only while `value_on_hand < 0` and computes the wrong sign at twice the magnitude in the `value_on_hand = +50, quantity_on_hand = −3` state this table itself admits. Issuing 3 units at a held average of 10 and replenishing at 25 gives `75 + (−30) = 45` — the amount by which COGS was understated when stock was issued before the goods existed. It is unbounded, it is an economic variance, and it goes to a **named negative-stock cost variance account** that rolls into cost of sales. It does **not** go to the rounding account (rule 6 designates that account for rounding differences) and it does **not** reuse `rounding_amount`: at a flush a positive `rounding_amount` is a *credit*, here a positive variance is a *debit*, and one signed column meaning opposite posting directions in two branches is an Invariant 1 defect waiting for an implementer. It takes its own column, `negative_stock_variance numeric(19,4) NOT NULL DEFAULT 0`, and its posting rule is written in `docs/posting-rules/` before Wave 5. |
| Outward movement | `average_cost` unchanged. `outward_value = −cogs_amount` for a sale; see the flush rule in §5 when it takes quantity to zero. |
| Purchase return | An outward movement at the current average: `outward_value` is computed exactly as a sale's is. **The GL entry is not specified here.** An earlier draft claimed the entry was inventory against accounts payable; that entry does not balance, and the imbalance is structural rather than arithmetic. Accounts payable is relieved at the **invoice price** the supplier is credited — 1,000.0000 in the two-purchase example of §The evidence — while inventory is relieved at the **average** the goods were absorbed into, 866.6667. The 133.3333 difference is a purchase price variance, and it is not named in this ADR because naming a GL account is a posting rule, not a costing decision. This row is **blocked on a posting rule** for `PURCHASE_RETURNED` in `docs/posting-rules/`, authored by the Accounting Guardian with a golden scenario, before Wave 5. The costing half — that the outward movement leaves inventory at the carried average, not at the invoice price — is decided here and is not reopened by that rule. |
| Write-off, shrinkage, expiry destruction | Outward movements at the current average. Same arithmetic; the GL debit is the loss account named by the posting rule. |
| **Sales return, full** | Inward movement. `receipt_value` is **the original movement's `cogs_amount`, exactly** — not a recomputation. This is what makes the life-cycle closure identity in §9 hold. |
| **Sales return, partial** | Inward movement per tranche: `receipt_value = round(quantity_returned × the original movement's unit_cost, 4)`. Tranches need not sum back to the original `cogs_amount`; any difference is discharged at the next flush to zero, not posted per return. |
| Sales return, effect on the average | A return is an inward movement, so it **does** move the average — toward the historical rate it was issued at. ADR-0007 implied this and never said it. It is correct: the stock is genuinely back, at the cost it left at. |
| Inter-location transfer | `outward_value = 0` and `receipt_value = 0` on both legs. The costing scope is the tenant, so a transfer moves quantity, not value, and does not touch the average. |
| Value-only adjustment (`STOCK_ADJUSTED` with zero quantity) | Permitted. `inventory_value_delta` is the adjustment; `average_cost` is **re-derived** from the new carried value per §4, because leaving it stale would make subsequent COGS ignore the write-down and prevent a clean flush to zero. |

### 5. Residual allocation — one case, and it is explicit

A **rounding** residual arises in exactly one place: when an outward movement takes the quantity to **zero**, and the COGS computed from the rate does not equal the value carried.

This is the only difference that reaches the rounding account. It is bounded (the bound is stated below), it has no economic content, and it exists solely because a rate is carried at 6 dp while a value is carried at 4. The **negative-stock variance** of §4a is a different thing that must not be routed here: it is unbounded, it is economic — understated COGS on stock issued before it existed — and it carries its own column and its own account. One column, one account, one sign convention each. Mixing them would make the rounding account unreconcilable and hide a cost-of-sales misstatement inside a line item auditors are told to ignore as immaterial.

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

For every other movement, `rounding_amount = 0` and `inventory_value_delta = −outward_value` (outward) or `+receipt_value` (inward). Inter-location transfers are `0` on both legs: the costing scope is the tenant, so a transfer moves quantity, not value.

#### The residual is signed, and both signs occur

`rounding_amount = cogs_amount − value_on_hand` is a signed quantity. The worked example above is the positive case, where the average rounded **up** and the final COGS slightly exceeds the value carried. When the average rounds **down** the residual is negative and the entry reverses:

```
POSITIVE residual — average rounded up (Scenario A)
  Dr  Cost of Goods Sold            9,533.3334
      Cr  Inventory                              9,533.3333
      Cr  Rounding account                           0.0001

NEGATIVE residual — average rounded down
  Dr  Cost of Goods Sold            2,999.9997
  Dr  Rounding account                  0.0003
      Cr  Inventory                              3,000.0000
```

In both, inventory is credited **exactly** the carried value, quantity and value reach zero together, and debits equal credits at 4 dp. An implementer reading only the positive example would hardcode the credit direction, so both are written out.

**Magnitude.**

```
|flush residual|  ≤  5×10⁻⁷ × lifecycle_units  +  0.00005 × outward_movements
```

Two terms, and both are needed. The first is the stored average's per-unit error carried on the whole lifecycle quantity; the second is the 4 dp rounding of each outward amount, which accumulates with the number of movements rather than the quantity.

Checked against this ADR's own scenarios:

```
A, one sale of 40 then the flush    150×3.33e-7 + 0.00002 + 0.00003  =  0.0001  ✓
A4, ten sales of 4 then the flush   0.00005 + 10×0.000032 + 0.00003  =  0.0004  ✓
```

`outward_movements` counts every outward movement **and** every partial sales-return tranche in the lifecycle, since §4a deliberately allows tranches not to sum back.

An earlier draft stated the bound as `quantity × 5×10⁻⁷` alone and then illustrated it with "Rs 0.0001 at 110 units" — which that bound does not produce (`110 × 5×10⁻⁷ = 0.000055`). It omitted the movement term entirely, so it understated without limit as a lifecycle fragmented. The point of stating a bound is that the residual is *small and bounded*, not *negligible and ignorable*, and a bound its own example violates is worse than none.

#### ADR-0007's second residual channel is struck

ADR-0007's Compliance section says:

> Rounding differences between the sum of line-level COGS and a batch-level total are posted to the designated rounding account

**That channel does not exist under this ADR and is superseded.** A document total is the sum of its already-rounded stored line amounts, so it equals the sum of its parts by construction — there is no line-versus-total difference to post. Left standing, it would authorise a rounding leg on an ordinary multi-line sale, which would contradict this section's opening claim that a residual arises in exactly one place.

The flush at zero quantity is the **only** residual channel in the system.

### 6. Exact balance at posting scale

Every journal entry balances **exactly** at `numeric(19,4)`, the posting scale. `Σ debit = Σ credit` with no tolerance parameter anywhere, as rule 1 and Invariant 1 require. The rounding leg above is what makes that true in the flush case — it is not an adjustment to make an unbalanced entry balance, it is the entry's correct third line.

### 7. Forbidden recomputation

`quantity_on_hand × average_cost` **is not the inventory valuation** and may not be presented as one.

This is rule 16 applied to the specific error: no report may recompute cost differently from the ledger. A report, a module, an export or an API response that needs the inventory valuation reads `value_on_hand`, or sums `inventory_value_delta`. Multiplying a quantity by an average anywhere outside `packages/inventory-kernel` is a build failure.

The kernel itself uses `quantity × unit_cost` for exactly one thing: computing `cogs_amount` at boundary 2.

### 8. Reversal

A reversal **copies the stored amounts and negates them**. It never recomputes `cogs_amount`, `inventory_value_delta` or `rounding_amount`, and it posts into an **open** period — never back-dated into a closed one (rule 3, ADR-0012), including when the original was a flush.

Negation restores `value_on_hand` and `quantity_on_hand` exactly, because both are running totals of deltas. **It does not restore `average_cost`, and this ADR does not claim that it does.**

`average_cost` is a **level**, not a delta. Negating a delta cannot restore a level, and an earlier draft of this section asserted otherwise. Two cases, decided:

| Reversing | Rule for `average_cost` |
|---|---|
| An **outward** movement | Unchanged. Outward movements never moved it, so nothing has to be restored. |
| An **inward** movement | **Re-derived** from the carried value per §4, treating the reversal as a negative receipt. It is NOT restored to the prior rate. |

The second case deserves its reasoning stated, because it is a genuine limitation rather than a preference.

A receipt that moved the average from 80.000000 to 86.666667 cannot be undone by negating deltas — the information needed to reconstruct 80.000000 is not in the delta. Re-deriving from the carried value is the only option that keeps the average consistent with the value actually on hand, and it is what the formula in §4 does anyway.

**With intervening transactions it does not return to the prior rate at all**, and it should not. If a receipt is followed by three more receipts and two issues before it is reversed, the average after the reversal reflects the stock that is genuinely there — not the rate that held at some earlier moment. Re-deriving is correct; restoring would be a fiction that would then disagree with `value_on_hand`.

What Invariant 6 requires is that the reversal neutralises the original's **financial impact** — the GL, the subledger value, and the stock quantity. Those are restored exactly, by negation. The costing *rate* going forward is a consequence of what remains on hand, and a reversal legitimately changes it. Anyone expecting the average to rewind is expecting the ledger to forget the transactions in between.

#### A reversal that lands on zero quantity

An earlier draft ended this section with *"a reversal that would drive `quantity_on_hand` to zero triggers the flush rule in §5 like any other movement."* Read against the first paragraph — a reversal "never recomputes `cogs_amount`, `inventory_value_delta` or `rounding_amount`" — that is a contradiction, because the flush rule computes a `rounding_amount`. Both halves are needed, so the two are separated:

1. **The reversal row is never recomputed.** Its amounts are the original's, negated. This is absolute and admits no exception.
2. **If the resulting state is `quantity_on_hand = 0` with `value_on_hand ≠ 0`, the residual is discharged by a separate movement row** in the same journal entry — not by adjusting the reversal's negated amounts. Two rows, two purposes, both auditable.

The state in (2) is reachable, so it is not hypothetical. Receive 10 @ 10 (`qty 10`, `value 100`), then post a value-only `STOCK_ADJUSTED` of `+5` (`value 105`, average re-derived to 10.5 per §4a). Reversing the receipt negates `−10` and `−100`, leaving `qty 0` and `value 5`. The reversal did exactly what it must; the Rs 5 is the adjustment, stranded by the disappearance of the stock it was made against.

**Which account that residual goes to depends on its size, and the test is mechanical.** Within §5's stated bound it is a rounding difference and goes to the rounding account. Outside it — as the Rs 5 is, by four orders of magnitude — it is **not** a rounding difference and must not be routed there; it is a stranded carrying amount and goes to the same named variance account as §4a's negative-stock variance, for the same reason: the rounding account must stay reconcilable and small enough that its immateriality is a fact rather than an assumption. The posting rule is written in `docs/posting-rules/` before Wave 5, together with §4a's.

### 9. Ten transactions are not one transaction ten times larger

This follows from boundary 2 and is **expected behaviour, not a defect**:

```
ONE sale of 40    COGS 3,466.6667    value_on_hand after  9,533.3333
TEN sales of 4    COGS 3,466.6670    value_on_hand after  9,533.3330
                  differ by 0.0003
```

Each of the ten roundings is independently correct: every movement's `cogs_amount` is the auditable `quantity × stored average`, rounded once. Ten roundings simply accumulate more than one does.

**In both cases `value_on_hand` equals the inventory GL balance exactly**, because both subtract the same stored deltas. Invariant 10 holds either way. What differs is a path-dependent total, and that is a property of transaction-level rounding, not an error to be engineered away. Anyone tempted to make the two paths agree is proposing to round somewhere other than boundary 2.

#### Bound, and where the difference goes

Two questions follow immediately — how large can it get, and where does it end up — and an assertion is not an answer to either.

**Bound.** `|Σ outward_value − exact| ≤ 0.00005 × movements + 5×10⁻⁷ × units`. At 100,000 movements and ten million units a year that is under Rs 10.

**Closure.** The path difference is not absorbed and not tolerated. It is carried forward and discharged in full at the flush. The general identity, over any life cycle that ends at zero quantity:

```
Σ inventory_value_delta = 0        exactly, for a costing scope at zero stock
```

Stated this way it covers every movement type, because `inventory_value_delta` is defined for all of them. The familiar form is a corollary:

```
Σ receipt_value = Σ outward_value − Σ rounding_amount
```

Verified on both A4 paths: one sale of 40 then the flush gives `Σ outward_value = 13,000.0001` and `Σ rounding = 0.0001`; ten sales of 4 then the flush gives `13,000.0004` and `0.0004`. Both close to exactly `13,000.0000` — the receipts.

**Assumptions and sign conventions**, because the corollary is easy to misapply:

| | |
|---|---|
| Sign | `inventory_value_delta` is signed: positive inward, negative outward. `receipt_value`, `outward_value` and `cogs_amount` are unsigned magnitudes. `rounding_amount` is **signed** (§5). |
| `outward_value`, not `cogs_amount` | A purchase return, a write-off and a shrinkage adjustment are outward movements that are not COGS. Writing the corollary with `cogs_amount` makes it false the first time stock is written off. |
| Opening inventory | An inward movement like any other, with `receipt_value` the opening valuation. It is not a special term. |
| Sales returns | Inward, with `receipt_value` the original `cogs_amount` (§4a). The return and the original sale therefore cancel on opposite sides, which is why the full-return rule has to be *exactly* the original amount rather than a recomputation. |
| Purchase returns | Outward, contributing to `Σ outward_value`. |
| Transfers | Contribute `0` to both sides. They do not appear. |
| **Value-only adjustments** | **Break the corollary.** A write-down has an `inventory_value_delta` with no receipt and no outward movement, so `Σ receipt_value = Σ outward_value − Σ rounding_amount` no longer holds. The general identity `Σ inventory_value_delta = 0` still does. Use the general form wherever adjustments are possible, which is everywhere in production. |
| Scope | Per costing scope — per `(tenant_id, product_id)` — and only once quantity has actually reached zero. A scope with stock on hand has `Σ inventory_value_delta = value_on_hand`, not zero. |

---

## What this supersedes, precisely

Provisions are cited by section rather than by line number. ADR-0007 now carries a conflict notice at its head, which shifts every line below it — and a supersession table whose anchors move is worse than one with no anchors.

| ADR-0007 provision | Disposition |
|---|---|
| §The formula — numerator `qty_on_hand × current_avg` | **Superseded** by §4: the numerator is `value_on_hand` |
| §The formula — the edge-case table | **Superseded** by §4a, not carried forward. One row (`qty_on_hand + qty_received = 0` → *"not reachable"*) is **false** wherever a negative balance is reachable, which the same table permits, and would divide by zero. Three more were undefined once value is carried separately from quantity |
| §Costing scope — tenant, not location | **Carried forward unchanged** |
| §COGS at the outward movement, stored on the row, immutable | **Carried forward unchanged.** `cogs_amount` keeps its definition exactly; §4a adds `outward_value` as the general case for outward movements that are not sales |
| §Precision and rounding — scales | **Carried forward unchanged** |
| §Precision and rounding — *"Rounding differences between the sum of line-level COGS and a batch-level total are posted to the rounding account"* | **Struck** (§5). A second residual channel that cannot exist under a carried value: a document total is the sum of its already-rounded stored lines. Left standing it would authorise a rounding leg on an ordinary multi-line sale |
| §Worked reference — `Stock value = 110 × 86.666667` | **Superseded** by §7. The presented figure Rs 9,533.33 is unchanged |
| Compliance — `closing valuation equal to qty_on_hand × current_avg` | **Superseded** by §7 |
| Compliance — *"within the documented rounding tolerance"* | **Struck.** Conflicts with NON_NEGOTIABLES §4, which is LEVEL 0, so it could not stand whatever ADR-0007 said |
| Compliance — reports read `cogs_amount` or the GL, never a recomputation | **Carried forward and strengthened** (§7, and the average no longer leaves the kernel) |
| Consequences — *"Repeated receipt/issue cycles accumulate a residual"* | **Restated.** The average still accumulates rounding; the carried value does not, and cannot drift from the GL at all. The Sev-2 escalation attached to it is carried forward unchanged |
| Everything else in Consequences and Alternatives | **Carried forward unchanged** |

**[NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) is not changed.** Invariant 10 stands as written — exact, no tolerance. Golden Scenario A's published figures stand: `inventory value = Rs 9,533.33` is what both the carried value (9,533.3333) and the superseded recomputation (9,533.3334) present as at 2 dp.

### This requires a LEVEL 0 amendment, and it is not a refinement

An earlier draft of this ADR claimed that substituting `value_on_hand` for `qty_on_hand × current_avg` in rule 16 was "an implementation refinement consistent with LEVEL 0 rather than an amendment to it." **That framing was wrong and is withdrawn.**

The two expressions are equal in exact arithmetic and **not equal in stored arithmetic**, because `current_avg` has already been rounded to 6 dp. They can produce different stored averages, different COGS and different published figures. That is a change to an operative formula printed in a LEVEL 0 document.

It is also broken operationally. `NON_NEGOTIABLES.md` is loaded into the context of every coding agent; this ADR is not. A Wave 5 agent reads rule 16, implements `qty_on_hand × current_avg`, and is **correct to do so** — or implements this ADR and is told by §4 of the constitution that it has found a violation. Either way the contradiction surfaces as a blocked ticket on the first day of Wave 5.

**The amendment.** Rule 16's formula block in [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) §2 becomes:

```
new_avg = round( (value_on_hand + receipt_value)
                 / (quantity_on_hand + quantity_received), 6 )     ← rounding boundary 2 of 3
```

applied **only when `quantity_on_hand + quantity_received > 0`**. When the denominator is zero or negative the division does not run and `average_cost` is held unchanged; ADR-0015 §4a gives the two cases where that occurs. There is no state in which this formula divides by zero or derives a negative average.

with the following sentences:

> **`receipt_value` is a total, not a unit cost.** It is the landed amount actually debited to inventory for the receipt — quantity × landed unit cost, plus allocated freight, duty and clearing. It is **not** `receipt_cost`, the per-unit figure this rule named before this amendment. Reading it as a unit cost makes every purchase wrong by a factor of the receipt quantity, silently.
>
> **`value_on_hand` is the carried value** of the stock ledger — the sum of the stored value amounts on its movement rows — never `quantity_on_hand × average_cost`.
>
> **The inventory valuation of a costing scope IS `value_on_hand`**, equivalently `Σ stock_movements.inventory_value_delta`. `quantity_on_hand × average_cost` is not the inventory valuation and may not be presented as one, in a report, an export, an API response or a screen.
>
> **`value_on_hand` and `quantity_on_hand` are the inventory kernel's reconcilable cache** of the movement ledger under rule 10 — not a second source of truth. The ledger remains the truth: `value_on_hand = Σ stock_movements.inventory_value_delta` for the costing scope, proved by FinancialInvariantSuite Invariant 10 and by the reconciliation job. This rule does not create a stored balance that overrides rules 10 and 11.
>
> **Do not implement inventory valuation, costing, or any stock-value report from this rule alone.** ADR-0015 is mandatory reading and is part of this rule; it defines how receipts, issues, reversals, negative stock and residuals update `value_on_hand`, and those behaviours are not reproduced here. If you have not read it, stop and ask (§4).

**Why the last sentence is a stop-work directive and not a footnote.** This file is loaded into every coding agent's context; ADR-0015 is not. Pointing at an unavailable document in a parenthetical is how the original defect was introduced. §4 is the register agents reliably obey, so the pointer is written in it.

**The amendment delegates mechanics, not authority.** ADR-0015 specifies *how* the carried value is maintained. It does not acquire the power to redefine what the valuation *is* — that is fixed by the third sentence above, at LEVEL 0, and a future ADR that wanted to change it would need this same three-signature amendment. A LEVEL 1 record must never be able to move a LEVEL 0 definition by editing itself.

**File-level changes that accompany it.** `NON_NEGOTIABLES.md:3` is bumped from `FROZEN — Factory Constitution v1` to `v1.1`, and an amendment log is added at the foot:

```
## Amendment log

2026-09-22 · rule 16 formula amended by ADR-0015
             Product Owner · Architecture Guardian · Accounting Guardian
```

Without the log, two agents can hold different revisions of a LEVEL 0 rule and neither can tell.

**Two facts that support the amendment but do not excuse skipping it.** NON_NEGOTIABLES §3's own Golden Scenario A already computes the numerator as `((100×80)+(50×100))` — a sum of values, not a quantity times a rounded average — so §2 and §3 of the constitution already disagree in form, and this aligns them. And no published figure in §3 changes.

**Approval required, and it is not satisfied by this document's header.** LEVEL 0 requires the Product Owner, the Architecture Guardian and the Accounting Guardian, recorded as an ADR. Listing those three as Deciders is a statement of who must sign, not evidence that any of them has approved this text. The amendment is applied to NON_NEGOTIABLES only after explicit approval of the final wording, and this ADR stays `Proposed` — with Wave 5 blocked — until then.

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
- **Quantity and value reach zero together — enforcement is DEFERRED, and deliberately so.**

  The obvious control is `CHECK ((quantity_on_hand = 0) = (value_on_hand = 0))` on `stock_balances`. It cannot be written today, for three reasons, and shipping a bullet that does not compile would be worse than admitting that.

  1. The columns do not exist under those names. ADR-0008 defines `stock_balances(tenant_id, product_id, location_id, qty, avg_cost)`.
  2. If the row stays **per location**, the constraint and §4a's zero-value transfer are mutually unsatisfiable: transfer all stock out of location A and `qty = 0` while the tenant-scoped value is non-zero. The constraint would fire on a legitimate transfer.
  3. If value moves to a **tenant-scope** row — the likely resolution in the Open section — the condition spans two rows and cannot be a row-level `CHECK` at all.

  So the enforcement is specified now and sited once ADR-0008 rules on the row shape:

  | Row shape | Control |
  |---|---|
  | Value and quantity on one row | `CHECK ((quantity_on_hand = 0) = (value_on_hand = 0))`, with the transfer case resolved by keeping value tenant-scoped |
  | Value on a separate tenant-scope row | A deferrable constraint trigger at transaction end, plus the reconciliation job below |

  In **both** shapes the kernel asserts the invariant before it writes, and the reconciliation job asserts it after. Those two are unconditional and do not wait on ADR-0008. The database-level control is the third layer, and it is the one that is deferred — not the guarantee.
- **FinancialInvariantSuite Invariant 10:** `Σ stock_movements.inventory_value_delta` per tenant **equals** the inventory control account GL balance. Exact equality, **no tolerance parameter**. A tolerance argument added to this assertion fails review (NON_NEGOTIABLES §4).

  **This form only holds if every movement of the inventory control account originates from a stock movement, and that is not true by default.** ADR-0005 permits `JOURNAL_VOUCHER_POSTED` with explicit accounts — it is not a back door, but it is a door. One manual JV to the inventory control account breaks Invariant 10 for a legitimate, authorised user action, and the next person to look at it adds a tolerance, which is the entire failure this ADR exists to prevent.

  So the invariant claims a control the product already provides: `docs/PRD.md:73` flags control accounts. **Flagged control accounts — inventory, accounts receivable, accounts payable — are not directly postable by `JOURNAL_VOUCHER_POSTED`.** They move only through their subledger's posting rules. The posting engine rejects a journal voucher line naming a flagged control account, and that rejection is itself a golden scenario. With that closed, exact equality is holdable; without it, the invariant is a bug report waiting to be filed against the books.

- **ADR-0011 currency posture for the three new columns.** `inventory_value_delta`, `rounding_amount` and `negative_stock_variance` are `numeric(19,4)` and carry the single-currency table comment ADR-0011 requires of every monetary column (PKR base). Without it they fail ADR-0011's existing schema test, which is already in the suite.
- **FinancialInvariantSuite Invariant 10 (second form):** `stock_balances.value_on_hand` equals `Σ inventory_value_delta` for its costing scope.
- **FinancialInvariantSuite Invariant 1:** every journal entry including a rounding leg balances exactly at 4 dp.
- **The average's escape routes are closed — by three controls, none of which is `dependency-cruiser`.** An earlier draft claimed this was "enforced by `dependency-cruiser` on the module graph." It is not and cannot be: dependency-cruiser sees *import edges between packages*, not *which column a query selects*. Under ADR-0013 `packages/reporting` is on the Kysely allowlist and may legitimately `selectFrom('stock_balances')`; nothing in the module graph stops it selecting `average_cost`. Naming a mechanism that does not implement the control is the exact defect ADR-0013 exists to prevent, so the real controls are named instead:

  | # | Control | Mechanism that actually implements it |
  |---|---|---|
  | 1 | The kernel's movement and balance DTOs omit `average_cost` | The kernel's export surface, backed by `.dependency-cruiser.cjs:102`, which already blocks deep imports into the kernels — this part *is* a dependency-cruiser control, and only this part |
  | 2 | `packages/reporting` reads a view that does not expose the column | Migration-owned view definition (ADR-0013), asserted by a schema test |
  | 3 | Selecting `average_cost` outside `packages/inventory-kernel` fails the build | Repo-local ESLint rule matching the column name in a Kysely `select`/`selectAll` on `stock_balances` |

  Control 1 is the strongest and 3 is the backstop for the path 1 cannot close. If the presentation exemption in the Level 2 resolution below is granted, **3 becomes the primary control and 1 is secondary** — this ADR should not rest its design on the stronger claim while the UI specs in force require the weaker one.

- **Lint rule — and it is not implementable against today's brands.** ADR-0007's "valuation arithmetic only in `packages/inventory-kernel`" rule is extended to the specific pattern: a quantity multiplied by an average cost outside the kernel fails the build.

  **Mechanism.** `Money.multiply(Quantity, UnitCost)` is a method call, not an operator, so this needs type-aware `typescript-eslint` over the branded types. It is a **repo-local ESLint plugin with its own unit tests** — no off-the-shelf rule does this, and an implementer looking for a config flag will find nothing and conclude the control is already on.

  **Precondition, and it blocks the rule.** `packages/validation` exports exactly `Money, Percentage, Quantity, UnitCost`. There is **no `UnitPrice` brand**, so a sale line computing revenue is today the identical call shape — `packages/validation/src/money.test.ts:264` computes `Money.multiply(sold, UnitCost.from('140'))` as revenue. A type-aware rule over the current brands either blocks every sales line or blocks nothing; it cannot tell the forbidden valuation from the required per-line revenue that ADR-0011 documents as a legitimate rounding boundary. **`packages/validation` must brand `UnitPrice` and `Rate` separately from `UnitCost` before this rule can be written.** That is a task contract of its own and a Wave 5 entry gate.

  **Exemption.** `tests/accounting/golden/**` only, because **pinning the forbidden figure requires computing it**. A rule that forbade its own counter-example would have the pin deleted within a week, which is precisely how the recomputation would creep back. An earlier draft also exempted `packages/validation/src/*.test.ts`; that glob is **withdrawn** — it sits inside source, one `tsconfig` `include` change from compiling into a shipped package, and `packages/validation` owns decimal primitives rather than valuation, so it has no business needing the exemption at all. An exempt assertion must assert the forbidden figure **differs** from the valuation; an exempt file that asserts equality defeats the purpose and fails review.

  **Two controls keep the exemption narrow**, because as drafted nothing stopped it widening: a meta-test asserting the exemption list has exactly the named entries, and CODEOWNERS on the rule config — the same pattern ADR-0013 used for its `CHECKSUMS` manifest.
- **Golden scenario:** Scenario A asserts `value_on_hand` and the GL balance are equal at storage scale, and pins `quantity_on_hand × average_cost` as the **forbidden** figure so the recomputation cannot creep back in as an expectation.
- **Golden scenario A2 (sell-out):** quantity and value both reach zero, the rounding leg is Rs 0.0001, and debits equal credits exactly.
- **Golden scenario A3 (×10):** the carried value equals the GL exactly at ten times the quantity, while the recomputation is off by 0.0005 — the case that proves a tolerance cannot be sized.
- **Golden scenario A4 (split transactions):** ten sales of 4 and one sale of 40 differ by 0.0003 in total COGS, and `value_on_hand` equals the GL in **both**. Documents §9 as expected behaviour.
- **Golden scenario A5 (negative stock, cleared):** open at zero, issue 3 at a held average of 10, replenish 3 at 25. Asserts: the average is **held, not re-derived**, while the balance is negative (§4's division never runs); `negative_stock_variance = 75 + (−30) = 45`; the Rs 45 lands in the variance account and **not** in the rounding account; and `value_on_hand` equals `Σ inventory_value_delta` throughout, including in the negative state. This is the scenario that fails if anyone reinstates the absolute-value form or reroutes the variance for convenience.

- **Golden scenario A6 (reversal onto zero quantity):** receive 10 @ 10, post a value-only `STOCK_ADJUSTED` of `+5`, reverse the receipt. Asserts: the reversal row carries the original's amounts negated **exactly** and recomputes nothing; the stranded Rs 5 is discharged by a **separate** row in the same journal entry; it is routed to the variance account, not the rounding account, because it is four orders of magnitude outside §5's bound; and the entry balances at 4 dp. Pins §8's two halves against each other so the contradiction cannot return.

- **Golden scenario A7 (purchase return):** the two-purchase state from §The evidence, returning 10 units bought at an invoice price of 100 while the carried average is 86.6667. Asserts the **costing** half only — inventory is relieved at `outward_value` computed from the carried average (866.6667), never at the invoice price. The GL half is **deliberately not asserted** and the scenario is marked pending: it is blocked on the `PURCHASE_RETURNED` posting rule that names the purchase price variance account for the 133.3333 difference. A scenario that guessed the GL entry would freeze a guess into the suite.

- **Reconciliation job:** ADR-0008's `stock_balances.quantity = Σ movements` job is extended to `value_on_hand = Σ inventory_value_delta`. Drift is a Sev-2 incident.
- **Report test:** every report exposing a cost, margin or stock-value figure sources it from `cogs_amount`, `value_on_hand`, `inventory_value_delta` or the GL — never from a recomputation. **This names no mechanism and is a review checklist, not a control.** It is carried forward from ADR-0007 unchanged, but this ADR leans on it harder than ADR-0007 did, so it is flagged as the weakest bullet here. Control 3 in the table above is what makes it mechanical for the `average_cost` path specifically; the general claim remains a checklist until someone strengthens it.

- **Posting rules change, and this needs the Accounting Guardian under ADR-0005's governance clause.** This ADR changes the posting surface in four ways, and ADR-0005 requires a posting-rule document plus a golden scenario in the same PR for each:

  | Event | Change |
  |---|---|
  | `SALE_POSTED` | A **third journal line** — the rounding leg — on a flush to zero |
  | `PURCHASE_RETURNED` | `cogsAmount` → `outwardValue`; the GL entry is unspecified and blocked on a purchase price variance account (§4a) |
  | `STOCK_WRITTEN_OFF` | `cogsAmount` → `outwardValue`; debit is the loss account named by the rule |
  | `STOCK_ADJUSTED` | `cogsAmount` → `outwardValue`; **and** a zero-quantity adjustment now re-derives the average, which is a new posting shape for an existing event |

  Plus two new accounts to name: the negative-stock cost variance (§4a, §8) and the purchase price variance (§4a).

- **Direction of the data between kernels — stated explicitly, because the default is a boundary violation.** `inventoryKernel.postMovement` **returns** `outwardValue`, `inventoryValueDelta`, `roundingAmount` and `negativeStockVariance`, and the calling module passes them in the event payload. The accounting kernel **never** reads `stock_balances` and never derives the residual itself.

  If this is not written down the first implementer will have the accounting kernel read the balance — a kernel-to-kernel read that ARCHITECTURE §5 forbids (`accounting-kernel → database, validation, shared-types, and nothing else`), and that ADR-0005 already forbids in principle by making the accounting kernel consume the inventory kernel's cost figure rather than recalculate it. One sentence closes a wrong-layer dependency that would otherwise be discovered after it shipped.

## Related

- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — the posting engine whose rules for `SALE_POSTED`, `PURCHASE_RETURNED`, `STOCK_WRITTEN_OFF` and `STOCK_ADJUSTED` this record changes; also the source of the kernel-to-kernel data direction above
- [ADR-0007](ADR-0007-weighted-average-costing.md) — would be superseded by this record on acceptance
- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — the movement ledger, locking and the reconciliation job this extends. See the open question below
- [ADR-0011](ADR-0011-money-representation.md) — precision, and the rounding account §5 posts to
- [ADR-0014](ADR-0014-decimal-js.md) — the arithmetic these boundaries are performed with
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — why a reversal copies and negates rather than recomputing
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 1, 6, 10, 11, 16; §3 Invariants 1, 6, 10; §4

## Open — needs ADR-0008's owner

ADR-0008 specifies `stock_balances(tenant_id, product_id, location_id, quantity, avg_cost)` — an average **per location**. ADR-0007 and this ADR put the costing scope at the **tenant**. As specified, either every location's `avg_cost` holds a duplicate of a tenant-level number that can drift between rows, or a transfer silently moves value. Adding `value_on_hand` to the same row inherits the ambiguity and the locking discipline compounds it.

The likely resolution is that quantity is per location while value and average are per costing scope, on separate rows with separate locks acquired in a deterministic order — but that is ADR-0008's decision. **Not resolved here.** ADR-0008 is Accepted and immutable; changing its balance row is a superseding-ADR decision, not a paragraph inside a costing ADR.

### The blocker is named: ADR-0016

| | |
|---|---|
| **Record** | ADR-0016 — `stock_balances` row shape and lock ordering, superseding ADR-0008 on those two points |
| **Decider** | Architecture Guardian |
| **Gate** | Wave 5 entry. Wave 5 cannot start until ADR-0016 is Accepted |
| **Notice** | A conflict notice is added at the head of [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md), in the style of ADR-0007's, under the lifecycle exception in [the ADR README](README.md) |

The notice on ADR-0008 is not optional bookkeeping. Without it, an implementer opening ADR-0008 sees an unqualified per-location balance row and a settled locking discipline, and has no way to know either is pending. That is the identical failure this ADR diagnosed for rule 16: the document the implementer actually opens does not say.

**The Architecture Guardian's ruling on the concurrency consequence**, recorded here for ADR-0016 to adopt rather than rediscover:

- The split is the right shape — quantity per `(tenant_id, product_id, location_id)`, value and average per costing scope `(tenant_id, product_id)`.
- **Lock order is coarse-before-fine:** the costing-scope row first, then location rows in `(product_id, location_id)` ascending, then batch rows in FEFO order. Every value-bearing movement touches the scope row and only some touch several location rows, so taking the coarse lock first eliminates the lock-upgrade cycle. This extends ADR-0008 §5's deterministic ordering rather than replacing it.
- **The cost is real and ADR-0008's Negative section must say so:** the costing-scope row becomes the serialisation point for a product across *all* locations. That is strictly worse than ADR-0008's current per-location ceiling and it lands on the P95 < 800 ms posting budget (ARCHITECTURE §11). It is the price of a tenant-scoped average, and it should be written down before Wave 5 rather than discovered under counter-sale load.
- **One concession falls out of §4a for free:** an inter-location transfer has `inventory_value_delta = 0` on both legs, so it takes only the two location quantity rows and never the scope lock. The zero-value transfer rule is therefore also a concurrency win — worth recording as an independent reason to keep it.
