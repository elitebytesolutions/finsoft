# ADR-0013: Kysely as the query builder, with hand-written SQL migrations

**Status:** Proposed
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Database Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

[ADR-0002](ADR-0002-postgresql-and-redis.md) chose PostgreSQL. [ADR-0003](ADR-0003-shared-database-multi-tenancy.md) requires a base repository that injects the tenant predicate. [ADR-0004](ADR-0004-postgresql-row-level-security.md) requires `app.tenant_id` to be set per transaction so RLS policies resolve. [ADR-0011](ADR-0011-money-representation.md) requires `numeric` to arrive in TypeScript as an exact decimal, never a float. [ARCHITECTURE.md §2](../ARCHITECTURE.md) states that a module's `domain/` layer contains "no NestJS, no ORM, no HTTP".

No ADR has said *how* TypeScript talks to PostgreSQL. That gap is load-bearing: the data-access choice decides whether those four requirements are mechanically enforceable or merely aspirational. It also decides who owns the schema. [IMPLEMENTATION.md §11](../IMPLEMENTATION.md) requires migrations to be immutable, numbered and forward-only, and [AGENTS.md](../../AGENTS.md) rule 6 requires Database Guardian review of each one — which is only reviewable if a migration is SQL a human can read, rather than a diff a tool generated.

The deeper risk is ownership. A full ORM wants to own the schema, derive it from decorated classes, and generate migrations. In a system whose schema *is* the compliance surface — RLS policies, `CHECK` constraints, grants, triggers, append-only audit — an ORM that treats DDL as a derived artefact inverts the authority model in [AGENTS.md](../../AGENTS.md): generated code would become the schema, and the schema is where the invariants live.

## Decision

### Kysely is the only query builder

`kysely` is the sole data-access library. It is a typed query builder: it has no entity manager, no lazy loading, no identity map and no change tracking.

Kysely does ship a DDL builder (`db.schema.*`) and a TypeScript `Migrator`. **Neither is used.** The property this ADR relies on is narrower and sufficient: *Kysely never derives DDL from TypeScript and never generates a migration from a schema diff.* Both unused surfaces are lint-forbidden below, so the ownership guarantee is enforced rather than assumed.

### Two import boundaries, not one

Connection ownership and query construction are separate concerns and get separate rules.

**Connection ownership — `packages/database` only.** The `pg` package, `Pool` construction, `withTenant`, `withGlobal`, `set_config`, and `.transaction()` / `.startTransaction()` exist in `packages/database` and nowhere else.

**Query construction — an allowlist.** The Kysely type surface and the `sql` tag are importable by `packages/database`, `packages/accounting-kernel`, `packages/inventory-kernel`, `packages/reporting`, and `modules/*/infrastructure/**`.

This split is required by documents already in force. [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) requires that any repository method writing `journal_entries` or `journal_lines` appear only inside `packages/accounting-kernel`; [ARCHITECTURE.md §2](../ARCHITECTURE.md) defines `modules/*/infrastructure/` as "repository implementations, external adapters, mappers" and `packages/reporting` as holding "query builders". A single "`packages/database` only" rule would have forced every query in the ERP into one package, contradicting both.

Everything else is forbidden: all of `modules/*/domain/**`, `modules/*/application/**`, `modules/*/api/**`, and all of `apps/*`. A module's `domain/` layer never sees a Kysely instance, a transaction handle, or a generated row type — it sees domain objects.

### The schema is hand-written SQL

```
database/migrations/001_create_tenants.sql
                    002_create_users.sql
                    003_create_accounts.sql
```

- Migrations are plain `.sql`, numbered, forward-only, and immutable once applied. Kysely's TypeScript migration API is not used.
- **One transaction per migration file.** A file either applies whole or not at all; a failure does not leave the schema half-migrated.
- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. A migration needing it carries the marker `-- kysely:no-transaction` on its first line, and the runner applies that file outside a transaction. This is the only exemption, and it is visible in the file.
- Rollback is a new forward migration, never an edit and never a `down`. This matches [ADR-0006](ADR-0006-immutable-posted-transactions.md)'s posture towards the data the schema holds.
- RLS policies, grants, `CHECK` constraints and triggers live in these files. They are the enforcement surface for rules 1, 4, 5, 6, 7, 9 and 12, so they are reviewed as SQL by the Database Guardian, not generated.
- Filenames are three-digit and strictly sequential. Two parallel worktrees ([IMPLEMENTATION.md §3](../IMPLEMENTATION.md)) both writing `047_*.sql` will collide at merge. That is deliberate: migrations serialise through review rather than interleaving silently.

