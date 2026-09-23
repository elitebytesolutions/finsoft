# tests/performance/

## What runs here today

`infrastructure-latency.spec.ts` — round-trip cost of the foundation: a
connection acquired, a tenant context set, a trivial query, a transaction
committed.

It exists to catch order-of-magnitude regressions that are invisible in a
correctness test — a pool misconfigured so every call opens a fresh
connection, a tenant context that costs its own round trip, a database that is
environmentally slow. Thresholds are deliberately loose because this runs on
laptops and on shared CI runners, and a performance test that fails for
scheduling reasons gets deleted.

**These numbers are not the ARCHITECTURE §11 budget and may not be quoted as
evidence about it.** The budget is about a business transaction; this measures
the plumbing underneath one.

---

## Deferred: the ARCHITECTURE §11 budgets

| | |
|---|---|
| **Scope** | P95 latency for posting a sale, and the other §11 budgets |
| **Deferred to** | **Wave 5** — the first wave in which a posting exists |
| **Blocked by** | There is no business transaction to measure. `packages/accounting-kernel` and `packages/inventory-kernel` are `export {}`; no journal entry, stock movement or invoice can be produced |
| **Owner** | QA Engineer, with the Architecture Guardian for the budget itself |

### Why it cannot be written now

§11 budgets **posting a sale**: stock movement, COGS, revenue, tax,
receivable, journal and audit, committed atomically. Every one of those is
Wave 5 or later. A test written today could only measure a `SELECT 1` and call
it a posting budget, which is worse than no test — it would report a
comfortable P95 for something that does not happen, and that number would be
quoted.

### Acceptance criteria, when it lands

1. Measures a **real posted sale** end to end, through `postingEngine.post`,
   against a schema with its production indexes — not a synthetic query.
2. Reports **P95 and P99** over a stated sample size, not a mean. A mean hides
   exactly the tail the budget is about.
3. Runs on **production-like hardware**, as §11 requires. Staging is a
   different provider with different CPU and storage
   (INFRASTRUCTURE §1) and its numbers predict nothing.
4. Includes the **contended** case, not only the quiet one: concurrent postings
   of the same product, which is where ADR-0018's costing-scope row
   serialises every branch.
5. States the hardware, the dataset size and the concurrency with the result.
   A latency number without those three is not reproducible.
6. Fails the build when the budget is exceeded. A performance test that only
   reports is a dashboard.

### Scope approval

Wave 0's exit criterion asks for "one test of each kind". This directory has
one, and it is honest about what it covers. **Whether that satisfies the
criterion, or whether Wave 0 requires the §11 budget itself, is a Product
Owner decision** — recorded here rather than assumed, because the difference
is between a delivered foundation and a deferred one.
