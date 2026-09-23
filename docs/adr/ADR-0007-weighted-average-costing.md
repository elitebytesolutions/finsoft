# ADR-0007: Weighted average as the single costing algorithm

**Status:** Accepted — with a known conflict; see the notice below
**Conflict:** [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) (Proposed) would supersede this record
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

---

> ## ⚠ KNOWN CONFLICT — WAVE 5 IS BLOCKED
>
> **Do not implement inventory valuation from this record until the conflict
> below is resolved.** This ADR remains **Accepted** — it is the costing
> decision in force, and nothing has superseded it — but three of its
> provisions are known to be wrong or unsafe, and one of them contradicts a
> LEVEL 0 document.
>
> The status is deliberately *not* `Superseded`. [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md)
> is only `Proposed`, and an accepted decision cannot be superseded by a
> proposal — that would leave the repository with no accepted costing ADR at
> all. The two statuses change together, or not at all.
>
> | Provision | Problem |
> |---|---|
> | Compliance, *"closing valuation equal to `qty_on_hand × current_avg` **within the documented rounding tolerance**"* | Defines the valuation as a recomputation **and** admits a tolerance. [NON_NEGOTIABLES §4](../NON_NEGOTIABLES.md) forbids a tolerance in an invariant check and is LEVEL 0, so this clause cannot stand whatever this ADR says. |
> | Compliance, *"Rounding differences between the sum of line-level COGS and a batch-level total are posted to the rounding account"* | Posits a second residual channel. Under a carried-value model a document total is the sum of its already-rounded stored lines, so no line-versus-total residual exists and this would authorise a rounding leg on an ordinary multi-line sale. |
> | §The formula, *"`qty_on_hand + qty_received = 0` → not reachable"* | The reasoning assumes `qty_on_hand ≥ 0`, but the same table authorises negative stock. `−3 + 3 = 0` **is** reachable, and the formula then divides by zero. |
>
> This record's own §69 states the correct principle — *"the stock ledger and
> the general ledger agree because they are recording the same stored number,
> not because two algorithms happen to produce the same answer"* — which the
> Compliance clause above contradicts. ADR-0015 resolves the contradiction in
> favour of §69.
>
> Recorded here rather than left in a separate document because this is the
> file a Wave 5 implementer will read.

---

## Context

Inventory cost determines COGS, gross profit, closing stock value and therefore taxable income. It is the single figure in a trading business that is most often computed two different ways by two different screens, and the discrepancy is usually discovered at year end by an auditor.

Rule 16 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) is unambiguous: exactly one approved costing algorithm exists; no module may implement its own valuation; no report may recompute cost differently from the ledger. This ADR names the algorithm and pins down the details that decide whether two implementations agree — precision, rounding, and the moment at which cost is fixed.

Business context: a trading and distribution business dealing in batched, expiry-dated goods, transacting in PKR. Physical stock rotation is governed by expiry, not by purchase order. That is a separate question from valuation, and conflating the two is the most common modelling error in this domain.

## Decision

**Weighted average cost is the single costing algorithm for the entire system**, per tenant, per product, per costing scope. There is no per-module variation, no per-tenant variation, and no report-level alternative.

### The formula

On every inward movement, the moving weighted average is recomputed:

```
new_avg = (qty_on_hand × current_avg + qty_received × receipt_cost)
          / (qty_on_hand + qty_received)
```

`receipt_cost` is the **landed** unit cost: purchase price plus allocated freight, duty, clearing and other capitalisable landed costs, net of trade discount. Anything capitalised into stock enters through `receipt_cost`; nothing is added to the average by a later adjustment except through an explicit `STOCK_ADJUSTED` movement.

Edge cases, decided once so no implementation improvises:

| Situation | Rule |
|-----------|------|
| `qty_on_hand = 0` | `new_avg = receipt_cost` |
| `qty_on_hand + qty_received = 0` | Not reachable — an inward movement has `qty_received > 0`; a zero-quantity movement is rejected |
| `qty_on_hand < 0` (authorised negative stock) | Average is held; the negative balance is valued at the held average, and the next receipt resets it per the formula. Flagged for review (ADR-0008) |
| Outward movement | Average is **unchanged**. Only inward movements move the average |
| Purchase return | Outward movement at the current average, not at the original receipt cost |
| Sales return | Inward movement at the **average that was recorded on the original outward movement**, restoring what was taken out |

### Costing scope

The average is maintained per `(tenant_id, product_id, costing_scope)`, where the costing scope for v1 is the **tenant**, not the location. One product has one average across all warehouses; a stock transfer between locations moves quantity, not value, and does not touch the average. Per-location averaging is not implemented in v1; changing the scope requires a superseding ADR because it changes every historical valuation.