### The migration runner is a deploy-time CLI, never application boot

The runner lives in `packages/database` as a **separate CLI entrypoint**. It never executes on application start.

- It connects with `MIGRATION_DATABASE_URL` as `finsoft_migration`, the only role holding DDL and `BYPASSRLS` ([INFRASTRUCTURE.md §5](../INFRASTRUCTURE.md)). The application's `finsoft_app` role cannot migrate.
- It takes a PostgreSQL advisory lock first, so two deploy replicas cannot race.
- It creates `schema_migrations` itself if absent. That table carries no `tenant_id` and is on ADR-0003's global-table allowlist.
- It is raw SQL against `schema_migrations` and does **not** import the generated types. `schema.d.ts` is committed, so a fresh clone typechecks offline; only *regeneration* needs a live database.

### Types flow database to TypeScript, never the reverse

`kysely-codegen` introspects the live schema and emits `packages/database/src/generated/schema.d.ts`, which is committed. The database is the source of truth; the types are the derived artefact. CI regenerates and fails on drift.

### `numeric` never becomes a float — in either direction

`node-postgres` returns `numeric` (OID 1700) and `int8` (OID 20) as JavaScript strings by default. That default is load-bearing, and so is the write side, which is where the real hole is.

**Reads.** The following are forbidden repository-wide, in any import form: `setTypeParser` (from `pg` or `pg-types`), `pg.defaults`, and the `types` option on `Pool`, `Client` or a query config. `pg-types` may not appear in any `package.json`. A positive runtime assertion at pool construction checks that `getTypeParser(1700)` and `getTypeParser(20)` still return strings for a known input — one positive check beats four negative greps.

**Writes.** `kysely-codegen` by default emits `ColumnType<string, number | string, number | string>` for `numeric`. The read type is correct; **the insert and update types accept `number`**. Left alone, this compiles:

```ts
insertInto('journal_lines').values({ debit_amount: 0.1 + 0.2 })   // writes 0.30000000000000004
```

That passes lint and passes any read-side round-trip test, and it defeats rule 6 through the one path this ADR exists to close. Generation is therefore pinned: `numericParser: "string"`, with a type override rendering `numeric` and `int8` as `ColumnType<string, string, string>` — carrying the branded `Money` / `UnitCost` / `Quantity` types from `packages/validation` where the column's role is known. A JS `number` assigned to a money column must not compile.

Money leaves the driver as a string and is parsed only by `Money.from` ([ADR-0014](ADR-0014-decimal-js.md)). There is no other path in or out of a `numeric` column.

### The tenant predicate is structural

Every tenant-scoped unit of work runs through one wrapper in `packages/database`:

```ts
await db.withTenant(async (tx) => { /* ... */ });
```

It takes **no tenant argument**. It reads `TenantContext` itself, so there is no parameter into which `req.body.tenantId` could be passed — satisfying [ADR-0004](ADR-0004-postgresql-row-level-security.md)'s requirement that the value come from the verified JWT claim only, as a property of the signature rather than a convention.

It opens a transaction and issues:

```sql
SELECT set_config('app.tenant_id', $1, true)
```

parameterised, exactly as [ADR-0004](ADR-0004-postgresql-row-level-security.md) specifies. (`SET LOCAL` takes no bind parameters, so spelling it that way would require interpolating the tenant id as literal SQL — an injection surface on the one value that decides tenancy.) The `true` makes it transaction-scoped, so a pooled connection cannot carry a tenant id to the next checkout.

The handle it yields is a **branded** `TenantTx`, constructible only inside `withTenant`. A branded type alone is forgeable with `as`, so three mechanisms hold the line together: the brand; a rule confining `.transaction()` and `.startTransaction()` to `packages/database`; and a lint rule forbidding type assertions to `TenantTx`. The base repository accepts only this handle.

### `withGlobal` is the one narrow exception

Some work legitimately has no tenant: login and tenant provisioning ([ADR-0004](ADR-0004-postgresql-row-level-security.md)), global reference tables such as currency and country codes and COA templates ([ADR-0003](ADR-0003-shared-database-multi-tenancy.md)), the outbox dispatcher enumerating tenants before setting each batch's tenant id ([ADR-0010](ADR-0010-transactional-outbox.md)), and `schema_migrations` itself.

