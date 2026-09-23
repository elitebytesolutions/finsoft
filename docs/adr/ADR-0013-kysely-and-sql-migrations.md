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

**Receiving a handle does not make the receiver the data layer.** Calling `selectFrom`, `insertInto`, `updateTable` or `deleteFrom` on a `TenantTx` or `GlobalTx` obtained from a callback *is* query construction, and is forbidden wherever query construction is forbidden.

This needs stating because the import-based rules cannot see it. A handle arrives as a parameter, so `dependency-cruiser` finds no edge and the file reads as ordinary application code. The readiness probe in `apps/api` was written exactly this way and passed every check in the repository — an ESLint rule scoped to `apps/**` now catches it, and `tests/security/lint-boundaries.spec.ts` asserts that it does.

### The schema is hand-written SQL

```
database/migrations/001_create_tenants.sql
                    002_create_users.sql
                    003_create_accounts.sql
```

- Migrations are plain `.sql`, numbered, forward-only, and immutable once applied. Kysely's TypeScript migration API is not used.
- **One transaction per migration file.** A file either applies whole or not at all; a failure does not leave the schema half-migrated.
- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. A migration needing it carries the marker `-- finsoft:no-transaction` on its first line, and the runner applies that file outside a transaction. This is the only exemption, and it is visible in the file.
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

That passes lint and passes any read-side round-trip test, and it defeats rule 6 through the one path this ADR exists to close. Generation is therefore pinned with `--type-mapping`, rendering `numeric` and `int8` as `ColumnType<string, string, string>`. A JS `number` assigned to a money column must not compile.

Note what does **not** close this. `--numeric-parser string` is already kysely-codegen's default and governs only the *read* side, so setting it changes nothing — a reviewer who set it and stopped would have shipped the hole intact. `--type-mapping` is the flag that replaces the whole `ColumnType`.

Branding is not achievable at generation either. `--type-mapping` is keyed by PostgreSQL type, not by column, so it cannot know which `numeric` is a `Money` and which is a `Quantity`. The branded types from `packages/validation` are applied at the repository and mapper boundary, where the column's role is known.

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

The handle it yields is a **branded** `TenantTx`, constructible only inside `withTenant`. A branded type alone is forgeable with `as`, so four mechanisms hold the line together: the brand; a rule confining `.transaction()` and `.startTransaction()` to `packages/database`; a lint rule forbidding type assertions to `TenantTx`; and a runtime registry — `withTenant` records every handle it issues in a `WeakSet`, and the exported `assertIssuedTenantTx` rejects anything else. The base repository accepts only this handle.

The registry is not redundant with the lint rule. Lint fails a build, which is where a boundary violation should be caught; the registry fails a request, which is what survives a disabled rule, a file the config does not match, or a handle forged in a dependency.

### `withGlobal` is the one narrow exception

Some work legitimately has no tenant: login and tenant provisioning ([ADR-0004](ADR-0004-postgresql-row-level-security.md)), global reference tables such as currency and country codes and COA templates ([ADR-0003](ADR-0003-shared-database-multi-tenancy.md)), the outbox dispatcher enumerating tenants before setting each batch's tenant id ([ADR-0019](ADR-0019-transactional-outbox.md)), and `schema_migrations` itself.

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

Every bullet states what enforces it. Where a mechanism does not exist the bullet says so — an unimplemented claim in a LEVEL 1 record is worse than an absent one, because the next reviewer trusts it. This section is the standard this ADR sets, applied to itself.

### Boundaries — enforced

- **`pg` and `Pool` construction appear only in `packages/database`.** `.dependency-cruiser.cjs` `pg-driver-is-database-package-only`.

  This rule was **inert from the day it was written until 2026-09-23.** `options.exclude` listed `node_modules` alongside `doNotFollow`; `exclude` removes the node *and the edges to it*, so no `^node_modules/` rule could ever match. `npm run depcruise` reported a clean graph of 273 modules while `pool.ts` — which imports `pg` on line 1 — showed one dependency, `env.ts`.