### COGS is taken at the moment of the outward movement

This is the load-bearing rule:

```
inventoryKernel.postMovement({ direction: 'OUT', quantity, … }, tx)
   │
   ├─ row-lock the (product, costing_scope) balance
   ├─ read current_avg at this instant
   ├─ unit_cost := current_avg
   ├─ cogs_amount := round(quantity × unit_cost, 4)
   └─ INSERT stock_movements (…, unit_cost, cogs_amount)   ← stored on the row
                                                              ↓
                              accounting kernel consumes cogs_amount (ADR-0005)
                              Dr COGS / Cr Inventory
```

`unit_cost` and `cogs_amount` are written **onto the movement row** and are immutable thereafter (ADR-0006). They are never recomputed:

- Not by a report. A report reads `cogs_amount` from the movement; it does not multiply quantity by today's average. A report that recomputes cost produces a gross margin that disagrees with the posted journal entry, which is rule 16's prohibition.
- Not by a back-dated receipt. A purchase entered late does not retroactively change the cost of yesterday's sales. It changes the average from its own posting forward, and if the effect is material it is disclosed, not rewritten.
- Not by a correction. A wrong receipt cost is corrected by reversal plus re-entry (ADR-0006); the reversal's own movements carry their own recorded costs, and the arithmetic comes out right because both legs are recorded facts rather than recomputations.

The consequence to internalise: **the stock ledger and the general ledger agree because they are recording the same stored number, not because two algorithms happen to produce the same answer.** FinancialInvariantSuite Invariant 10 (inventory ledger valuation reconciles to the inventory GL account) is only provable because of this.

### Precision and rounding

Per [ADR-0011](ADR-0011-money-representation.md):

```
quantities            numeric(19,6)
unit costs / averages numeric(19,6)     ← 6 dp, because the average divides
amounts (COGS, value) numeric(19,4)     ← 4 dp, PKR
```

- The average is stored at 6 decimal places and the division is performed with sufficient intermediate precision, rounded **half-up to 6 dp once**, at the moment it is stored. Six places on a PKR unit cost is adequate for the product values in scope and is checked against the golden scenarios.
- `cogs_amount = quantity × unit_cost`, rounded half-up to 4 dp, once, at the moment the movement row is written. Never rounded twice, never rounded at display time and then re-used.
- Rounding differences between the sum of line-level COGS and a batch-level total are posted to the designated rounding account, never absorbed silently (rule 6).
- All arithmetic uses the decimal library in `packages/validation`. Native `number` arithmetic on a cost or quantity is a build failure.

Worked reference — Golden Scenario A from [NON_NEGOTIABLES.md §3](../NON_NEGOTIABLES.md):

```
Opening   100 × Rs 80.00     avg = 80.000000
Purchase   50 × Rs 100.00    avg = ((100×80)+(50×100)) / 150 = Rs 86.666667
Sale       40 × Rs 140.00    unit_cost recorded = 86.666667
                             cogs_amount = 40 × 86.666667 = Rs 3,466.67
Closing qty   = 110
Revenue       = Rs 5,600.00
Gross profit  = Rs 2,133.33
Stock value   = 110 × 86.666667 = Rs 9,533.33
```

### Weighted average and FEFO are different questions

Stated explicitly because getting this wrong is the standard failure:

```
FEFO  →  WHICH batch is physically consumed   (expiry-driven, ADR-0008)
WAC   →  WHAT it cost                         (value-driven, this ADR)
```

Selecting the earliest-expiring batch for a sale is a **physical stock** decision. It determines which batch number goes on the delivery, which expiry date prints, and which batch's quantity decrements. It does **not** determine the cost, because the average is maintained at product scope, not batch scope. A sale that consumes batch B-042 is costed at the product's current weighted average, not at what B-042 cost when it arrived.

Both concerns belong to `packages/inventory-kernel`, and both are decided inside the same `postMovement` call. They are not, and must not become, the same calculation. Batch-level costing would be a different algorithm (specific identification) and is not what this ADR approves.

See [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) for batch selection.

## Consequences

### Positive

- One algorithm means one implementation, one set of golden scenarios, and one number that every screen and every report agrees on.
- Cost stored on the movement row makes the stock ledger and the GL reconcilable by construction, not by a nightly adjustment job.
- Weighted average smooths price volatility, which suits a distribution business buying the same goods repeatedly at drifting prices, and is well understood by Pakistani accountants and acceptable to the FBR.
- No cost layers to maintain, so an outward movement is a read of one balance row rather than a walk over open purchase layers — simpler, faster, and far easier to lock correctly under concurrency.
- Back-dated transactions do not trigger a retroactive recosting cascade, which removes a whole category of "the margin report changed overnight" incidents.

### Negative / accepted costs

