# ADR-0002: PostgreSQL as system of record, Redis for cache and queues

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

The data store has to carry requirements that most application databases are never asked to satisfy:

```
atomic multi-table posting      Σ debit = Σ credit at commit time
exact decimal arithmetic        no float, ever
tenant isolation at the engine  not only in application code
referential integrity           FK everywhere, ON DELETE RESTRICT
append-only audit               INSERT-only grants, trigger-enforced
immutability of posted rows     trigger-enforced, not convention
forward-only migrations         auditable schema history
```

Separately, the system needs somewhere to put work that is *not* truth: background job queues for the outbox dispatcher, PDF generation and imports; caches for permission sets, tenant settings and chart-of-accounts lookups; distributed locks for singleton scheduled jobs.

These are two different problems and the failure modes of confusing them are severe. A cache that is treated as truth produces a balance that disagrees with the ledger; the legacy system's mutable balance columns are exactly that failure, and rules 10 and 11 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) exist because of it.

## Decision

**PostgreSQL is the system of record. Every fact that matters lives there and nowhere else.**

```
PostgreSQL (primary)
  operational tables · journal ledger · stock movement ledger
  audit_log · outbox · fiscal_periods · numbering counters · idempotency keys
```

PostgreSQL is chosen for properties the domain requires, not for familiarity:

| Requirement | PostgreSQL feature relied upon |
|-------------|-------------------------------|
| All-or-nothing posting | ACID transactions, `READ COMMITTED` + `SELECT … FOR UPDATE` |
| Exact money | native `numeric` — arbitrary precision decimal, not binary float (rule 6) |
| Tenant isolation at the engine | Row Level Security with `FORCE ROW LEVEL SECURITY` (ADR-0004) |
| Invariants that cannot be bypassed | `CHECK`, `UNIQUE`, FK with `ON DELETE RESTRICT`, deferrable constraints, triggers |
| Server-side numbering | sequences and locked counter rows (rule 12) |
| Append-only audit | per-role grants (`INSERT` only) plus a rejecting trigger (rule 9) |
| Concurrency without lost updates | MVCC, row locks, advisory locks keyed by `(tenant_id, entity)` |
| Reporting without a second store | CTEs, window functions, partial and expression indexes, materialised views |
| Operability | mature backup/PITR, logical replication, `pg_stat_statements`, wide hosting support |

**Redis is for cache, queues and locks only. It is never a source of truth.**

```
Redis
  cache        permissions, tenant settings, COA lookups, report fragments
  queues       BullMQ — outbox dispatch, PDF, email, import, scheduled jobs
  locks        singleton job election, short-lived advisory coordination
  rate limits  login throttling, export throttling
```

The operating rule, stated so no agent has to infer it:

> **If Redis is flushed at any moment, the system must lose nothing but speed.** Every key must be reconstructable from PostgreSQL. Nothing is written to Redis that is not already committed, or about to be recomputed, from PostgreSQL.

Consequences of that rule, binding on all code:

- No balance, quantity, cost, document number or sequence position is authoritative in Redis.
- Queue payloads carry **identifiers**, never financial facts. A job says `{ outboxId }`, not `{ amount, accountId }`; the worker re-reads the row from PostgreSQL. This also keeps financial payloads out of a store we do not treat as audited.
- Redis locks are an optimisation for coordination, never a correctness mechanism for the books. Where correctness depends on serialisation — stock balance, numbering counter — the lock is a PostgreSQL row lock or advisory lock inside the transaction (ADR-0008), because a Redis lock and a PostgreSQL transaction cannot commit together.
- Cached derived balances, where they exist, are written only by the kernel that owns the ledger, are reconciled by a job that alerts on drift, and are never read by a report when the ledger disagrees (rule 10/11). A reconciliation failure is a Sev-2 incident.

Version floor: PostgreSQL 15+ (for `MERGE`, `NULLS NOT DISTINCT` and current RLS behaviour), Redis 7+.

## Consequences

### Positive

