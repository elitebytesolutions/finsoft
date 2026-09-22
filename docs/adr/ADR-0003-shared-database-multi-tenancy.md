# ADR-0003: Shared database, shared schema, `tenant_id` discriminator

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

FinSoft is multi-tenant SaaS. Bhatti Traders is tenant #1 and the pilot, and the product must be sellable to a second trading business **with configuration only, no code fork** ([PRD.md §2, §10](../PRD.md)). Expected shape for v1 and the foreseeable years after it: tens of tenants, each a single trading business with a handful to a few dozen users, not thousands of self-serve signups.

Three tenancy models were available, and the choice determines the cost of every migration, every backup, every deploy and every isolation bug for the life of the product. It is also close to irreversible: changing tenancy model after tenants carry real financial history is a migration project, not a refactor.

The binding constraint is rule 8 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md): *cross-tenant reads and writes are impossible at both API and database layers*, and a raw `SELECT * FROM journal_entries` executed by the application role must return only the current tenant's rows — if it returns more, that is a Sev-1.

## Decision

**One database, one schema, every tenant-owned table carries a `tenant_id` discriminator.**

```sql
tenant_id UUID NOT NULL REFERENCES tenants(id)
```

Rules that follow, binding on all schema work:

- `tenant_id` is `NOT NULL` and foreign-keyed to `tenants(id)`. There is no nullable tenant column and no sentinel "global tenant" row on operational tables (rule 7).
- `tenant_id` is the **leading column of the primary access path index** on every tenant-owned table. `(tenant_id, …)` — never a trailing afterthought.
- Every unique constraint on tenant-owned data is scoped by tenant: `UNIQUE (tenant_id, document_type, number)`, not `UNIQUE (number)`.
- Every foreign key between tenant-owned tables is composite or backed by a check that both sides carry the same `tenant_id`. A journal line may not point at another tenant's account (FinancialInvariantSuite Invariant 7).
- Truly shared reference data (country codes, currency codes, unit-of-measure catalogue) lives in clearly named global tables with no `tenant_id` and no RLS. Chart-of-accounts *templates* are global seeds; an actual chart of accounts is tenant-owned.
- Tenant customisation — custom fields, document layouts, numbering formats, posting-rule variants, tax profiles, roles — is **configuration rows keyed by `tenant_id`**, never a forked code path and never a per-tenant table.

```
tenants ──┬── users ──── roles ──── permissions (per-tenant assignment)
          ├── accounts ── journal_entries ── journal_lines
          ├── products ── stock_movements ── batches
          ├── customers · vendors · sales · purchases · cheques
          ├── fiscal_periods · numbering_counters · outbox
          └── audit_log (hash-chained per tenant)

          every row above: tenant_id NOT NULL, RLS enabled + forced
```

### The honest trade-off

This model is chosen for operational economics, and it buys them at the price of a weaker structural isolation guarantee:

| | Shared DB + `tenant_id` | Database per tenant | Schema per tenant |
|---|---|---|---|
| Isolation guarantee | **Logical** — a missing `WHERE` leaks | **Physical** — separate connection string | Structural — a `search_path` mistake leaks |
| Migration cost | One migration, one run | N runs, N partial-failure states | N runs, one connection |
| Connection pooling | One pool | N pools, or a pool per request | One pool, per-session `search_path` |
| Cost per small tenant | Marginal | A whole database instance | Moderate |
| Cross-tenant admin query | Trivial | Needs federation | Needs a union over N schemas |
| Per-tenant restore | Filtered, laborious | Trivial | Straightforward |
| Noisy-neighbour blast radius | Shared | Isolated | Shared |
| Onboarding a tenant | `INSERT INTO tenants` | Provision infrastructure | Create schema, run N migrations |

With tens of tenants and a small team, database-per-tenant means every migration is a distributed deployment with partial-failure semantics — some tenants on version 47, some on 46, and a posting engine that must tolerate both. That is a permanent, recurring operational tax paid to buy an isolation property we can obtain a different way.

**The cost we are accepting is that isolation is logical, not physical: a single forgotten `WHERE tenant_id = …` is a cross-tenant data leak.** That is not a theoretical risk; it is the characteristic failure of this model.

**[ADR-0004](ADR-0004-postgresql-row-level-security.md) is what makes this trade acceptable.** PostgreSQL Row Level Security, enabled *and forced* on every tenant-owned table, with the application role holding no `BYPASSRLS`, moves the isolation guarantee out of application code and into the database engine. A forgotten `WHERE` then returns zero rows instead of another tenant's rows. This ADR is only valid in combination with ADR-0004; if RLS were ever removed, this decision would have to be reopened, not merely patched.

Defence in depth, all four layers required (rule 8):