- Weighted average does not reflect the cost of the specific units sold. Where a business wants "what did *this* consignment earn", the answer comes from sales analysis, not from the cost ledger.
- A back-dated receipt does not correct the cost of sales already posted after it in wall-clock time but before it in business time. Accepted deliberately: the alternative is retroactive recosting, which mutates posted figures and violates rule 2. Material cases are disclosed.
- Six decimal places on the average still rounds. Repeated receipt/issue cycles accumulate a residual, which is why closing stock value is proven against the GL by Invariant 10 and any drift is a Sev-2 reconciliation incident, not a rounding note.
- Under authorised negative stock the average is a held value that is temporarily notional, and the correcting receipt can produce a visible cost step. Flagged for review by design.
- Tenants arriving from a FIFO-based legacy system will see different closing stock values at migration. This is expected, is reconciled in writing during migration ([PRD.md §8](../PRD.md)), and does not license a second algorithm.

## Alternatives considered

**FIFO.** Rejected for v1. It requires maintaining open cost layers per product per location, walking and partially consuming layers on every outward movement, and correctly locking those layers under concurrent sales. Every back-dated or reversed movement forces a re-layering pass, which either mutates posted costs (violating rule 2) or produces layers that disagree with the ledger. The reporting benefit does not justify that machinery for a distribution business. Note that FEFO gives us the *physical* rotation discipline that FIFO is usually wanted for, without the costing complexity.

**LIFO.** Rejected. Not permitted under IAS 2 and not acceptable for financial reporting in Pakistan. Not a candidate.

**Standard costing with variance accounts.** Rejected. Appropriate for manufacturing, which is explicitly out of scope ([PRD.md §9](../PRD.md)). It would require a standard-cost maintenance process, purchase price variance and usage variance accounts, and periodic revaluation — substantial operational burden for a trading business with no production.

**Specific identification / batch-level costing.** Rejected for v1. Defensible for high-value serialised goods, but it makes cost a property of the batch, which means every batch carries its own average and every FEFO selection becomes a costing decision as well as a physical one. It also makes stock transfers value-bearing. Revisit only via a superseding ADR if the product catalogue moves to serialised high-value items.

**Per-module or per-tenant choice of algorithm ("configurable costing").** Rejected outright by rule 16. Two algorithms in one codebase means two sets of golden scenarios, two reconciliation paths, and an inevitable report that picks the wrong one. Configuration covers charts of accounts and numbering, not the definition of cost.

**Recomputing cost in reports from current average.** Rejected. It is the direct cause of a margin report that disagrees with the posted P&L, and it is the legacy behaviour being replaced ([PRD.md §3](../PRD.md)).

## Compliance

- Lint rule: valuation arithmetic — any computation producing a unit cost, average cost or COGS amount — may exist only in `packages/inventory-kernel`. Occurrences in `modules/*`, `packages/reporting` or `apps/*` fail the build (rule 16).
- Schema: `stock_movements.unit_cost numeric(19,6) NOT NULL` and `stock_movements.cogs_amount numeric(19,4) NOT NULL` on every outward movement; both protected by the immutability trigger (ADR-0006).
- Schema test: no `float`/`double precision` anywhere; quantity and cost columns are exactly `numeric(19,6)`, amount columns `numeric(19,4)` (rule 6).
- Lint rule: native arithmetic operators on values typed as `Money`, `Quantity` or `UnitCost` fail type-check; the decimal library is the only path (ADR-0011).
- FinancialInvariantSuite Invariant 3 — stock balance = Σ in − Σ out for every product/location.
- FinancialInvariantSuite Invariant 10 — inventory ledger valuation reconciles to the inventory GL account balance, per tenant, per period. A failure is a Sev-2 incident.
- Golden scenarios in `tests/accounting/golden/` including Scenario A above, with hand-computed averages to 6 dp and COGS to 4 dp. Expected numbers may not be changed to match an implementation.
- Property test: a randomised sequence of receipts, issues, returns and reversals leaves `Σ cogs_amount` equal to the GL COGS balance, and closing valuation equal to `qty_on_hand × current_avg` within the documented rounding tolerance, with any residual posted to the rounding account.
- Report test: every report exposing a cost or margin figure is asserted to source it from `stock_movements.cogs_amount` or the GL, never from a recomputation.

## Related

- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — the movement ledger, FEFO batch selection, negative stock, concurrency
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — the kernel that consumes `cogs_amount`
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — why a recorded cost is never rewritten
- [ADR-0011](ADR-0011-money-representation.md) — precision, rounding and the rounding account
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 6, 10, 16; §3 Golden Scenario A
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §4 the inventory kernel
- [../PRD.md](../PRD.md) — §4.6 products and inventory, §8 migration reconciliation, §9 out of scope
