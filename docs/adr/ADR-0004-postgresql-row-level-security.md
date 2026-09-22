# ADR-0004: PostgreSQL Row Level Security as the isolation backstop

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

[ADR-0003](ADR-0003-shared-database-multi-tenancy.md) puts every tenant's rows in the same tables, discriminated by `tenant_id`. The characteristic failure of that model is a single forgotten predicate: one hand-written query, one raw SQL escape hatch, one repository method that took a shortcut, and tenant A sees tenant B's ledger.

Rule 8 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) does not ask for best-effort filtering. It states that cross-tenant reads and writes are *impossible* at both the API and the database layers, and that a raw `SELECT * FROM journal_entries` run by the application role must return only the current tenant's rows — otherwise Sev-1.

Application-layer filtering cannot deliver that. It is correct exactly as often as every developer and every coding agent remembers it, forever, including in an ad-hoc migration script written under time pressure. The guarantee has to live somewhere that does not depend on anyone remembering.

## Decision

**PostgreSQL Row Level Security is enabled and forced on every tenant-owned table, and the application role is subject to it.** RLS is the fourth and last layer — the backstop beneath the three application layers, not a replacement for them.

```
JWT / session          tenant_id is a signed claim (ADR-0009)
      ↓                never read from body, query string or header
NestJS TenantContext   AsyncLocalStorage, set by a global guard
      ↓
Repository layer       every query filtered; base repo makes it the default
      ↓
PostgreSQL RLS         ← this ADR. The layer that holds when the others fail.
```

Each layer exists for a reason: the JWT establishes *which* tenant, the context propagates it without threading it through every signature, the repository makes correct queries the path of least resistance and keeps the planner honest with `tenant_id`-leading indexes, and RLS makes an incorrect query return nothing instead of something.

### Policy shape

Every tenant-owned table gets the same three statements. There is no per-table creativity here:

```sql
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON journal_entries
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

- `ENABLE` turns policies on for ordinary roles.
- **`FORCE` is not optional.** Without it, the table owner bypasses its own policies — and in most deployments the migration role owns the tables and the app role is or becomes an owner-adjacent role. `FORCE` closes that hole. A table with `ENABLE` but not `FORCE` is treated as unprotected by the schema test below.
- `USING` filters what is visible to `SELECT`, `UPDATE` and `DELETE`.
- `WITH CHECK` filters what may be written. Without it, code could *insert* a row stamped with another tenant's `tenant_id`, which is a cross-tenant write even though no cross-tenant read occurred. Both clauses are always present.

Both clauses use `current_setting('app.tenant_id')::uuid` and nothing else. No policy consults a table, a function with side effects, or a session user name — a policy predicate runs on every row touched and must stay a constant comparison.

### The application role

```sql
CREATE ROLE finsoft_app LOGIN;            -- no BYPASSRLS, no SUPERUSER
CREATE ROLE finsoft_migration LOGIN;      -- BYPASSRLS, used only by migrations
```

- **The application role must not have `BYPASSRLS`, and must not be `SUPERUSER`** (which implies bypass). `BYPASSRLS` is reserved for `finsoft_migration` and is never used by the running application, the worker, or any background job.
- The app role is not the owner of the tenant-owned tables. Combined with `FORCE`, this means there is no path by which normal application code sees another tenant's row.
- Production roles are separated — `app`, `readonly_support`, `migration`, `breakglass` (rule 21). `readonly_support` is also subject to RLS; support access to a specific tenant is granted by setting the tenant, not by bypassing the policy.

### Setting `app.tenant_id`

```
BEGIN
  SELECT set_config('app.tenant_id', $1, true);   -- true = transaction-scoped
  … all work for this request …
COMMIT
```

Binding rules:

1. **Set per transaction, with `set_config(..., true)`** so the value is rolled back with the transaction and cannot leak into the next user of a pooled connection. `SET LOCAL` is equivalent and also acceptable. Session-scoped `SET` is forbidden: with a connection pool it is a cross-tenant bug waiting for a slow day.
2. **The value comes from the authenticated session only** — the `tenant_id` claim in the verified JWT, carried by `TenantContext`. It is never taken from a request body, query string, path parameter, header, cookie or job payload (rule 8, ADR-0009). A request that tries to supply a tenant is not honoured and not negotiated with; the field is rejected by the DTO schema.
3. The connection wrapper in `packages/database` is the only code that calls `set_config('app.tenant_id', …)`. It is set once, at the start of the transaction, before any domain code runs. Calling it anywhere else is a lint failure.
4. A transaction that reaches tenant-owned tables without `app.tenant_id` set does not silently see everything — `current_setting('app.tenant_id')` raises, so the query errors. This is the desired failure mode: loud, not permissive. Where a caller legitimately has no tenant (login, tenant provisioning), it operates only on global tables.
5. Background jobs, outbox dispatch, imports and scheduled work establish the tenant the same way, from the persisted `tenant_id` on the job's own row. There is no "system tenant" and no unset-tenant mode for convenience.

### Deny by default

When RLS is enabled on a table and **no policy applies**, PostgreSQL returns zero rows and rejects writes. This is precisely the behaviour we want if someone adds a table and forgets its policy: the feature breaks visibly in development, rather than quietly exposing data in production. Nothing in the codebase may "fix" that failure by disabling RLS on the table — the fix is to add the policy.

### Schema test

A test in `database/tests/` runs on every PR and asserts, over the live migrated schema:

```sql
-- every table carrying tenant_id must be enabled AND forced, and have a policy
SELECT c.relname,
       c.relrowsecurity   AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public'
  AND  c.relkind = 'r'
  AND  EXISTS (SELECT 1 FROM information_schema.columns col
               WHERE col.table_name = c.relname AND col.column_name = 'tenant_id');
