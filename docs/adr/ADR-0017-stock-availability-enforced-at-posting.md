# ADR-0017: Stock availability is enforced at posting; negative stock is prevented, not costed

**Status:** Proposed
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Depends on:** ADR-0016 — the stock lock protocol. **Not yet written.** This record cannot be implemented until it is accepted.

## Context

The legacy system (Bhatti Traders) allowed stock to go negative and carried on costing against the negative balance. That behaviour was inherited into FinSoft's costing records as an assumption: [ADR-0007](ADR-0007-weighted-average-costing.md)'s edge-case table, and then [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) §4a, both describe rules for **"authorised negative stock."**

Nobody authorised it. The phrase entered the record because the legacy system did it, and a costing ADR needed *some* rule for a state the schema permitted. **That the legacy system's behaviour explains what can go wrong does not make it a requirement.** A distribution business that can sell stock it does not have has a control failure, and the accounting consequence — cost of sales recognised against goods that did not exist, trued up later at whatever price they were eventually bought at — is a misstatement in the intervening period, not an accounting policy.

The correct treatment is **prevention plus an exception report**, and the two are not alternatives:

- **Prevention** stops the operation that would create a negative balance.
- **An exception report** detects negatives that arrive anyway — from legacy migration, a bulk import, or corruption. Prevention cannot cover data it did not create.

A proposed design got this backwards in a way worth recording, because it is an easy mistake to repeat: it filtered negatives out of the authoritative stock view (`HAVING SUM(...) > 0`) and then defined the negative-stock report as a select over that same view. **The exception report would have been permanently empty.** Filtering rows does not prevent the condition; it removes the evidence of it.

## Decision

### 1. Availability is enforced inside the posting transaction, under the stock locks

**A check before saving is not enforcement.** Two sales can each read 10 units available and each sell 8. The window between the check and the write is exactly where the overdraw happens, and it is invisible in testing because it needs concurrency to appear.

Every posting path executes this sequence, in this order, in **one** transaction:

| # | Step |
|---|---|
| 1 | Acquire the stock locks in ADR-0016's order — costing scope, then location rows ascending, then batch rows in FEFO order |
| 2 | Read the **posted** balance, and account for applicable reservations |
| 3 | Reject if insufficient — before anything is written |
| 4 | Write stock movements, valuation changes, journal entries and posting status |
| 5 | Commit, or roll every part of it back together |

Steps 2 and 3 are inside the lock held at step 1. That is the entire point; a read taken before the lock is a stale read with extra steps.

**PostgreSQL row locks serialise competing updates, but only for transactions that take them.** A posting path that skips the protocol is not slowed down by the others — it overtakes them. So the protocol is not advisory: it is the definition of a posting path, enforced in the inventory kernel, which is already the only code that may write `stock_movements` (ADR-0008).

**An aggregate stock view is not a lockable balance row.** `v_stock_balances` is a `GROUP BY` over the movement ledger; `SELECT … FOR UPDATE` against it locks nothing useful, and against some shapes PostgreSQL will refuse outright. The lock is taken on the balance rows ADR-0016 defines. This is stated because the aggregate view is the obvious thing to reach for and it fails silently.

### 2. The same protection applies to every path that reduces stock

Not just sales. **Sales, purchase returns, inter-location transfers, and receipt reversals** all reduce available stock and all can drive a balance negative. A reversal is the one most likely to be missed — reversing a receipt removes stock that may already have been sold, and it is a normal, authorised operation.

### 3. Drafts contribute nothing and consume nothing

A **draft purchase contributes no stock.** A sale may be *created* as a draft against stock that has not arrived — that is a legitimate workflow and is not blocked — but it **cannot post** until sufficient stock is itself posted. Draft status is not a reservation and does not confer one.

### 4. One document receives stock, and it is the GRN

Confirmed against the schema rather than assumed: `grn_headers` carries `supplier_bill_no`, `supplier_bill_date`, `net_amount`, `amount_paid`, `balance_amount`, `payment_mode` and `due_date`. **The GRN is the purchase invoice.** There is no separate purchase-invoice table, so there is no second document that could receive the same goods, and the double-count risk the schema is often asked about does not exist in this shape.

One gap remains and is closed here: `supplier_bill_no` is nullable and not unique, so two GRNs may be entered against the same supplier bill — each receiving stock and each raising a payable. That is the real double-count vector. It needs `UNIQUE (tenant_id, vendor_id, supplier_bill_no)` where the bill number is present.

### 5. Three views, three jobs — and the authoritative one never filters

| View | Contents | May it filter? |
|---|---|---|
| `v_stock_balances` | **All** balances, including unexpected negatives | **Never** |
| `v_available_stock` | Eligible positive stock, for pickers and sale entry | Yes — that is its job |
| `v_negative_stock` | Negative balances, read from the **authoritative** view | It *is* the filter |