- One store to back up, restore, drill and prove. RPO ≤ 15 min / RTO ≤ 4 h ([PRD.md §5](../PRD.md)) is achievable against a single primary with PITR.
- Constraints, RLS and triggers make invariants true for *every* writer — including a migration script, a psql session or a future service — not only for code that remembered to check.
- `numeric` removes an entire class of money bugs at the storage layer (rule 6).
- Reporting runs against the same transactional store in v1; no ETL lag, no "the warehouse says something different".
- Redis can be resized, restarted or lost without a data-integrity incident, which makes it cheap to operate.

### Negative / accepted costs

- Single primary is a single point of failure for writes. Accepted for v1: availability is business-hours critical with acceptable maintenance windows ([PRD.md §5](../PRD.md)). Mitigation is PITR plus a standby, not a second database technology.
- Heavy reporting competes with posting for the same instance. Mitigated by the worker, materialised views and a read replica for analytics — never by relaxing the posting path.
- `numeric` arithmetic is slower than `bigint` minor-unit integers. Accepted; correctness and readability of the schema win at this volume.
- Two runtime dependencies to operate instead of one. Accepted because the alternative (queues in PostgreSQL) has its own costs, and Redis is disposable.
- Team must know PostgreSQL deeply — RLS, lock modes, trigger semantics, planner behaviour. Treated as a required competency, not an optional one.

## Alternatives considered

**MySQL / MariaDB.** Rejected. No Row Level Security, which would move the entire tenant-isolation backstop into application code and make ADR-0003's trade-off unacceptable. Weaker `CHECK` constraint history and a less capable planner for ledger queries.

**MongoDB or another document store.** Rejected outright. No multi-row ACID semantics we would trust for posting, no decimal-by-default arithmetic, no foreign keys, no RLS. A double-entry ledger is the most relational data that exists.

**Redis (or another in-memory store) as a read model of truth.** Rejected. Any read path that can answer from a store the ledger did not write is a route to a number that cannot be traced to a posting, which contradicts the product's one-sentence definition ([PRD.md §1](../PRD.md)).

**Queues in PostgreSQL (`SELECT … FOR UPDATE SKIP LOCKED`) instead of Redis.** Seriously considered — it removes a dependency and keeps job state transactional. Rejected for v1 because the outbox already gives transactional handoff (ADR-0019), and Redis/BullMQ supplies scheduling, retries with backoff, delayed jobs, concurrency control and a usable dashboard we would otherwise build. Note that the `outbox` table *is* a PostgreSQL queue; Redis carries only the dispatch signal.

**A separate analytics database / OLAP store in v1.** Rejected as out of scope ([PRD.md §9](../PRD.md)). Revisit when a report cannot meet its budget on a read replica.

## Compliance

- Schema test: no column of type `float4`, `float8`, `real`, `double precision` or `money` exists anywhere in the schema (rule 6). Fails the build if one appears.
- Schema test: every tenant-owned table has RLS enabled and forced (ADR-0004), asserted from `pg_class`/`pg_policy`.
- Schema test: no foreign key on a financial relationship uses `ON DELETE CASCADE`; financial FKs are `ON DELETE RESTRICT` (rule 4).
- Lint rule: Redis client imports are forbidden inside `packages/accounting-kernel`, `packages/inventory-kernel` and any `modules/*/domain` — the truth path does not talk to the cache.
- Lint/type rule: queue job payload types are restricted to identifier-shaped DTOs; a job payload containing a `Money` or amount-typed field fails type-check.
- CI: a `redis-flush` integration test flushes Redis mid-suite and asserts the FinancialInvariantSuite still passes and all figures still reconcile.
- Reconciliation job proves cached derived balances equal the ledger and alerts on drift (rule 10/11); drift is a Sev-2 incident.

## Related

- [ADR-0001](ADR-0001-modular-monolith.md) — one deployable, one transaction, one database
- [ADR-0003](ADR-0003-shared-database-multi-tenancy.md) — how tenants share that database
- [ADR-0004](ADR-0004-postgresql-row-level-security.md) — the PostgreSQL feature that makes sharing safe
- [ADR-0019](ADR-0019-transactional-outbox.md) — why the queue never receives uncommitted work
- [ADR-0011](ADR-0011-money-representation.md) — `numeric` precision and scale
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 6, 9, 10, 11, 12
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §1 shape of the system, §7 transactions and the outbox, §13 technology decisions
