# ADR-0001: Modular monolith with Next.js, NestJS and TypeScript

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

FinSoft replaces a legacy desktop accounting system at a trading business. Its output is a number filed with the FBR or used to decide solvency, so correctness dominates every other quality attribute.

The defining workload is a single sale. Posting one produces, in one logical act:

```
Sale
 ├─ stock movement      (qty out, batch selected, cost captured)
 ├─ COGS                (from the movement's weighted-average cost)
 ├─ revenue             (sales account, per posting rule)
 ├─ tax                 (output sales tax, further/extra tax)
 ├─ receivable or cash  (customer subledger or cash account)
 ├─ journal entry       (Σ debit = Σ credit, balanced, numbered)
 └─ audit record        (append-only, hash-chained)
```

Every one of these must happen, or none of them. A sale that decremented stock but failed to post revenue is a misstatement that surfaces months later, after hundreds of downstream transactions have been built on top of it.

The team is small and TypeScript-fluent end to end. Expected v1 load is one pilot tenant (Bhatti Traders) plus early SaaS tenants — hundreds of postings per day, not thousands per second. There is no scaling pressure that would justify paying a distributed-systems tax.

## Decision

FinSoft v1 is a **modular monolith**:

```
apps/web     Next.js (App Router), TypeScript — UI only, no business rules
apps/api     NestJS, TypeScript — HTTP, auth, module wiring, transaction boundary
apps/worker  NestJS, TypeScript — queue consumers, outbox dispatch, reports, imports
packages/*   accounting-kernel, inventory-kernel, auth, permissions, database, …
modules/*    sales, procurement, inventory, banking, tax, … (domain/application/
             infrastructure/api/ui)
```

One deployable API process, one PostgreSQL database, one transaction per posting:

```
BEGIN
  set app.tenant_id
  domain operations
  inventoryKernel.postMovement(...)
  postingEngine.post(...)          ← journal + numbering + audit + idempotency
  INSERT INTO outbox (...)         ← side effects, same transaction
COMMIT
```

A PostgreSQL transaction gives all-or-nothing semantics for the whole chain for free. Distributed transactions do not. Every workaround available across service boundaries — two-phase commit, sagas, compensating transactions, eventual consistency — is a way of saying "the books may be wrong for a while", which rule 1, rule 2 and rule 11 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) forbid outright.

Modularity is enforced by *boundaries in code*, not by network hops. `modules/*` are internally layered `api → application → domain`, may not import each other's internals, and may not write to each other's tables. The kernels never import feature modules. These rules are checked by `dependency-cruiser` in CI (see [ARCHITECTURE.md §5](../ARCHITECTURE.md)) — the same discipline microservices claim to provide, at compile time instead of at runtime.

### What may be extracted later

Only work that sits **outside the posting transaction**, behind the outbox (ADR-0019):

```
notifications (email, SMS)      document generation (PDF invoices, statements)
analytics / OLAP                external integrations (FBR POS, payment gateways)
file processing (imports, exports, attachment scanning)
```

These are already separated: the posting transaction writes a row to `outbox` and commits; the worker reads it afterwards. None of them can make the ledger wrong by failing, because none of them can vote on whether the ledger commits. Extracting one later is a deployment change — move the consumer to its own process — not a rewrite.

Microservice decomposition of the core domains is explicitly out of scope for v1 ([PRD.md §9](../PRD.md)).

## Consequences

### Positive

- Atomicity of the posting chain is a property of the database, not of application retry logic.
- One transaction, one isolation level, one place to reason about locking and concurrency.
- Local development is `docker compose up` plus one database; a full end-to-end test runs in-process.
- Refactoring across module boundaries is a type-checked rename, not a coordinated multi-repo release.
- Debugging a posting is reading one stack trace, not correlating seven traces across a message bus.

### Negative / accepted costs

- The whole API scales as one unit. A heavy report path and the posting path share a process; mitigated by moving analytics to the worker, a read replica or materialised views ([ARCHITECTURE.md §11](../ARCHITECTURE.md)), never by slowing posting.
- A deploy ships everything. Mitigated by a fast, gated CI pipeline and small, frequent releases.
- Module boundaries can rot silently, because nothing physical stops a bad import. This is why `dependency-cruiser` is a merge blocker rather than advice.
- One database is one blast radius. Mitigated by RLS (ADR-0004), backups and restore drills, not by sharding.
- Team ownership is by directory, not by service. Acceptable at current team size; revisit via a superseding ADR if it stops being true.

## Alternatives considered

**Microservices from day one.** Rejected. The atomicity requirement is the product. Splitting sales, inventory and accounting into services converts one `COMMIT` into a saga with compensating transactions, and a compensating transaction for a posted journal entry *is* a reversal — so we would be manufacturing the exact financial-correction workload we are trying to make rare. Operational cost (service mesh, distributed tracing, per-service schemas, contract tests) is also unjustifiable for the v1 load profile.

**Serverless functions with a shared database.** Rejected. Connection-pool pressure, cold starts against a P95 < 800 ms posting budget, and the awkwardness of holding a transaction open across an invocation boundary. No benefit at this scale.

**Monolith with no internal module structure.** Rejected. This is how the legacy system arrived at reports containing their own correction logic. Layered modules plus mechanically enforced dependency rules are the cost of not repeating that.

**Separate services now, "just in case" they are needed later.** Rejected as speculative. The extraction path is already designed (outbox + worker), so the option is preserved without paying for it now.

## Compliance

- `dependency-cruiser` runs in CI and fails the build on: `packages/accounting-kernel` or `packages/inventory-kernel` importing `modules/*`; a module importing another module's `domain/` or `infrastructure/`; `apps/web` importing `accounting-kernel` or any `modules/*/domain`.
- A lint rule forbids `fetch`/HTTP clients inside `packages/accounting-kernel` and `packages/inventory-kernel` — the kernels have no network.
- An architecture test asserts the posting path executes within a single transaction handle: `postingEngine.post(...)` requires an explicit `tx` argument and throws if called without one.
- FinancialInvariantSuite Invariant 8 (duplicated API call cannot double-post) and the golden scenarios in `tests/accounting/golden/` run on every PR and would fail loudly if the chain were split and partially applied.
- CI check: no new top-level `apps/*` service may be added without a superseding ADR — enforced by a repo-structure test over the workspace manifest.

## Related

- [ADR-0002](ADR-0002-postgresql-and-redis.md) — PostgreSQL as the single system of record
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — the posting engine that owns the transaction's accounting half
- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — the inventory kernel that owns its stock half
- [ADR-0019](ADR-0019-transactional-outbox.md) — the seam that makes later extraction safe
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 1, 2, 11, 14, 19
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §1 shape of the system, §2 repository layout, §5 dependency rules
- [../PRD.md](../PRD.md) — §9 microservice decomposition out of scope for v1