- **`kysely` is importable only by the allowlist.** `kysely-is-allowlisted`.

  **The same defect, twice.** Removing `node_modules` from `exclude` was not enough: `dist` was still in the same pattern, unanchored, and `node_modules/kysely/dist/index.js` matches it. So this rule stayed inert **through the review that found the first defect and was explicitly hunting for more of it** — five files import `kysely` and the graph contained zero `kysely` edges. `zod` was in the same state for a different reason: it resolves to `index.d.cts`, and `.d.cts` was not in `enhancedResolveOptions.extensions`, so four importers produced no edges.

  The lesson is not "remember `dist`". It is that an `exclude` pattern written for **our** build output will also match a **dependency's published directory**, because that is what publishing looks like. The pattern is now anchored so build output is excluded only outside `node_modules`, and the repaired graph went 295 modules / 595 dependencies to 303 / 678.

  Neither occurrence was caught by a person reading the config; both were caught by someone asking what the rule had ever matched. That is now a test — see the harness bullet below — and it is the reason the harness is a precondition of this record rather than a deferral.
- **`modules/*/domain/**` may not import `packages/database` or `kysely`.** `domain-has-no-infrastructure-deps`.
- **`db.schema.*` and Kysely's `Migrator` are forbidden.** `eslint.config.mjs`, both negative-tested.
- **`sql.raw` is forbidden.** `eslint.config.mjs`, negative-tested — and paired with a positive control asserting the `sql` **tag** is still allowed, so the rule cannot be satisfied by banning the sanctioned form.

  `sql.raw` and `Migrator` previously claimed a negative control that did not exist: each appeared in the repository exactly twice, in its own selector and in its own message. A rule whose only occurrences are its own definition has never been observed to fire.
- **Nine boundary rules are proved to fire against a file that violates each.** `tests/security/depcruise-negative-control.spec.ts` writes a probe at a path the rule targets, cruises it against the real ruleset — importing `.dependency-cruiser.cjs` rather than restating it — and asserts the named rule fires. It discriminates: a probe that violates nothing produces no violations, and a probe that violates one rule does not trip the others. Restoring either historical `exclude` pattern turns it red.

  **Nine of seventeen, and the eight are named rather than left to inference:** `kernel-has-no-network`, `no-cross-module-internals`, `domain-is-pure`, `application-does-not-import-api`, `modules-do-not-reach-into-kernels`, `no-circular`, `not-to-dev-dep` and `no-deprecated-core` are unproven. "Every" was the word here first, and it is the word that would stop the next reviewer noticing the gap — which is precisely what this harness exists to end. The last two were degraded by the `exclude` defect and are no longer: devDependency edges are visible again under the repaired pattern, and `no-deprecated-core` targets core modules, which `exclude` never touched.
- **`set_config('app.tenant_id', …)` appears only in `packages/database`** — in a plain string, in a **template literal**, and in an `sql` tag.

  The original selector matched `Literal` only, and a template literal's text is a `TemplateElement`. It therefore missed the sql`` form, which is what `packages/database` itself writes and what anyone copying it would write. The harness exercised only the double-quoted case, so it certified a rule that missed the realistic one. Both forms are now covered and both are negative-tested.

### Money — enforced

- **Runtime assertion at pool construction:** `getTypeParser(1700)` and `getTypeParser(20)` return strings, checked before the first connection. The process refuses to start otherwise.
- **The pool opens at startup**, so that assertion — and the role check below — run at boot rather than on whichever request first touches the database. `apps/api` and `apps/worker` both call `openDatabase()`; previously neither did, and the pool opened lazily.
- **The application role is subject to RLS.** `openDatabase` refuses to start as a role holding `SUPERUSER` or `BYPASSRLS`. Necessary, not sufficient — see `lifecycle.ts`, which names the ownership, membership and policy checks it does *not* make.
- **The committed `generated/schema.d.ts` passes its own exactness check.** Previously `assertGeneratedTypesAreExact` was exercised only against synthetic strings written inside its test, so a hand-edited or stale schema file passed every gate in the repository.

### Corrected — these claimed more than the mechanism does

