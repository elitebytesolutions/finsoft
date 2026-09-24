# ADR-0008: Inventory movement ledger and FEFO batch selection

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

---

> ## ⚠ Conflict notice — three provisions are pending supersession
>
> **This ADR is still in force.** Implement it, with the three exclusions below. This notice annotates status only; the decision, rationale and consequences are untouched, per the lifecycle exception in [the ADR README](README.md).
>
> [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) puts the **costing scope at the tenant**, while this record specifies `stock_balances(tenant_id, product_id, location_id, quantity, avg_cost)` — an average **per location**. As specified, either every location's `avg_cost` holds a duplicate of a tenant-level number that can drift between rows, or an inter-location transfer silently moves value. Adding `value_on_hand` inherits the ambiguity, and the locking discipline compounds it.
>
> | Provision | Status |
> |---|---|
> | `stock_balances` row shape (`avg_cost` per location) | **Pending** — do not build against it |
> | §5 lock ordering | **Pending** — a tenant-scoped value row changes it; see ADR-0015's recorded ruling |
> | §4 negative-stock policy — the tenant policy and the `inventory.negative_allow` permission | **Withdrawn.** [ADR-0017](ADR-0017-stock-availability-enforced-at-posting.md) prevents negative stock at posting; there is no authorised negative-stock path and no such permission. §4's *rejection* branch and its error shape stand and are unchanged |
> | Everything else — the movement ledger as the sole source of quantity, all writes through the inventory kernel, FEFO batch selection, the reconciliation job | **In force, unchanged** |
>
> **Replacement:** ADR-0018, decided by the Architecture Guardian, is a **Wave 5 entry gate**. Wave 5 cannot start until it is Accepted. ADR-0015 §Open records the Guardian's ruling on the row shape and on coarse-before-fine lock ordering for ADR-0018 to adopt.
>
> This notice is removed when ADR-0018 lands.

---

## Context

The legacy system kept quantity in a mutable column on the product record. Every module that moved stock updated it directly, under last-writer-wins semantics, with no record of the movement that caused the change. When the physical count disagreed with the system — which it did — there was nothing to reconcile against, because the number had no history.

Rule 10 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) closes that off: the stock movement ledger is the sole source of truth for quantity. There is no `products.quantity_on_hand` that *is* the truth.

Two further requirements shape this ADR. The catalogue is batched and expiry-dated ([PRD.md §4.6](../PRD.md)), so the system must decide which batch a movement consumes — a decision with regulatory weight for expiring goods, not merely a convenience. And concurrent counter sales of the same product must not be able to drive stock negative (rule 15), which is a locking problem, not a validation problem.

## Decision

### 1. The movement ledger is the only truth for quantity

```
quantity_on_hand(product, location) := Σ stock_movements WHERE direction = 'IN'
                                     − Σ stock_movements WHERE direction = 'OUT'
```

`stock_movements` is append-only. Rows are never updated and never deleted (ADR-0006). A movement that was wrong is neutralised by a reversing movement in the opposite direction, which carries its own row, its own reason and its own recorded cost.

A denormalised balance row — `stock_balances(tenant_id, product_id, location_id, qty, avg_cost)` — exists **for performance and for locking**. It is a cache with two obligations (rule 10):

- It is written **only** by `packages/inventory-kernel`, in the same transaction as the movement that changes it.
- It is reconciled by a job that proves `stock_balances.qty = Σ stock_movements` and alerts on drift. Drift is a Sev-2 incident, not a rounding note. No report reads the cache when the ledger disagrees.

### 2. One way in: `inventoryKernel.postMovement`

**No module writes `stock_movements` or `stock_balances` directly.** Sales does not `UPDATE products`. Procurement does not insert a movement row. Every quantity change in the system, without exception, goes through:

```ts
await inventoryKernel.postMovement({
  tenantId, productId, locationId, batchId,
  direction: 'OUT', quantity, reason: 'SALE',
  referenceType: 'sale', referenceId, occurredAt, actor,
}, tx);
```

`batchId` is optional on an outward movement — omitted, the kernel selects by FEFO (below). Supplied, the kernel validates the batch belongs to the product, the location and the tenant, and that the selection is authorised (below).

The kernel owns, and is the only owner of: the quantity ledger, batch and expiry selection, weighted-average valuation (ADR-0007), the negative-stock policy, and the `unit_cost` / `cogs_amount` figures that the accounting kernel consumes for COGS (ADR-0005). Like the posting engine, it takes the caller's `tx` and never opens its own — so the movement, the journal entry, the audit record and the outbox row commit together or not at all.