```
JWT / session          tenant_id is a signed claim, never from request input
      ↓
NestJS TenantContext   AsyncLocalStorage, set by a global guard
      ↓
Repository layer       every query filtered; the base repository makes it the default
      ↓
PostgreSQL RLS         policy per table; app role has no BYPASSRLS   ← ADR-0004
```

## Consequences

### Positive

- One schema, one migration run, one version of the code against one version of the database. No per-tenant drift.
- Onboarding tenant #2 is inserting a row and seeding configuration — which is the explicit success criterion in [PRD.md §10](../PRD.md).
- One connection pool, so pool exhaustion is not a function of tenant count.
- Cross-tenant platform operations (usage metrics, version checks, support queries) are ordinary SQL executed by a role that is allowed to see across tenants, under audit.
- Infrastructure cost per small tenant is marginal, which is what makes selling to a second trading business viable.

### Negative / accepted costs

- **Isolation is logical.** Mitigated, not eliminated, by ADR-0004; adversarial isolation tests are a standing requirement ([PRD.md §5](../PRD.md)).
- Every developer and agent must remember that `tenant_id` is mandatory on new tables. Mitigated by a schema test that fails the build on any new table lacking it, and by the base repository making filtering the default rather than an opt-in.
- Per-tenant point-in-time restore is awkward — restoring one tenant's data means a filtered export from a PITR clone, not a simple database restore. Accepted and documented as a runbook.
- Noisy neighbours share resources. Mitigated by per-tenant rate limits, query budgets and the performance guardrails in [ARCHITECTURE.md §11](../ARCHITECTURE.md).
- A single database is a single blast radius for a catastrophic bug. Mitigated by RLS, backups and restore drills.
- Very large tenants would eventually need partitioning by `tenant_id` or extraction. That would be a superseding ADR; the `tenant_id`-leading indexes make it tractable.

## Alternatives considered

**Database per tenant.** Strongest isolation — a connection string cannot reach another tenant's data, and per-tenant restore and per-tenant encryption keys are trivial. Rejected for v1 because migrations become an N-way distributed deployment with partial-failure states, connection pooling scales with tenant count, cross-tenant operations need federation, and infrastructure cost per small tenant is material. The isolation benefit is obtainable from RLS at a fraction of the operating cost. This remains the natural target if a tenant ever demands physical separation or a jurisdiction requires it — via a superseding ADR, not a per-tenant special case.

**Schema per tenant.** A middle path: one database, one connection pool, `search_path` per session. Rejected because the isolation guarantee is not actually stronger than RLS — it rests on correctly setting `search_path` on every connection, which is the same class of mistake as a forgotten `WHERE`, but harder to test and with no engine-level backstop. It also multiplies the object count (tables × tenants), slows migrations linearly, degrades planner statistics and catalog performance, and makes cross-tenant reporting a generated union.

**Shared schema with application-only filtering (no RLS).** Rejected. This is the model whose only defence is that every developer and every coding agent writes a correct `WHERE` clause forever. It fails rule 8's requirement for enforcement at the database layer.

**Discriminator on a nullable column, with `NULL` meaning "shared".** Rejected. `NULL` semantics in RLS policies and unique constraints are a reliable source of accidental cross-tenant visibility. Global data lives in separate, explicitly global tables.

## Compliance

- Schema test: every table outside the explicit global-table allowlist has `tenant_id UUID NOT NULL REFERENCES tenants(id)`. New table without it fails the build (rule 7).
- Schema test: every tenant-owned table has an index whose **first** column is `tenant_id`.
- Schema test: every unique constraint on a tenant-owned table includes `tenant_id`.
- Schema test: every tenant-owned table has RLS enabled and forced (asserted in ADR-0004's test).
- FinancialInvariantSuite Invariant 7: no journal line references another tenant's account; extended to every cross-table financial reference.
- `tests/security/` contains adversarial isolation tests: authenticate as tenant A, attempt to read and mutate tenant B's records by ID through every public endpoint, assert 404/403 and zero rows. Run on every PR.
- The base repository in `packages/database` injects the tenant predicate; raw SQL escape hatches require an explicit, reviewed helper and are covered by the RLS test above.
- A cross-tenant read observed in any environment is a **Sev-1** incident (rule 8), not a bug ticket.

## Related

- [ADR-0004](ADR-0004-postgresql-row-level-security.md) — the backstop that makes this decision acceptable
- [ADR-0002](ADR-0002-postgresql-and-redis.md) — why PostgreSQL, and RLS as a deciding feature
- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — where `tenant_id` comes from
- [ADR-0001](ADR-0001-modular-monolith.md) — one deployable against one database
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 7, 8, 12, 17
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §6 multi-tenancy
- [../PRD.md](../PRD.md) — §2 deployment model, §10 second tenant by configuration only