- **CHECKSUMS "any change to an existing line fails".** It does not. `verify.ts` checks file-vs-manifest *agreement*, so editing a migration and running `npm run db:checksums` in the same PR passes cleanly. The manifest is a **review aid** whose diff must be read.

  The control that actually catches an edited migration is `assertAppliedUnchanged`, which compares file hashes against `schema_migrations` **in the target database** — a deploy-time gate, wired into `infrastructure/staging/deploy.sh`. It fired during this work, refusing a revised 004 against a test database that had seen the earlier draft.
- **Destructive statements "route the PR to the required reviewer via branch protection".** `verify.ts` flags them at severity `review` and the CLI exits 0. CODEOWNERS exists, but branch protection is unavailable on this repository's plan — see [GAP-001](../COMPLIANCE_GAPS.md). The scan prints a line; nothing enforces the review.
- **"No tenant-owned table is addressable inside a `withGlobal` block."** Accurate for the **query builder**: `GlobalDatabase = Pick<Database, GlobalTableName>` makes `tx.selectFrom('users')` fail to compile, and that is proved with `@ts-expect-error`. A raw `sql` tag inside the block can still name any table — RLS is what stops it there, and the suite tests exactly that. The wording is now "not addressable through the query builder".
- **The `withGlobal` list.** The readiness probe uses `withGlobal` and was not among the five enumerated uses, while the section said "that list is the whole list". It is a legitimate use — no tenant, global tables only — and is now listed. The outbox dispatcher's tenant enumeration is listed too.

### Not built — stated as debt, not as compliance

- **A lint rule for SQL assembled by string concatenation** outside the `sql` tag. Does not exist. `"select … where tenant_id = " + t` in a module lints clean today.
- **A lint rule for the `types` option on `Pool`, `Client` or query config**, and for `pg-types` in any `package.json`. Neither exists. The runtime assertion covers `setTypeParser` and `pg.defaults` but **not** a per-`Pool` `types` map, which does not alter the module-global parser — so that one hole is open at both layers.
- **A codegen drift check in CI.** There is no codegen step in the workflow, so nothing compares the committed schema types against the live schema. `assertGeneratedTypesAreExact` now runs against the committed file, which catches a malformed one but not a stale one.
- **The `numeric` round-trip integration test and the negative type test.** Both need a `numeric` column; migrations 001–004 create none. Deferred to the wave that adds the first monetary column.

### Migrations — enforced

- Filenames strictly sequential, no gaps, no duplicates.
- Forward-only; the runner refuses a file whose recorded hash differs from the applied one.
- The migration ledger is not writable by the application role (migration 003).

## Related

- [ADR-0002](ADR-0002-postgresql-and-redis.md) — PostgreSQL as the system of record
- [ADR-0003](ADR-0003-shared-database-multi-tenancy.md) — the base repository, tenant predicate and global-table allowlist
- [ADR-0004](ADR-0004-postgresql-row-level-security.md) — the RLS backstop `set_config` serves, and pool discipline
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — why journal-writing repositories live in the accounting kernel
- [ADR-0019](ADR-0019-transactional-outbox.md) — the dispatcher's use of `withGlobal` then per-tenant batches
- [ADR-0011](ADR-0011-money-representation.md) — why `numeric` must not pass through a float
- [ADR-0014](ADR-0014-decimal-js.md) — the decimal library on the other side of the driver
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §2 layout and `domain/` purity, §6 tenancy, §7 transactions
- [../IMPLEMENTATION.md](../IMPLEMENTATION.md) — §11 migration discipline, §10 required reviewers
- [../INFRASTRUCTURE.md](../INFRASTRUCTURE.md) — §5 database roles
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 6, 7, 8, 12

## Open — requires a separate ADR

**Read replicas.** [INFRASTRUCTURE.md §9](../INFRASTRUCTURE.md) puts a reporting replica on the growth path and [ARCHITECTURE.md](../ARCHITECTURE.md) sends heavy analytics there, but this ADR states that *every* unit of work goes through `withTenant` against the primary pool. Replica reads are **out of scope here** and need their own record covering the second pool, staleness tolerance for financial reads, and how `withTenant` discipline applies to it. Until that ADR exists, `packages/reporting` uses the primary pool and does not open its own.