```
sales use case                            (modules/sales/application)
  BEGIN
    inventoryKernel.postMovement(OUT …)   → qty ledger + batch + cost
    postingEngine.post(SALE_POSTED …)     → journal + numbering + audit
    INSERT INTO outbox                    → invoice PDF, FBR push
  COMMIT
```

### 3. FEFO batch selection

For expiry-dated products, an outward movement consumes the **first-expired-first-out** batch:

```
candidate batches for (tenant, product, location) with qty_available > 0
  ORDER BY expiry_date ASC NULLS LAST, received_at ASC, batch_id ASC
  → consume from the head, splitting across batches when one is insufficient
```

- Ordering is deterministic. `expiry_date` is the primary key of the ordering; `received_at` then `batch_id` break ties so two concurrent runs never disagree.
- Already-expired batches are **not** silently consumed. A batch past its expiry date is excluded from FEFO selection; moving it requires an explicit write-off (`STOCK_WRITTEN_OFF`) or an authorised override with an audit record. Selling expired goods is a compliance failure, not an inventory rounding.
- A movement may split across batches. One requested quantity of 100 against batches of 60 and 40 produces two movement rows, each with its own batch, expiry and recorded cost.
- Manual batch override is permitted where a physical reality requires it (the storekeeper picked a different carton), requires a permission, records the FEFO batch that *would* have been chosen, and writes an audit record. It is never silent.
- Non-batched products skip batch selection entirely; the movement carries a null `batch_id`.

FEFO decides **which batch is physically consumed**. Weighted average decides **what it cost** (ADR-0007). These are separate concerns, both owned by this kernel, and they do not collapse into one calculation: a movement that consumes batch B-042 is costed at the product's current weighted average, not at B-042's receipt cost.

### 4. Negative stock: blocked or authorised, never silent

```
requested OUT quantity vs available quantity
  │
  ├─ sufficient            → movement posts
  │
  ├─ insufficient, default → REJECTED with a domain error naming
  │                          product, location, available qty, requested qty
  │                          (not a generic 400, not a silent clamp to zero)
  │
  └─ insufficient, and the tenant policy permits negative stock
                           → requires the inventory.negative_allow permission
                           → writes an audit record
                           → raises an operational alert
                           → movement posts, balance goes negative, flagged
```

The default is rejection. Permitting negative stock is a per-tenant policy plus a per-user permission, not a global switch and not a code path a module can choose. There is no third behaviour: a movement never silently clamps, never partially fulfils without saying so, and never defers the shortfall (rule 15).

### 5. Concurrency: the check and the insert in one transaction, under a row lock

The race is two concurrent counter sales of the last unit. Validating availability and then inserting the movement without serialising the balance row lets both pass the check.

```
BEGIN                                        -- READ COMMITTED
  SELECT qty, avg_cost
    FROM stock_balances
   WHERE tenant_id = :t AND product_id = :p AND location_id = :l
     FOR UPDATE;                             -- ← the serialisation point

  -- everything below runs while the lock is held
  check availability against the locked qty
  FEFO-select batch(es), locking batch rows in the same deterministic order
  unit_cost := avg_cost                      -- ADR-0007
  INSERT INTO stock_movements (…)
  UPDATE stock_balances SET qty = qty − :n
COMMIT                                       -- lock released
```

Binding rules:

- The availability check and the movement insert are in the **same transaction, under the same lock**. Checking availability in a prior read-only query and inserting later is forbidden — a lint-visible pattern and a review rejection.
- The balance row is created on first use (upsert), so the lock target always exists. There is no "no row, no lock" window.
- Row locks are acquired in a deterministic order — `(product_id, location_id)` ascending, then batch rows by the FEFO ordering — so a multi-line sale touching several products cannot deadlock against another doing the same in a different sequence.
- Isolation is `READ COMMITTED` with explicit locks, matching [ARCHITECTURE.md §7](../ARCHITECTURE.md). Where whole-entity serialisation is needed (a physical count posting against a location), an advisory lock keyed by `(tenant_id, entity)` is used.
- The lock is held for the minimum work needed and never across an external call — nothing touching an external system happens inside the transaction (ADR-0019).

## Consequences

### Positive

- Quantity has a history. Any balance can be explained movement by movement, back to opening, with the document and user that caused each change ([PRD.md §10](../PRD.md) criterion 3).
- A physical count variance is a posting with a valuation impact, not an unexplained adjustment to a mutable column.
- Batch and expiry are enforced by the kernel, so expiry compliance does not depend on a storekeeper's diligence or a module remembering to check.
- The concurrency rule removes the classic oversell race by construction rather than by retry-and-hope.
- One code path for quantity means one place to fix a quantity bug, and one place for the reconciliation job to check.

