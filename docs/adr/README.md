# Architecture Decision Records

**Authority:** LEVEL 1 — below [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) (LEVEL 0), alongside [ARCHITECTURE.md](../ARCHITECTURE.md).

An ADR records a decision that the codebase is built on: what was decided, why, what it costs, and how the decision is mechanically enforced. Everything in this directory binds every engineer and every coding agent working on FinSoft.

---

## The rules of this directory

1. **ADRs are LEVEL 1 authority.** They sit under the LEVEL 0 invariants in [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) and above tickets, sprint plans and personal preference. If a ticket asks you to do something an ADR forbids, the ADR wins — stop and flag the conflict.

2. **An agent may not reverse an ADR because it found another approach convenient.** "Microservices would be cleaner here", "FIFO is easier for this report", "let me just bypass RLS for the import job" are not decisions you are authorised to make. Convenience mid-ticket is not evidence.

3. **Superseding an ADR requires a new ADR, approved by the Architecture Guardian** — and by the Accounting Guardian as well where the decision touches accounting, costing, periods or money representation. The new ADR states what it supersedes and why the original trade-off no longer holds.

4. **ADRs are immutable once Accepted.** They are superseded, never edited. A decision that is wrong in hindsight stays on the record with `Status: Superseded by ADR-00NN` so the reasoning trail survives. Correcting typos or adding links is permitted; changing the decision, the rationale or the consequences is not.

```
Proposed → Accepted → Superseded by ADR-00NN
                    ↘ Deprecated (decision no longer applies, nothing replaces it)
```

5. **A discovered violation of an ADR in existing code is reported, not silently fixed** under an unrelated ticket. Follow §4 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md).

---

## Index

| # | Title | Status | Summary |
|---|-------|--------|---------|
| [0001](ADR-0001-modular-monolith.md) | Modular monolith with Next.js, NestJS and TypeScript | Accepted | One deployable, one database transaction, because a sale must post stock, COGS, revenue, tax, receivable, journal and audit atomically. |
| [0002](ADR-0002-postgresql-and-redis.md) | PostgreSQL as system of record, Redis for cache and queues | Accepted | PostgreSQL holds all truth; Redis holds only what can be thrown away and rebuilt. |
| [0003](ADR-0003-shared-database-multi-tenancy.md) | Shared database, shared schema, `tenant_id` discriminator | Accepted | One schema for all tenants, with cheap operations bought at the price of a harder isolation guarantee — made acceptable by ADR-0004. |
| [0004](ADR-0004-postgresql-row-level-security.md) | PostgreSQL Row Level Security as the isolation backstop | Accepted | RLS enabled and forced on every tenant-owned table, with the app role subject to it, beneath three application layers. |
| [0005](ADR-0005-central-double-entry-posting-engine.md) | One central double-entry posting engine | Accepted | Modules raise typed financial events; `packages/accounting-kernel` is the only code that builds journal lines. |
| [0006](ADR-0006-immutable-posted-transactions.md) | Immutable posted transactions, correction by reversal | Accepted | Posted rows are frozen; mistakes are corrected by reversal plus re-entry, never by `UPDATE` or `DELETE`. |
| [0007](ADR-0007-weighted-average-costing.md) | Weighted average as the single costing algorithm | Accepted | One valuation method system-wide, COGS fixed at the outward movement and stored on the movement row. |
| [0008](ADR-0008-inventory-movement-ledger-and-fefo.md) | Inventory movement ledger and FEFO batch selection | Accepted | The movement ledger is the sole source of quantity; all writes go through the inventory kernel; FEFO decides which batch. |
| [0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) | Short-lived JWT access tokens with rotating refresh tokens | Accepted | Signed `tenant_id` claim, refresh rotation with reuse detection, server-side revocation, MFA for privileged roles. |
| [0010](ADR-0010-transactional-outbox.md) | Transactional outbox for all external side effects | Accepted | Emails, PDFs, FBR pushes, webhooks and cache invalidation are rows written in the posting transaction and dispatched afterwards. |
| [0011](ADR-0011-money-representation.md) | Money as `numeric` with decimal arithmetic | Accepted | `numeric(19,4)` and `numeric(19,6)`, strings in JSON, a decimal library in TypeScript, half-up rounding once, PKR base. |
| [0012](ADR-0012-fiscal-period-locking.md) | Fiscal period locking with no system bypass | Accepted | `OPEN → CLOSED → LOCKED`, enforced at the posting engine and the database, with no exemption for jobs, imports or scripts. |
| [0013](ADR-0013-kysely-and-sql-migrations.md) | Kysely as the query builder, with hand-written SQL migrations | Proposed | A typed query builder with no schema opinion; migrations stay reviewable SQL, so the database keeps ownership of the compliance surface. |
| [0014](ADR-0014-decimal-js.md) | decimal.js as the single decimal implementation | Proposed | Closes the library choice ADR-0011 deferred; a frozen cloned constructor, half-up away from zero, matching PostgreSQL. |

---

## Writing a new ADR

Copy the shape used by the records here:

```
# ADR-000N: Title

**Status:** Proposed | Accepted | Superseded by ADR-00NN
**Date:** YYYY-MM-DD
**Deciders:** Product Owner, Architecture Guardian[, Accounting Guardian]
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context
## Decision
## Consequences
### Positive
### Negative / accepted costs
## Alternatives considered
## Compliance
## Related
```

The **Compliance** section is not optional and is not prose. It names the test, constraint, trigger, CI check or lint rule that makes the decision mechanically true. A decision nothing enforces is a preference, and preferences do not get ADR numbers.

---

## Related documents

- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — LEVEL 0 invariants
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — system structure, module boundaries, dependency rules
- [../PRD.md](../PRD.md) — product scope
- [../IMPLEMENTATION.md](../IMPLEMENTATION.md) — waves, task contracts, CI gates