`v_negative_stock` is a monitored exception report. A non-empty result is an incident, triaged against the migration or import that produced it.

### 6. Negative stock is an exception state, not a supported costing mode

This is the consequence for [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) §4a, and it changes that section's framing rather than its arithmetic.

- The phrase **"authorised negative stock" is withdrawn.** Nothing authorises it.
- The costing engine **does not** meet a negative balance during normal operation, because §1 prevents it. Its rules for the negative state are a **migration and corruption fallback**, not an operating mode, and they exist so that a negative balance arriving from outside the posting paths has defined, auditable behaviour rather than undefined behaviour.
- A posting that would *create* a negative balance is **rejected**, not costed. ADR-0015's negative-stock variance account therefore only ever sees amounts originating in imported or corrupted data — which is precisely why it must stay separate from the rounding account and be individually reportable.

## Consequences

**Positive.** Cost of sales cannot be recognised against goods that do not exist. The exception report can actually fire. The negative-stock variance becomes a rare, investigable event rather than routine noise. The costing rules stop carrying a legacy behaviour as though it were a requirement.

**Negative, and accepted.** Counter-sale throughput is bounded by the lock protocol — a real cost, already priced into ADR-0016's coarse-before-fine ruling and the P95 < 800 ms posting budget (ARCHITECTURE §11). Users who relied on selling ahead of a GRN must now post the GRN first; this is a genuine workflow change for the pilot and belongs in migration training, not in a technical note.

**Migration.** Legacy data will contain negative balances. They are imported **as they are** — not silently zeroed, which would destroy the evidence and misstate opening inventory — and they surface immediately in `v_negative_stock` for reconciliation before cutover.

## Compliance

- **Concurrency test (this is the one that matters):** two concurrent sales of 8 against a balance of 10, posted in parallel. Exactly one commits; the other is rejected for insufficient stock. Asserted against a real database, not a mock — a mocked transaction cannot exhibit the failure this ADR exists to prevent.
- **The same test for each path:** purchase return, inter-location transfer, receipt reversal.
- **Protocol test:** a posting path that reads the balance before acquiring the lock fails review; the kernel exposes no API that permits the ordering.
- **Lock target test:** `FOR UPDATE` is taken on ADR-0016's balance rows, never on an aggregate view.
- **View test:** `v_stock_balances` returns a seeded negative balance (it must not filter), `v_available_stock` excludes it, and `v_negative_stock` returns exactly it. This is the regression test for the empty-report defect.
- **Draft test:** a draft purchase does not increase available stock; a draft sale against absent stock may be saved and may not post.
- **Constraint tests:** `chk_disc_limit` rejects a discount exceeding the discountable amount **including when a contributing column is NULL**; `chk_grn_total_qty_positive` rejects a zero or NULL received quantity before any division; `chk_grn_cost_nonneg` rejects a negative `cost_per_unit`.
- **Signed-column test:** a reversal with negative `inventory_value_delta` and negative journal amounts posts successfully — proving no blanket nonnegativity constraint was applied to signed ledger columns.
- **Exception monitor:** a non-empty `v_negative_stock` raises an alert. Sev-2.

## Alternatives considered

**Allow negative stock and cost it.** This is the legacy behaviour. Rejected: it recognises cost of sales against goods that do not exist, and the correction lands in a later period — a misstatement, and under a closed period (ADR-0012) one that cannot be corrected where it belongs.

**Check availability in the application before saving.** Rejected in §1: it is a time-of-check-to-time-of-use race that concurrency testing finds and unit testing does not.

**Block negative balances with a database `CHECK`.** Not possible. A balance is an aggregate over movement rows; a row-level `CHECK` cannot see it. This is exactly why the transactional protocol and the row constraints are both needed — they enforce different things and neither substitutes for the other.

**Filter negatives out of the stock views.** Rejected, and recorded in Context as the defect that motivated this record.

## Related

- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — the movement ledger and the kernel as sole writer; carries a conflict notice pending ADR-0016
- ADR-0016 (not yet written) — `stock_balances` row shape and lock ordering. **This ADR cannot be implemented until ADR-0016 is accepted**, because it names locks ADR-0016 defines
- [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) — the carried value; §4a's negative-stock rules are reframed by §6 above
- [ADR-0012](ADR-0012-fiscal-period-locking.md) — why a later correction is not always available
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — reversal as the correction mechanism
- [.claude/DB_REFERENCE.md](../../.claude/DB_REFERENCE.md) — the legacy schema this corrects; reference material, not authority

## Open

**Reservations are named in §1 step 2 and are not specified anywhere.** What creates a reservation, how long it lives, whether a confirmed sales order holds stock, and how an expired reservation is released are all undecided. Until they are, step 2 reads posted stock only, and the reservation term is zero. This needs a Product Owner decision before Wave 5; it changes what "available" means.