`withGlobal(fn)` serves exactly these. It is typed against a global-tables-only schema view, so a tenant-owned table is not addressable inside it, and it is governed by the same lint rule that guards `set_config`. It is named here deliberately: an unnamed escape hatch gets invented ad hoc by the first agent who needs one, and it will not be narrow.

### Pool configuration

`packages/database` constructs one `Pool` per process as a singleton. [ADR-0004](ADR-0004-postgresql-row-level-security.md) calls pool discipline "the one way RLS can be defeated by configuration", so the settings are fixed here: `max` per app and worker; `statement_timeout`; `idle_in_transaction_session_timeout`, mandatory because every unit of work is a transaction; and `application_name` for attribution. If an external pooler is ever introduced, **transaction pooling mode is the only permitted mode** — a pooler that multiplexes mid-transaction breaks `set_config` scoping and with it ADR-0004.

### Case mapping is explicit

Generated types are `snake_case`; domain objects are `camelCase`. Kysely's `CamelCasePlugin` is **not** used. Mapping happens in the `mappers` that [ARCHITECTURE.md §2](../ARCHITECTURE.md) already places in `modules/*/infrastructure/`, so the boundary between a database row and a domain object stays visible rather than becoming process-wide magic.

## Consequences

### Positive

- The schema stays readable, reviewable SQL, so the Database Guardian reviews a migration rather than a tool's output.
- Nothing competes with `database/migrations/` for schema ownership, and the competing surfaces Kysely does ship are lint-disabled rather than trusted.
- `set_config` and explicit transaction boundaries are first-class. ADR-0004's backstop works because `withTenant` is the only entry point and takes no tenant argument.
- Compile-time query typing against the real schema: a renamed column breaks the build, and a `number` written to a money column does not compile.
- Kysely compiles to plain SQL with no runtime layer, keeping [ARCHITECTURE.md §11](../ARCHITECTURE.md)'s posting budget (P95 under 800 ms) attainable and profilable.

### Negative / accepted costs

- No migration autogeneration. Every table, index, policy and grant is typed out by hand. Slower per migration, accepted deliberately: the schema is the compliance surface.
- Kysely has a smaller community than Prisma or Drizzle and fewer worked examples for agents to imitate. The repository base in `packages/database` must be well documented, because most code will copy it.
- `kysely-codegen` requires a live database, so regeneration is a step in CI and local setup.
- Relation loading is manual. Joins and result shaping are written explicitly.
- The type-override configuration for `numeric` is non-default and must be maintained as `kysely-codegen` evolves. A CI assertion guards it, because the failure mode is silent.

## Alternatives considered

**Prisma.** Rejected. It wants to own the schema through `schema.prisma` and generate migrations, inverting the ownership this ADR protects. RLS support requires escaping to raw queries for `set_config`, and its connection handling makes per-transaction session variables awkward — exactly the mechanism ADR-0004 depends on. Its own `Decimal` type would also introduce a second decimal implementation alongside ADR-0014's.

**Drizzle ORM.** Rejected, though closest. Drizzle does not force generated DDL — `drizzle-kit` supports custom and empty migrations and has first-class RLS and policy support, so the naive objection does not hold. The decisive one is different: with Drizzle the TypeScript schema is an **input**, which makes the "regenerate from the live database and fail on drift" check above impossible. There is no derived artefact to compare, so two sources of truth — the TS schema and the hand-written policies, grants and triggers — must be reconciled by hand forever. Kysely's direction of flow is the whole point.

**Raw `pg` with a hand-rolled repository base.** Rejected on cost, not principle. It satisfies every requirement here and adds no dependency, but forfeits compile-time query typing across a schema of this size, and the query-building code we would write is the library we would be declining to adopt.

**TypeORM / Sequelize.** Rejected. Entity-decorator ORMs with change tracking and lazy loading; the active-record and identity-map patterns conflict with the explicit transaction boundaries ADR-0004 requires, and their column transformers and entity hydration add a conversion layer over `numeric` that this ADR spends its length removing.

## Compliance

