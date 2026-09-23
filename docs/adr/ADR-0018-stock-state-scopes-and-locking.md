# ADR-0018: Stock state scopes, lock targets and lock ordering

**Status:** Proposed
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Would supersede on acceptance:** [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) on three provisions — the balance row shape, §5's lock ordering, and §4's negative-stock policy. Everything else in ADR-0008 stands unchanged.

## Context

[ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) specifies one balance row:

```
stock_balances(tenant_id, product_id, location_id, qty, avg_cost)
```

That shape puts the average **per location** while [ADR-0007](ADR-0007-weighted-average-costing.md) and [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) put the costing scope at the **tenant**. The two cannot both be right, and the contradiction is not cosmetic: either every location's `avg_cost` holds a copy of a tenant-level number that drifts between rows, or an inter-location transfer moves value between them. ADR-0015 added `value_on_hand` and inherited the ambiguity.

[ADR-0017](ADR-0017-stock-availability-enforced-at-posting.md) then made the locking protocol load-bearing for correctness rather than performance: availability is enforced *inside* the posting transaction, under locks, and a balance that cannot be locked deterministically cannot be enforced. ADR-0017 names those locks and cannot be implemented until this record defines them.

This ADR resolves all three at once, because they are one decision. What the scopes are determines what the lock targets are, which determines the order they are taken in.

## Decision

### 1. Three scopes, three tables, one job each

**Quantity is physical. Value is financial. They do not share a grain.**

| Table | Grain | Holds | Why this grain |
|---|---|---|---|
| `stock_costing_state` | `(tenant_id, product_id)` | `value_on_hand`, `average_cost` | The costing scope of ADR-0007/0015. One average per product per tenant, in one row, so it cannot drift |
| `stock_location_balances` | `(tenant_id, product_id, location_id)` | `quantity_on_hand` | What is physically where. Drives availability |
| `stock_batch_balances` | `(tenant_id, product_id, location_id, batch_id)` | `quantity_on_hand`, `expiry_date` | FEFO selection (ADR-0008 §3) needs per-batch quantity, and a batch can sit in more than one location |

**`quantity_on_hand` appears on two tables and this is deliberate, not duplication by accident.** The location row is the sum of its batch rows for batched products, and is the only quantity row for non-batched products. The reconciliation job proves all three against the movement ledger:

```
stock_batch_balances.quantity_on_hand    = Σ movements for (tenant, product, location, batch)
stock_location_balances.quantity_on_hand = Σ movements for (tenant, product, location)
                                         = Σ its batch rows, where the product is batched
stock_costing_state.value_on_hand        = Σ movements.inventory_value_delta for (tenant, product)
```

All three remain **caches of the ledger** under rule 10, written only by `packages/inventory-kernel`, in the same transaction as the movement. Nothing here makes a balance row the source of truth.

**`avg_cost` is removed from the location row.** There is no per-location average. A report wanting value per warehouse does not get one — see §7.

### 2. The value scope is the tenant, and a transfer moves no value

`inventory_value_delta` is zero on both legs of an inter-location transfer (ADR-0015 §4a). Under §1 this is not merely a costing convention; it is why a transfer never touches `stock_costing_state` at all, and therefore never takes the coarse lock. See §5.

### 3. Lock targets are rows, and they always exist before they are locked

This is the provision most likely to be got wrong, because the failure is invisible until two people do the same thing at once.

**A row that does not exist cannot be locked.** `SELECT … FOR UPDATE` on a missing row returns zero rows and locks nothing — it does not block, it does not error, it succeeds emptily. Two concurrent first receipts of a new product would each find no row, each decide to create one, and each proceed as though it held a lock. One then fails on the unique index, or worse, both insert against different unique-index shapes and the balance is silently wrong.

**Therefore the lock target is materialised as part of acquiring it:**

```sql
-- Step A: ensure the row exists. Zero-valued, no-op if another transaction won.
INSERT INTO stock_costing_state (tenant_id, product_id, value_on_hand, average_cost)
VALUES ($1, $2, 0, 0)
ON CONFLICT (tenant_id, product_id) DO NOTHING;

-- Step B: now lock it. The row is guaranteed to exist, so this always locks.
SELECT value_on_hand, average_cost
  FROM stock_costing_state
 WHERE tenant_id = $1 AND product_id = $2
   FOR UPDATE;
```

Two steps, not one, and the reason is precise: `ON CONFLICT DO NOTHING` **does not lock the existing row** when it conflicts. Collapsing A and B into an upsert that appears to return the row would leave it unlocked in exactly the contended case the lock exists for. If a competing transaction has inserted but not committed, step A blocks on its index entry, then does nothing; step B then sees the committed row under `READ COMMITTED` (ARCHITECTURE:285) and locks it.

