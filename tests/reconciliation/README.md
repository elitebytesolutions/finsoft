# tests/reconciliation/

**Empty, and deferred. This is a record of that decision, not a placeholder.**

Reconciliation asserts that two independently-maintained records of the same
truth agree: the subledger against the general ledger, and the inventory
valuation against the stock ledger.

---

## Why nothing runs here yet

There is nothing to reconcile. The schema is three tables — `tenants`,
`users`, `schema_migrations` — and no journal entry, stock movement, invoice
or balance exists to be reconciled against anything.

Both kernels are empty:

```
packages/accounting-kernel/src/index.ts   export {}
packages/inventory-kernel/src/index.ts    export {}
```

A test written today could only assert that zero equals zero. That is not a
weak test; it is a **misleading** one, because it would appear in the suite as
reconciliation coverage and would stay green through every change that later
breaks reconciliation for real.

---

## The deferral

| | |
|---|---|
| **Scope** | Subledger-to-GL and valuation-to-ledger agreement |
| **Deferred to** | **Wave 5** for the first suite (posting exists), **Wave 6** for inventory valuation |
| **Blocked by** | ADR-0005's posting engine and ADR-0008/0018's movement ledger. ADR-0018 is currently **rejected** and carries 19 required changes |
| **Owner** | Accounting Guardian for the invariants; QA Engineer for the suites |

---

## Acceptance criteria, when it lands

### Subledger to general ledger — Wave 5

1. For every control account — receivables, payables, inventory — the sum of
   its subledger balances **equals** the GL account balance. Exact equality.
   **No tolerance parameter**, per NON_NEGOTIABLES §4.
2. Asserted after a mixed run of postings and **reversals**, not a clean
   sequence. A reconciliation that only holds when nothing was corrected is
   not a reconciliation.
3. Holds **per tenant**, and proves it does not hold by accident because a
   single tenant's data was used.
4. Detects a deliberately introduced break — a journal line written without
   its subledger row — and names which account and which tenant.

### Inventory valuation to the stock ledger — Wave 6

1. `stock_balances.value_on_hand` equals `Σ stock_movements.inventory_value_delta`
   for its costing scope. This is ADR-0015's Invariant 10, second form.
2. Quantity and value reach zero **together** — ADR-0015's deferred
   `(quantity = 0) ⟺ (value = 0)` control, which ADR-0018 was asked to site and
   has not yet.
3. The valuation is **never** recomputed as `quantity × average_cost` in the
   test itself. ADR-0015 §7 forbids that everywhere, and a reconciliation
   suite that computes the forbidden figure to check the correct one has
   written the bug into the control.
4. Runs against the golden scenarios, so the expected numbers are
   hand-computed rather than produced by the implementation under test.

---

## Scope approval

Wave 0's exit criterion asks for "one test of each kind", and this kind has
none. **That is a gap in the Wave 0 deliverable and is recorded as one** —
not counted as delivered because the directory exists.

Closing it requires a Product Owner decision on one of:

- accept that reconciliation coverage begins at Wave 5, and amend the exit
  criterion to say so; or
- hold Wave 0 open until a posting exists, which makes Wave 0 depend on
  Wave 5 and inverts the plan.

The first is the sensible reading of "build the factory before building the
product". It still needs deciding rather than assuming.
