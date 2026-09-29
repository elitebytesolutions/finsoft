# ADR-0028: Module packaging and runtime

**Status:** Accepted
**Date:** 2026-09-29
**Deciders:** Architecture seat (author), Database/Security seat ([ADR-0024](ADR-0024-operating-model.md))
**Authority:** LEVEL 1 — reversing this requires a superseding ADR. **Amends** [ARCHITECTURE](../ARCHITECTURE.md) §2 (:91, :122–123, :126). **Supersedes in part** [ADR-0001](ADR-0001-modular-monolith.md) :38–39, the `ui` in the module layer list, and nothing else in it.

## Context

M3 puts the first code in `modules/` ([M3 README](../design/M3/README.md) §6, [modules.md](../design/M3/modules.md) §1). ARCHITECTURE §2 was written for an empty directory, and two of its lines cannot be built:

- **`api/` holds "Controllers, DTOs, guards, OpenAPI decorators" (:122).** Every workspace package ships TypeScript source and runs under Node's type stripping (`tsconfig.packages.json`). NestJS needs legacy decorators with emitted metadata, and stripping cannot run them. That is why `apps/api` alone builds with SWC (`apps/api/tsconfig.json` header). A controller inside a module works only if the module becomes a second SWC root of `apps/api`. The worker has no build step, so it could then import no module at all.
- **`ui/` holds "Route segments and components (re-exported to apps/web)" (:123).** `web-is-ui-only` in `.dependency-cruiser.cjs` forbids `apps/web → modules/**`, so such a layer could never be imported. Nobody noticed because the directory was empty.

The rest of the module machinery has also never been exercised. `.dependency-cruiser.cjs` has had no module to check. `no-cross-module-internals` forbids only `domain/` and `infrastructure/`. `modules/**` gets neither the strip-only selectors nor a query-construction ban. `modules/` is not a workspace. `Dockerfile.api` does not copy it, and `risk-tiers.json` does not rebuild the API image when a module changes.

Two alternatives were rejected. **Controllers in the module, built by SWC**: this makes modules unimportable from the worker and from type-stripped tests. **A `ui/` layer re-exported through a package**: this would reopen the `apps/web → modules` edge that rule 19 exists to close.

## Decision

1. **A module is a workspace package** at `modules/<name>/`, named `@finsoft/<name>`, with `"type": "module"`. It ships TypeScript source and runs under Node type stripping, exactly like `packages/*`. Its `tsconfig.json` extends `tsconfig.packages.json` (`erasableSyntaxOnly`). There are no decorators, enums, namespaces or parameter properties anywhere in `modules/**`, and no `@nestjs/*`, `express` or `fastify` import.
2. **The layers sit at the package root**, with no `src/`: `domain/`, `application/`, `infrastructure/`, `api/` and `index.ts`. **There is no `ui/` layer.** Screens live in `apps/web/src/screens`, and the response types they consume live in `packages/shared-types`.
3. **Exports: exactly two.**
   - `"."` → `./index.ts` is for `apps/api`, `apps/worker` and `tests/**`. It exports use-case factories that build their own repositories internally, plus the `api/` contract. It exports no repository, no query and nothing else from `infrastructure/`.
   - `"./published"` → `./application/published.ts` is for other modules, and for nothing else. It holds plain DTO types, typed error classes and interfaces.
4. **Controllers live in `apps/api/src/<module>/`**, as thin NestJS adapters. A handler does four things: validate the input with the module's zod schema, call **one** use case, map the result with the module's mapper, and declare `@RequirePermission`. It opens no transaction, imports no domain type and constructs no query. **The module's `api/` layer** is framework-free: zod request schemas, response mappers into `packages/shared-types` types, and the error-code → HTTP-status table. Authorisation is enforced at the adapter by the global `PermissionGuard`. A future non-HTTP caller, such as the worker, must enforce its own.
5. **Layer rules.** Dependencies point inward:
   - `api → application → domain`;
   - `infrastructure → domain`, plus `infrastructure → application/ports.ts` as a **type-only** import, which is the one path by which infrastructure implements a port;
   - `index.ts` → any of its own layers, since it is the composition root.
   - `application` never imports `infrastructure` or `api`. `domain` imports only its own files, `@finsoft/validation` and `@finsoft/shared-types`, plus **type-only** imports from the `@finsoft/accounting-kernel` index. The type-only exception exists so that the domain can build a kernel payload, such as `toSalePostedPayload()`.
   - Across modules, the only reachable file is `modules/<other>/application/published.ts`.
   - A module may import the kernels' **public index**, `@finsoft/database` (the root only, and not in `domain/`), `@finsoft/validation`, `@finsoft/shared-types`, `@finsoft/reporting` (read-only ledger queries) and `@finsoft/observability` (not in `domain/`). It never imports `@finsoft/auth`, `@finsoft/permissions`, `@finsoft/ui` or `apps/**`.