The same A-then-B pattern applies to `stock_location_balances` and `stock_batch_balances`. A zero-quantity balance row is meaningful and is never garbage-collected — it is the lock target for the next movement, and deleting it would reintroduce the race.

**Advisory locks are not used for this.** They are not tied to row lifetime, they do not appear in `pg_locks` alongside the rows they stand for, and they are released on commit without the row ever having been protected. The row is the lock.

### 4. Lock order: deterministic across the whole document, then coarse before fine

Two rules, and **both** are required. The first is the Architecture Guardian's ruling; the second closes a deadlock it does not cover.

**(a) Order the work before taking any lock.** A document with lines for products A and B, posted concurrently with one for B and A, deadlocks if each locks in line order. So the kernel collects every scope the document touches, **sorts them**, and locks in that order:

```
sort by (product_id, location_id, batch_id) ascending — nulls first, deterministic
```

Line order, insertion order and user order are all irrelevant. This applies **within** a document as well as between documents.

**(b) Within a product, coarse before fine:**

```
1. stock_costing_state      (tenant, product)                      ← coarse
2. stock_location_balances  (tenant, product, location) ascending
3. stock_batch_balances     FEFO order (expiry, received_at, batch_id)
```

Every value-bearing movement touches the costing row; only some touch several location rows. Taking the coarse lock first eliminates the lock-upgrade cycle, where a transaction holding a fine lock reaches back for a coarse one that another transaction holds while waiting for the fine one. FEFO order at step 3 is ADR-0008 §3's existing deterministic ordering, unchanged and now doing double duty.

**This applies to every posting path without exception** — sale, purchase receipt, purchase return, transfer, write-off, adjustment, sales return, and every reversal of the above. A path that locks in a different order is not merely slower; it is the deadlock.

### 5. What each path locks

Named explicitly, because "take the locks" is not implementable and because the transfer case is a genuine concession worth stating.

| Path | Costing row | Location rows | Batch rows |
|---|---|---|---|
| Sale, write-off, shrinkage | Yes | Source | FEFO |
| Purchase receipt | Yes | Destination | Receiving batch |
| Purchase return | Yes | Source | Named batch |
| Sales return | Yes | Destination | Original batch |
| Value-only adjustment (zero quantity) | Yes | — | — |
| Quantity adjustment | Yes | Affected | Affected |
| **Inter-location transfer** | **No** | Both, ascending | Both, FEFO at source |

**The transfer exemption is real and follows from §2.** `inventory_value_delta = 0` on both legs, so a transfer changes no value and has no reason to serialise against every other movement of that product. It takes two location locks in ascending order and never the costing row. This is the one concession that makes §6's accepted cost tolerable at counter-sale volume, and it is a consequence of the tenant-scoped average rather than a special case bolted on.

### 6. Transaction boundaries

- The kernel **takes the caller's transaction** and never opens its own (ADR-0008 §2, unchanged). The movement, the balance updates, the journal entry, the audit record and the outbox row commit together or not at all.
- **Every lock is held until commit.** PostgreSQL row locks release only at transaction end; there is no early release and none is wanted.
- **No lock is acquired after the first write.** All locking happens in the ordered acquisition phase, before any row is modified. A write-then-lock sequence reintroduces the ordering problem the sort in §4(a) exists to solve.
- **Read-then-lock is forbidden.** A balance read before its lock is a stale read, and the kernel exposes no API that permits the sequence (ADR-0017 §1).
- The isolation level stays `READ COMMITTED` with explicit `FOR UPDATE`, per ARCHITECTURE:285. This ADR adds no `SERIALIZABLE` requirement and no retry loop.

### 7. Non-negative stock, enforced in three places

ADR-0008 §4 permitted negative stock under a tenant policy and an `inventory.negative_allow` permission. **Both are removed.** ADR-0017 is the policy: a posting that would drive a balance negative is rejected.