### Negative / accepted costs

- `stock_movements` grows without bound and is a hot table. Mitigated by `tenant_id`-leading indexes, the balance cache for reads, and partitioning later if volume demands it.
- The balance cache is a second representation of the same fact — a correctness risk accepted deliberately in exchange for lockable, fast reads, and paid for with a reconciliation job and a Sev-2 escalation path.
- `SELECT … FOR UPDATE` on the balance row serialises concurrent movements of the same product at the same location. Under counter-sale bursts this is the throughput ceiling. Accepted; the lock is held briefly and the posting budget is P95 < 800 ms.
- FEFO splitting produces multiple movement rows for one sale line, which report and UI code must handle rather than assuming one line equals one movement.
- Manual batch override is a real operational need, so the "never silent" guarantee costs a permission, an audit record and an extra dialogue in the store workflow.
- Deterministic lock ordering is a rule engineers must follow when writing multi-product operations; violations surface as deadlocks under load, which is why the ordering helper is centralised in the kernel.

## Alternatives considered

**Mutable `products.quantity_on_hand` as truth.** Rejected — this is the legacy failure being replaced, and it is forbidden by rule 10.

**Movement ledger with no balance cache, computing `SUM` on every read.** Attractive for purity and rejected on two counts: the aggregate slows as history grows and would breach the list-API budget, and — more importantly — there is no single row to lock, so the oversell race has no clean serialisation point. The cache exists as much for locking as for speed.

**Optimistic concurrency — version column, retry on conflict.** Rejected as the primary mechanism. Under the burst pattern that matters (several tellers selling the same fast-moving item), optimistic retry degrades badly and pushes a user-visible failure into the counter workflow. A short pessimistic lock is simpler and bounded.

**Application-level or Redis locks instead of database row locks.** Rejected. A Redis lock and a PostgreSQL transaction cannot commit together, so the lock can be released while the transaction is still open, or held after it aborts. Correctness locks live in the database (ADR-0002).

**FIFO for physical consumption.** Rejected for an expiry-dated catalogue. Oldest-received is not the same as first-expiring, and for goods with shelf lives the expiry date is the one that matters commercially and for compliance.

**Letting the module pass an explicit batch on every movement, with no FEFO default.** Rejected. It moves an inventory rule into feature code, and makes correct expiry rotation depend on every caller doing it right. Override remains available, audited.

**Allowing negative stock silently, reconciling later.** Rejected by rule 15. A silent negative is discovered at the count, by which time the valuation is already wrong and the cause is untraceable.

## Compliance

- Lint rule: `stock_movements` and `stock_balances` may be written only from `packages/inventory-kernel`. Any `INSERT`/`UPDATE` against them in `modules/*` or `apps/*` fails the build (rule 10). `dependency-cruiser` asserts the kernel does not import `modules/*`.
- Type-level: `postMovement` requires `tx`; no overload exists without it.
- Database: `stock_movements` is append-only — `UPDATE`/`DELETE` rejected by trigger, `DELETE` revoked from the app role (ADR-0006); `CHECK (quantity > 0)`, since direction carries the sign.
- FinancialInvariantSuite Invariant 3 (`stock balance = Σ in − Σ out`) and Invariant 10 (inventory valuation reconciles to the inventory GL account), every PR.
- Reconciliation job — `stock_balances.qty = Σ stock_movements` per tenant; drift raises a Sev-2 incident (rule 10).
- Concurrency test — N parallel sales of the last unit; exactly one succeeds, the rest fail with the domain error, and the balance never goes below zero without the `inventory.negative_allow` path.
- FEFO test — deterministic ordering, multi-batch splitting, expired batches excluded from automatic selection, manual override recording the would-be FEFO batch plus an audit record.
- Negative-stock test — default rejection carries product, location, available and requested quantities; the authorised path requires the permission, writes an audit record and raises an alert.
- Deadlock test — concurrent multi-product movements in opposing input order complete without deadlock, proving the lock-ordering helper is used.

## Related

- [ADR-0007](ADR-0007-weighted-average-costing.md) — what a movement costs, and why FEFO is a different question
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — the engine that consumes the movement's cost
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — movements are append-only, corrected by reversing movements
- [ADR-0002](ADR-0002-postgresql-and-redis.md) — why the correctness lock is a database lock
- [ADR-0012](ADR-0012-fiscal-period-locking.md) — a movement's posting is period-checked like any other
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 3, 4, 10, 15, 16
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §4 the inventory kernel, §5 dependency rules, §7 transactions and locking
- [../PRD.md](../PRD.md) — §4.6 batches, expiry and FEFO