6. **Transactions.** A state-changing use case is **one** `withTenant(tx => …)` unit of work, opened in `application/`. The tenant and the actor come from the `TenantContext` that `apps/api`'s global interceptor established, and never from an argument. Ports, repositories, published interfaces and kernel calls **receive** that `TenantTx` and never open one. `withGlobal` is not used in `modules/**`. This fixes *where in the code* ADR-0001:35's "transaction boundary" is opened: in the application layer, which runs inside `apps/api`'s process.
7. **Kernel calls use the kernel's public index only.** Posting goes through `postingEngine.post(command, tx)`, and reversal of a document through the kernel's source-reversal export (K2). A party is registered with `registerParty(tx, 'CUSTOMER')` before the module's own row is inserted, in the same `tx`, and the returned id **is** the row's primary key ([ADR-0026](ADR-0026-journal-line-party-dimension.md) statement 4). A module gets a document or master-code number (`INV`, `RCT`, `CUST`) only from a kernel index export (K3, K7). It never calls `assignDocumentNumber` or `assignTenantDocumentNumber`. Journal and party ledgers are read through `@finsoft/reporting` or a kernel export (K5), never by a module query.
8. **Query bodies live in `modules/<name>/infrastructure/`**, and nowhere else in the module. This is a **stated exception to the [ADR-0023](ADR-0023-pre-tenant-authentication-reads.md) A1 precedent**, not a departure from it. A1 put auth and RBAC bodies in `packages/database` because `packages/auth` and `packages/permissions` are off the ADR-0013 allowlist and their tables are platform tables. Module infrastructure **is** on the allowlist (`kysely-is-allowlisted`), and its tables are the module's own. Moving them to `packages/database` would recreate what ADR-0023 A4 rejected, a domain-shaped `packages/database`. Repositories extend `BaseRepository` and name **only their own module's tables**, in writes, reads and joins alike.
9. **Migrations** stay in the single chain `database/migrations/NNN_*.sql`, under one `CHECKSUMS`. Numbers are assigned by the plan and never by a lane: **014** `customers` (M3-C), **015** and **016** (M3-P), reserved per [M3 README](../design/M3/README.md) §2. A module migration names its owner in a header (`-- Owner: modules/<name>`). It creates only that module's tables, and their RLS, triggers, indexes and grants. It may declare foreign keys **from** its tables to kernel tables (`parties`) or to another module's tables (a reference, not a write). It never alters, triggers on or grants on a table it does not own. The Database/Security seat owns the SQL, and review is T2.
10. **Tests.**
    - **Beside the code** (`modules/<name>/**/*.test.ts`, run by the module's `vitest run`): domain and `api/`-contract unit tests, with no database.
    - **`tests/integration/<name>/`**: application and infrastructure against real PostgreSQL, and the HTTP routes through `apps/api`.
    - **`tests/security/`**: adversarial tenant isolation and RBAC.
    - **`tests/accounting/`**: golden scenarios and Invariant 9, driven **through the module's `index.ts`**, not the kernel.
    - **`tests/e2e/`**: the demo journey.

## Consequences

**Positive.** Every module can be loaded by the API, the worker and every test runner, with no build. The layer arrows and the cross-module surface become build failures, not conventions. The customers → receivables interface is small and proves the published-interface pattern before Wave 7 needs it at scale.

**Accepted costs.**
- There is one thin controller file per resource in `apps/api`, away from its module.
- Response types are declared in `packages/shared-types` and mapped by the module. That is a second declaration of each shape, which the OpenAPI snapshot test keeps honest.
- Authorisation lives at the HTTP adapter, so a later worker entry point must add its own check.
- ESLint gains one table-ownership block per module.
- Module code gives up enums and parameter properties, as `packages/*` already has.

## Compliance

**Merge conditions on M3-C's first PR.** Each item is a named mechanism. Each new rule gets a probe proving it fires.

| # | Mechanism | Makes true |
|---|---|---|
| C1 | Root `workspaces` gains `"modules/*"`. `modules/.scaffold/` is deleted. `modules/customers/package.json` has exactly the two exports of statement 3. `Dockerfile.api`'s runtime stage copies `modules/`. `risk-tiers.json`: `images.api` gains `modules/**`, `packages/accounting-kernel/**` and `packages/reporting/**`; **T3** gains `modules/*/infrastructure/**` and `modules/*/index.ts`; T1 loses `modules/*/ui/**` | 1, 2, 3 |
| C2 | depcruise **`cross-module-via-published-only`**: `^modules/([^/]+)/` → `^modules/(?!$1/)[^/]+/` is forbidden unless the target is `application/published\.ts$` | 5 |
| C3 | depcruise **`infrastructure-reaches-application-only-via-ports`** (a target under `application/` other than `ports.ts` is forbidden) and **`ports-import-is-type-only`** (`ports.ts` with `dependencyTypesNot: ['type-only']` is forbidden) | 5 |
| C4 | depcruise **`application-does-not-import-infrastructure`**, **`module-api-does-not-import-infrastructure`** and **`domain-imports-allowlisted`** (statement 5's list; the kernel index is allowed only with `dependencyTypes: ['type-only']`) | 5 |
| C5 | depcruise **`apps-import-module-index-only`** (`^apps/` → `^modules/` is forbidden unless the target is `^modules/[^/]+/index\.ts$`) and **`modules-import-allowlisted`** (`packages/(auth\|permissions\|ui)/`, `apps/` and `packages/database/src/auth/` are forbidden) | 3, 5 |
| C6 | ESLint: a `modules/**/*.ts` `no-restricted-syntax` block composing `invariantSyntax`, `connectionOwnershipSyntax`, `authLookupIdentifierSyntax`, `financialTruthWriteSyntax` **and `stripOnlySyntax`**, plus `Decorator`. `no-restricted-imports` for `@nestjs/*`, `express`, `fastify` and `withGlobal` across `modules/**`, and for `withTenant` outside `modules/*/application/**`. `withTenant`/`withGlobal` are banned in `apps/api/src/customers/**` | 1, 4, 6 |
| C7 | ESLint: the `appsQuerySyntax` selectors, plus `sql` tagged templates, applied to `modules/*/{api,application,domain}/**` and `modules/*/index.ts` ([M3 README](../design/M3/README.md) §5 item 3) | 8 |
| C8 | ESLint **table ownership** for `modules/customers/infrastructure/**`: a builder call (`selectFrom`, `insertInto`, `updateTable`, `deleteFrom`, `mergeInto`, `*Join`) whose table argument is not `customers`, or a `sql` tag naming another table, is an error. M3-P adds the receivables block | 8 |
| C9 | `tests/security/depcruise-negative-control.spec.ts` gets probes for C2–C5 and for the existing `no-cross-module-internals`, `domain-is-pure`, `domain-has-no-infrastructure-deps`, `application-does-not-import-api` and `modules-do-not-reach-into-kernels`. `tests/security/lint-boundaries.spec.ts` gets cases for C6–C8 | all |
| C10 | `database/tests/migration-ownership.spec.ts`: every migration from 014 on carries `-- Owner:`, and every `ALTER TABLE`, `CREATE TRIGGER … ON`, `CREATE POLICY … ON`, `CREATE INDEX … ON` and `GRANT … ON` targets a table that a migration with the same owner created | 9 |
| C11 | `tests/integration/module-surface.spec.ts` snapshots the runtime export names of each module's `index.ts` and `published.ts`. A change to it is an Architecture seat review | 3 |
| C12 | The kernel index exports the tenant-scope numbering facility for `CUST` (K7) and the party-filtered ledger read (K5, `@finsoft/reporting`). Both are reviewed as T3 kernel changes. The existing `kernelOnlyCallSyntax` stays the thing that stops a module calling `assignTenantDocumentNumber` | 7 |

**Database/Security conditions**, also binding M3-C's first PR:

| # | Mechanism | Makes true |
|---|---|---|
| S1 | **Flat config replaces `no-restricted-imports` per file.** Every new `modules/**` block from C6 (the `@nestjs/*`/`withGlobal` block, the `withTenant`-outside-`application/` block, and any per-layer block) spreads `REQUEST_SCOPE_IMPORT_BAN`, `TENANT_CONTEXT_IMPORT_BAN`, `TESTING_IMPORT_BAN` and `PROVISIONING_IMPORT_BAN`, and bans `pg` and `@finsoft/database/auth`. `lint-boundaries.spec.ts` proves, **per layer** (`infrastructure/`, `application/`, `api/`, `index.ts`), that `TenantContext`, `/testing`, `/provisioning` and `/request-scope` still fire, and that the `withGlobal` and `TenantContext` entries on the same `@finsoft/database` specifier both fire | 6, M1-X |
| S2 | **C8 fails closed.** A builder table argument that is not a string literal is an error. The literal matches as an exact identifier after the alias is stripped (`'customers as c'` passes; `'customers_x'` and `'parties'` do not). Nested builders (`eb.selectFrom`, `with(...)`) are covered. `sql.table`, `sql.ref`, `db.dynamic`, `CompiledQuery` and `executeQuery` are banned in `modules/**`. Probes cover each | 8 |
| S3 | **Tenant-scoped foreign keys.** PostgreSQL checks foreign keys with row security off. A single-column `REFERENCES parties(id)` therefore lets tenant B insert a row that points at tenant A's party, and it tells B whether that id exists. Every foreign key from a tenant table to a tenant table is composite, `(tenant_id, x) REFERENCES t (tenant_id, id)`. `schema.spec.ts` asserts this from the catalog for every foreign key | 9 |
| S4 | **C10 also rejects the following outright in module migrations:** `ALTER POLICY`, `DROP`, `CREATE RULE`, `REVOKE`, `ALTER … OWNER`, `CREATE FUNCTION … SECURITY DEFINER`, `CREATE VIEW` without `security_invoker = true`, `ALTER DEFAULT PRIVILEGES`, `ALTER ROLE`, `SET ROLE`, and `DISABLE`/`NO FORCE ROW LEVEL SECURITY`. Quoted and schema-qualified names are normalised before matching. `Owner:` must name an existing `modules/<name>` directory. Each construct has a failing fixture. `rls.spec.ts` stays catalog-driven and asserts that `customers` is present | 9 |
| S5 | Repositories call `assertIssuedTenantTx` on the handle they receive. `tests/integration/customers/` proves that a use case invoked outside a `TenantContext` fails closed. `tests/security/` proves that another tenant's customer id gets the same 404 as an absent one, on every customer route | 6 |

**On acceptance**, before M3-C merges, the Architecture seat:
- amends ARCHITECTURE §2 :91, :122–123 and :126 to statements 2, 4 and 5;
- places a permanent supersession scope notice at the head of ADR-0001 for :38–39.

## Signatures

| Seat | Verdict |
|---|---|
| **Architecture seat** | ✅ **APPROVED, 2026-09-29.** Author. Checked against ADR-0001, 0005, 0013, 0023 (A1, A4), 0026 and 0027, ARCHITECTURE §2 and §5, `.dependency-cruiser.cjs`, `eslint.config.mjs`, `risk-tiers.json`, `Dockerfile.api` and `apps/api/src/app.module.ts` on `develop` 6f728c8. C1–C12 bind M3-C's first PR. The M3-P lane repeats C6's adapter ban for `apps/api/src/receivables/**` and adds C8's receivables block. |
| **Database/Security seat** | ✅ **APPROVED WITH CONDITIONS S1–S5, 2026-09-29.** Reviewed statements 6, 8 and 9, and C8 and C10, against `eslint.config.mjs`, `.dependency-cruiser.cjs` (`kysely-is-allowlisted`), `packages/database` exports, `rls.spec.ts` and `schema.spec.ts` on 69f065c. The statements hold: RLS stays forced, `TenantTx` is the only path in, and there is no `withGlobal` and no pool. As drafted, the mechanisms would have reopened the M1-X import bans (S1) and allowed a cross-tenant foreign-key write (S3). S1–S5 close both. |

---

**Amendment, 2026-09-29** (Council review of M2-B; Architecture + Database/Security seats).
The signed body is not edited; this note overrides it where the two differ.

1. **Statement 9's numbers.** Statement 9 names migrations 014, 015 and 016 for M3. Migration
   **014** was taken by the M2-B permission backfill
   (`database/migrations/014_add_account_and_period_permissions.sql`), a platform migration that
   is not part of any module. M3's three migrations therefore move up by one: **015**
   `customers` (M3-C), **016** and **017** (M3-P). The numbers are corrected in
   [docs/design/M3/README.md](../design/M3/README.md) §2,
   [docs/design/M3/open-questions.md](../design/M3/open-questions.md) and
   [docs/IMPLEMENTATION.md](../IMPLEMENTATION.md).
2. **C10 and S4 owners.** C10 applies to every migration from 014 on, as signed. S4's owner rule
   is widened: `-- Owner:` must name an existing `modules/<name>` **or** `packages/<name>`
   directory. A `packages/<name>` owner marks a platform or kernel migration. All of S4's
   content bans still apply to it unchanged. Migration 014 is owned by `packages/permissions`.
   The M3-C checker implements this rule, with a passing fixture for a `packages/<name>` owner
   and a failing fixture for a directory that does not exist.

Database/Security seat — 2026-09-29 — accepts point 2 (S4 owner widening).

Architecture seat — 2026-09-29 — countersigns the amendment (points 1 and 2).

---

**Note, 2026-09-29** (Architecture seat, M2-C). C10's checker
(`database/tests/migration-ownership.spec.ts`) only scans migrations from 014 on for
`tablesCreatedBy` when building each owner's allowed-table set (per statement 2 of the amendment
above). Migration 018 (`packages/accounting-kernel`) needs to `ALTER TABLE`, `CREATE TRIGGER … ON`,
`CREATE INDEX … ON` and `GRANT … ON` the `accounts` table, which migration 010 — before 014 — created.
Without an explicit pre-014 owner record, the checker would see `accounts` as belonging to no owner at
all and reject 018's own, legitimate constructs. The checker is amended with an EXPLICIT, hard-coded
map from a pre-014 table to its owner, used only to seed each owner's allowed-table set (never to admit
a NEW pre-014 migration to the checker's scan, which stays 014 on):

| Migration | Tables | Owner |
|---|---|---|
| 010 | `accounts` | `packages/accounting-kernel` |
| 011 | `fiscal_periods` | `packages/accounting-kernel` |
| 012 | `parties`, `journal_entries`, `journal_lines` | `packages/accounting-kernel` |
| 013 | `document_sequences` | `packages/accounting-kernel` |

This map is deliberately narrow — only the tables M2-C's own migration 018 needs to reference. It
does not assign an owner to any table from migrations 001–009; a future lane extending the map to those
tables makes that assignment explicitly, in its own reviewed change, not by silent precedent from this
one.

**Note, 2026-09-29** (Security seat, M2-C). The three named exceptions to S4 for `packages/<name>`
owners, verbatim from this lane's delivery brief:

> **S4 for `packages/<name>` owners, 2026-09-29.** All S4 bans apply, with exactly three exceptions,
> each needing a failing fixture: (a) `REVOKE INSERT|UPDATE ON <table> FROM finsoft_app`, only on a
> table this owner owns, and only if the same migration then re-grants a column list to
> `finsoft_app`; (b) `CREATE FUNCTION … SECURITY DEFINER`, only with
> `SET search_path = pg_catalog, public`, and then `REVOKE EXECUTE … FROM PUBLIC` and an explicit
> `GRANT EXECUTE`; (c) `ALTER FUNCTION <that function> OWNER TO <role>`, only if `schema.spec.ts`
> asserts that role is `NOLOGIN`, `NOBYPASSRLS` and owns nothing else. Every `packages/<name>`
> migration also needs a named T2 Database/Security review.

Implemented in `database/tests/migration-ownership.spec.ts` (`isAllowedSecurityDefiner`,
`isAllowedFunctionOwnerChange`, both gated on a `packages/<name>` owner only — a `modules/<name>`
owner keeps the unconditional ban), each with a failing fixture and a passing fixture for the allowed
shape. Exception (a) needed no new code: `REVOKE INSERT, UPDATE ON <table> FROM finsoft_app` was
already the one allowed `REVOKE` shape (`REVOKE_SHAPE`), gated only on the table being one the
migration's owner created — which is exactly what the pre-014 owner map above now lets migration 018
satisfy for `accounts`. Migration 018 itself uses none of the three exceptions — it needed no
`SECURITY DEFINER` function, having been unable to complete the one that coa-standard.md §8.7 R2 asks
for (a dedicated `NOLOGIN`/`NOBYPASSRLS` role could not be provisioned from within this lane's `ALLOWED`
paths — see this lane's report). The three exceptions are implemented and fixture-tested regardless,
ready for whichever migration lands R2's seeding function.