| Layer | Control |
|---|---|
| **Kernel** | After computing the new quantity and before writing, assert `>= 0`; reject with a domain error naming product, location, available and requested (ADR-0008 §4's error shape, which was right) |
| **Database** | `CHECK (quantity_on_hand >= 0)` on `stock_location_balances` and `stock_batch_balances` |
| **Reconciliation** | The job in §1 proves the balances against the ledger and alerts on drift |

**The database CHECK is possible here precisely because §1 materialised the balance.** ADR-0017 correctly says a row-level `CHECK` cannot enforce an aggregate over movement rows — but `quantity_on_hand` is a column on a row, not an aggregate, so the constraint is ordinary and cheap. This is a genuine backstop, not a restatement of the kernel check: it catches a code path that bypassed the kernel, which is the case the kernel check by definition cannot catch.

**`stock_costing_state.value_on_hand` carries no such constraint.** Value can legitimately be zero, and the quantity constraint above already prevents the negative-quantity states that would strand it.

**Migration is the exception, and it is explicit.** Legacy negative balances are imported into quarantine, not into these tables (ADR-0017 §6). They do not reach `stock_location_balances`, so the constraint does not need to be relaxed, deferred or dropped for cutover. A migration that needs the constraint turned off has found a balance that should have been quarantined.

### 8. Reporting scopes, stated so §1 is not quietly undone

Value exists at `(tenant_id, product_id)`. Quantity exists at location and batch. **A per-warehouse inventory value does not exist and must not be synthesised** — computing one as `warehouse_quantity × average_cost` is exactly the recomputation ADR-0015 §7 forbids, and it would also not sum to the tenant value.

Reports show **warehouse quantities** and **tenant-scope value**. This changes page specifications in force; they are corrected with this ADR, not after it.

## Consequences

**Positive.** The average cannot drift between locations, because it exists once. Lock targets always exist, so the first-receipt race is closed. A transfer is cheap. The non-negative guarantee gains a real database backstop. ADR-0017 becomes implementable.

**Negative, and accepted.** `stock_costing_state` is a **serialisation point for a product across all locations**. Two counter sales of the same product at different branches now contend, where under ADR-0008's per-location row they did not. This is strictly worse than the current ceiling and it lands on the P95 < 800 ms posting budget (ARCHITECTURE §11). It is the price of a tenant-scoped average — the alternative is a per-location average, which is a costing decision already made against by ADR-0007 and ADR-0015.

Three tables where ADR-0008 had one: more rows, more reconciliation surface, and zero-quantity rows that are never deleted.

**Unmeasured.** The contention cost is reasoned, not benchmarked. A load test at realistic counter-sale concurrency is a Wave 5 entry condition, and if the budget is missed the resolution is a queue at the product level, not a weakening of the locks.

## Alternatives considered

**Keep the average per location.** Rejected: it is a different costing method, decided against by ADR-0007 and ADR-0015, and it makes a transfer a value-moving event.

**One row holding quantity and value at `(tenant, product, location)`.** Rejected: it forces either a per-location average or a duplicated tenant average that drifts. It also makes ADR-0015's `CHECK ((quantity = 0) = (value = 0))` unsatisfiable against a legitimate zero-value transfer, which ADR-0015 §Compliance already proved.

**Advisory locks keyed on the scope tuple.** Rejected in §3: not tied to row lifetime, invisible next to the rows they protect.

**`SERIALIZABLE` isolation instead of explicit locks.** Rejected: it changes behaviour system-wide, requires retry handling on every posting path, and ARCHITECTURE:285 already commits to `READ COMMITTED` with explicit `FOR UPDATE`. Serialisation failures under counter-sale load would surface as intermittent posting errors, which is worse than deterministic contention.

## Compliance

- **First-receipt race:** two concurrent first receipts of a brand-new product. Exactly one balance row exists afterwards and the value is the sum of both. This test fails against a naive `SELECT … FOR UPDATE` and is the regression test for §3.
- **Cross-product deadlock:** two documents, lines `(A, B)` and `(B, A)`, posted concurrently. Both complete; neither deadlocks. The regression test for §4(a).
- **Lock-order test:** a static check that every posting path acquires through the kernel's ordered acquisition helper; no path issues `FOR UPDATE` directly.
- **Transfer test:** an inter-location transfer completes without locking `stock_costing_state`, proved by observing `pg_locks` — and concurrently with a sale of the same product at a third location.
- **Non-negative backstop:** a direct `UPDATE` against `stock_location_balances` driving quantity below zero is rejected by the database, with the kernel bypassed entirely.
- **Constraint-vs-migration test:** a quarantined negative opening balance does not reach `stock_location_balances` and the constraint is never relaxed.
- **Reconciliation:** all three tables prove against the movement ledger; batch rows sum to their location row. Drift is Sev-2.
- **No per-location value:** a static check that no query multiplies a location quantity by `average_cost`; the costing table is not joinable to the location table in any reporting view.
- **Load test:** counter-sale concurrency against the P95 < 800 ms budget. A Wave 5 entry condition.

## Related

- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — superseded on three provisions; the ledger, the kernel-as-sole-writer and FEFO stand
- [ADR-0017](ADR-0017-stock-availability-enforced-at-posting.md) — the availability protocol that consumes these locks; it cannot be implemented without this record
- [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) — the carried value and the tenant costing scope this row shape serves
- [ADR-0007](ADR-0007-weighted-average-costing.md) — the costing scope decision, carrying a conflict notice
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — movements are append-only; balances are caches, not history
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §5 dependency rules, :285 isolation level, §11 posting budget

## Open

**The `location_id` grain itself.** This ADR assumes ADR-0008's location concept is right and does not revisit it. If locations are later nested (warehouse → bin), the location balance row needs a grain decision of its own.

**Batch rows for non-batched products.** Specified above as absent, with the location row carrying the quantity. If a product later becomes batched, the migration path for its existing balance is not defined here.