-- assertion: rls_enabled AND rls_forced AND policies >= 1, for every row
```

Plus: the app role has neither `rolbypassrls` nor `rolsuper`; every policy on a tenant-owned table has a non-null `WITH CHECK`; and an adversarial runtime test sets `app.tenant_id` to tenant A and asserts a bare `SELECT * FROM journal_entries` returns only A's rows and an `INSERT` stamped with B's id is rejected.

## Consequences

### Positive

- Tenant isolation is a property of the database engine, so it holds for repository code, raw SQL, a psql session by an engineer, and a coding agent's improvised query alike.
- A forgotten `WHERE tenant_id = …` becomes an empty result during development rather than a data breach in production — the failure is early, loud and cheap.
- Makes ADR-0003's operational economics defensible; without RLS that trade would not be acceptable.
- Gives auditors and prospective tenants a concrete, demonstrable isolation control rather than a description of coding standards.
- New tables are secure-by-omission: forget the policy and the table is inaccessible, not open.

### Negative / accepted costs

- Every query carries a policy predicate. Overhead is small and largely offset because the same `tenant_id` leads the index, but it is not zero.
- Connection pooling requires discipline: transaction-scoped `set_config` and a pool mode that does not multiplex mid-transaction. Getting this wrong is the one way RLS can be defeated by configuration, so it is covered by an explicit test.
- Debugging is less obvious — "the row exists but I can't see it" is a new failure mode engineers must learn to recognise.
- Migrations run as `finsoft_migration` with `BYPASSRLS`, so migration code is the one place cross-tenant writes are mechanically possible. Migrations are reviewed accordingly and are forward-only, numbered and immutable.
- RLS protects rows, not columns or aggregates exposed by a badly scoped endpoint. It is a backstop for tenancy, not a substitute for the permission checks in [ARCHITECTURE.md §8](../ARCHITECTURE.md).

## Alternatives considered

**Application-layer filtering only.** Rejected: fails rule 8's database-layer requirement and depends on perfect recall by every future author, human or agent.

**A database view layer per tenant, or a `security_barrier` view wrapping each table.** Rejected. Equivalent protection to RLS but with far more schema objects to keep in sync, and it still depends on nobody querying the base table.

**Session-scoped `SET app.tenant_id` instead of transaction-scoped.** Rejected. Under a connection pool a leaked session GUC is a cross-tenant read with no error and no log line. `set_config(..., true)` costs nothing and removes the failure mode.

**`BYPASSRLS` on the app role with a "trusted" service layer.** Rejected. That is application-layer filtering with extra steps and a false sense of protection.

**Passing `tenant_id` as a parameter from the request for flexibility (e.g. a support tool).** Rejected. Cross-tenant support access goes through the separate `readonly_support` role and a reason-required, audited break-glass procedure (rule 21), never through user-supplied input on a normal endpoint.

## Compliance

- `database/tests/rls.spec.ts` — the schema assertions above: RLS enabled, forced, at least one policy, non-null `WITH CHECK`, on every table carrying `tenant_id`. Merge blocker.
- `database/tests/roles.spec.ts` — the app role has no `rolbypassrls` and no `rolsuper`; the migration role's bypass is expected and asserted to be the only one.
- `tests/security/tenant-isolation.spec.ts` — adversarial: authenticate as tenant A, attempt reads and mutations against tenant B's IDs through every public endpoint; assert no data returned and no row written. Also asserts the bare-SQL case.
- Pool test: a transaction sets `app.tenant_id`, commits, and the next borrower of the same connection is asserted to have no `app.tenant_id` set.
- Lint rule: `set_config('app.tenant_id'` / `SET LOCAL app.tenant_id` may appear only in `packages/database`. Anywhere else fails the build.
- Lint/schema rule: `tenant_id` may not appear in any request DTO or queue job payload as an input field (rule 8).
- CI: any migration that creates a table with a `tenant_id` column and does not also `ENABLE` + `FORCE` RLS and create a policy fails the schema test in the same PR.

## Related

- [ADR-0003](ADR-0003-shared-database-multi-tenancy.md) — the tenancy model this makes acceptable
- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — where the signed `tenant_id` claim originates
- [ADR-0002](ADR-0002-postgresql-and-redis.md) — RLS as a deciding reason for PostgreSQL
- [ADR-0010](ADR-0010-transactional-outbox.md) — how background dispatch establishes tenant context
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 7, 8, 18, 21
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §6 multi-tenancy, §8 permissions