**Boundaries**
- Dependency rule: `pg`, `Pool` construction, `set_config`, `.transaction()` and `.startTransaction()` appear only in `packages/database`.
- Dependency rule: `kysely` and the `sql` tag are importable only by `packages/database`, `packages/accounting-kernel`, `packages/inventory-kernel`, `packages/reporting` and `modules/*/infrastructure/**`.
- Dependency rule: `modules/*/domain/**` may not import `packages/database`, `kysely`, or the generated schema types. Enforces the `domain/` purity rule in [ARCHITECTURE.md §2](../ARCHITECTURE.md).
- Lint rule: `db.schema.*` and Kysely's `Migrator` are forbidden repository-wide. DDL exists only in `database/migrations/*.sql`.
- Lint rule: `sql.raw` is forbidden; `sql.lit` and `sql.id` are allowlist-only with review. None of the three parameterise.
- Lint rule: SQL assembled by string concatenation or template interpolation outside the `sql` tag is forbidden.

**Money**
- Lint rule: `setTypeParser` (any import form), `pg.defaults`, and the `types` option on `Pool`, `Client` or query config are forbidden repository-wide. `pg-types` may not appear in any `package.json`.
- Runtime assertion at pool construction: `getTypeParser(1700)` and `getTypeParser(20)` return strings for a known input; the process refuses to start otherwise.
- CI check: the generated schema contains no `number` in any `numeric`- or `int8`-derived `ColumnType`.
- Negative type test: assigning a JS `number` to a money column does not compile.
- Integration test: `numeric` columns arrive as `string`; a property-based sample including trailing zeros and 6-decimal unit costs round-trips through `Money.from` unchanged.

**Tenancy**
- Type rule: `withTenant` takes no tenant argument; the base repository accepts only the branded `TenantTx`.
- Lint rule: type assertions to `TenantTx` are forbidden.
- Integration test: a pooled connection returned after a `withTenant` block has no `app.tenant_id` set — covers ADR-0004's pool-leakage case.
- Test: no tenant-owned table is addressable inside a `withGlobal` block.

**Migrations**
- CI check: a committed `database/migrations/CHECKSUMS` manifest is recomputed; any change to an existing line fails. This is the control that catches an edited migration in a PR — a `schema_migrations` comparison inside CI cannot, because CI migrates an ephemeral database from the very files under test, so its hashes always match.
- Pre-deploy gate: file hashes are compared against `schema_migrations` **in the target database** (staging, then production) before the runner applies anything.
- CI check: filenames strictly sequential, no gaps, no duplicates.
- CI check: destructive statements — `DROP TABLE`, `DROP COLUMN`, `DROP INDEX`, `TRUNCATE`, `ALTER TABLE ... DROP CONSTRAINT`, `ALTER COLUMN ... TYPE` — are flagged and route the PR to the required reviewer via branch protection. The control is CODEOWNERS, not a self-typed approval comment.
- CI check: `kysely-codegen` re-run against the migrated schema leaves the working tree clean.
- CODEOWNERS: `database/migrations/**` requires Database Guardian review ([IMPLEMENTATION.md §10](../IMPLEMENTATION.md)).

## Related

- [ADR-0002](ADR-0002-postgresql-and-redis.md) — PostgreSQL as the system of record
- [ADR-0003](ADR-0003-shared-database-multi-tenancy.md) — the base repository, tenant predicate and global-table allowlist
- [ADR-0004](ADR-0004-postgresql-row-level-security.md) — the RLS backstop `set_config` serves, and pool discipline
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — why journal-writing repositories live in the accounting kernel
- [ADR-0010](ADR-0010-transactional-outbox.md) — the dispatcher's use of `withGlobal` then per-tenant batches
- [ADR-0011](ADR-0011-money-representation.md) — why `numeric` must not pass through a float
- [ADR-0014](ADR-0014-decimal-js.md) — the decimal library on the other side of the driver
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §2 layout and `domain/` purity, §6 tenancy, §7 transactions
- [../IMPLEMENTATION.md](../IMPLEMENTATION.md) — §11 migration discipline, §10 required reviewers
- [../INFRASTRUCTURE.md](../INFRASTRUCTURE.md) — §5 database roles
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 6, 7, 8, 12

## Open — requires a separate ADR

**Read replicas.** [INFRASTRUCTURE.md §9](../INFRASTRUCTURE.md) puts a reporting replica on the growth path and [ARCHITECTURE.md](../ARCHITECTURE.md) sends heavy analytics there, but this ADR states that *every* unit of work goes through `withTenant` against the primary pool. Replica reads are **out of scope here** and need their own record covering the second pool, staleness tolerance for financial reads, and how `withTenant` discipline applies to it. Until that ADR exists, `packages/reporting` uses the primary pool and does not open its own.
