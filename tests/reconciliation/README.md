# tests/reconciliation/

**The comparison is built and proved. The data source is deferred.**

That split is the whole design of this directory, and the rest of this file
is the reasoning behind it. The argument below for writing nothing was made
first and is preserved, because it is still right about the half it is about.

Reconciliation asserts that two independently-maintained records of the same
truth agree: the subledger against the general ledger, and the inventory
valuation against the stock ledger.

---

## What runs here now

| | |
|---|---|
| `reconciler.ts` | `reconcileSubledgerToGeneralLedger` and `reconcileValuationToStockLedger`. Pure functions over rows. No tolerance parameter exists, and a test greps to keep it that way |
| `subledger-to-gl.spec.ts` | Criteria 1-4 below, against fixtures including deliberate breaks |
| `valuation-to-ledger.spec.ts` | The Wave 6 criteria, including the `9533.3333` vs `9533.3334` case the forbidden recomputation produces |
| `dormant.spec.ts` | **The tripwire.** Fails the moment a kernel stops being `export {}` or a reconcilable table is migrated |

Nothing here imports a kernel, a repository or a posting engine, and nothing
ever should. A control that shares an implementation with the thing it checks
agrees with it by construction — including when both are wrong.

## Why the DATA is still deferred

There is nothing to reconcile. The schema is three tables — `tenants`,
`users`, `schema_migrations` — and no journal entry, stock movement, invoice
or balance exists to be reconciled against anything.

Both kernels are empty:

```
packages/accounting-kernel/src/index.ts   export {}
packages/inventory-kernel/src/index.ts    export {}
```

A test written today against live data could only assert that zero equals
zero. That is not a weak test; it is a **misleading** one, because it would
appear in the suite as reconciliation coverage and would stay green through
every change that later breaks reconciliation for real.

That reasoning survives intact, and it is why `dormant.spec.ts` exists: a
fixture-proved reconciler pointed at nothing is exactly as misleading, one
step removed, unless something fails when there is finally something to point
it at.

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

Wave 0's exit criterion asks for "one test of each kind". **That criterion is
now met** — this kind has 32 tests, and they prove the comparison detects a
break, names it, and does not net one tenant or one account against another.

**It is not met by the directory existing, and it is not met by anything here
proving a real ledger reconciles.** No real ledger exists. What is still owed
is the decision below.

Closing it requires a Product Owner decision on one of:

- accept that reconciliation coverage begins at Wave 5, and amend the exit
  criterion to say so; or
- hold Wave 0 open until a posting exists, which makes Wave 0 depend on
  Wave 5 and inverts the plan.

The first is the sensible reading of "build the factory before building the
product". It still needs deciding rather than assuming.
