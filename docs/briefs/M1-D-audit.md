# M1-D — Audit log and hash chain

**Lane:** M1-D · **Risk tier:** T2 · **Branch:** `feature/M1-D-audit` · **Migration:** 009

## Task

Implement NON_NEGOTIABLES rule 9's append-only, hash-chained `audit_log`
exactly to ADR-0020's canonicalisation and chain-integrity spec: migration
009, the writer (`recordAudit`), the verifier (`verifyAuditChain`), and
`GET /api/audit`. Per WAVE_1_REGISTER W1-005: **the deliverable is the
verifier, not the table.**

## Why

Every posting, reversal, period close, permission change and credit-limit
override must write an audit record in the same transaction as the change,
and that record must be tamper-evident well enough that an independent party
given only the table and ADR-0020 can recompute every hash. A chain nobody
can recompute is a column called `hash`.

## Scope

- `database/migrations/009_create_audit_log.sql`, `CHECKSUMS`
- `database/tests/**` (schema, RLS, concurrency, verifier, restore, ACL)
- `packages/database/src/audit/**` (canonicalisation, writer, anchor,
  verifier, readonly_support connection, query for the API), re-exported
  from `packages/database/src/index.ts`
- `packages/database/src/testing/harness.ts` — `createTenantFixture` now
  also creates the chain anchor
- `apps/api/src/audit/**` — `GET /api/audit`
- `tests/integration/**`, `tests/security/**`, `tools/**` equivalents

FORBIDDEN: migrations 006–008, `packages/auth`, `packages/permissions`,
`apps/web`, `infrastructure`, other docs, NON_NEGOTIABLES.

## Key decisions, and why

1. **Anchor row co-located with tenant creation.** No production
   tenant-provisioning code exists yet, so `createAuditChainAnchor` is called
   from `createTenantFixture` (the only tenant-creating code in the repo
   today) in the same transaction as the `tenants` insert, exactly as future
   real provisioning must call it.
2. **`FOR SHARE` privilege, not `SECURITY DEFINER`.** PostgreSQL's row-locking
   clauses require UPDATE privilege, which `finsoft_app` deliberately lacks.
   A first draft made the linkage trigger `SECURITY DEFINER` (owned by
   `finsoft_migration`, which holds `BYPASSRLS`) to supply it; Database
   Guardian review found this opens a cross-tenant read inside the trigger
   (RLS does not apply under `BYPASSRLS`) and conflicts with ADR-0023's
   SECURITY DEFINER ownership rules. Replaced with a narrow, column-scoped
   `GRANT UPDATE (ip)` — satisfies PostgreSQL's privilege check, confers no
   real capability (the append-only trigger rejects every UPDATE
   unconditionally), and keeps the trigger `SECURITY INVOKER` so RLS still
   applies to its own read.
3. **`jsonb_path_exists`, not a recursive plpgsql function**, for the
   no-numbers/no-booleans rule. The recursive form failed to survive
   `pg_dump`/`pg_restore` (empty search_path on restore broke its
   self-call) — measured, zero rows restored. The jsonpath form has no
   function and no search_path to get wrong.
4. **`lock_timeout` set to 2000ms** (`SET LOCAL`, transaction-scoped)
   immediately before the terminal advisory lock, in both `recordAudit` and
   `createAuditChainAnchor` — TD-001, forced by this lane per its own text.
   Value flagged for Database/Architecture Guardian confirmation.
5. **8 KiB before/after JSON bound, measured in bytes** (`octet_length`, not
   `length`) — a character-count bound undercounts multi-byte UTF-8 content
   by up to 3x.
6. **readonly_support connection derived from `DATABASE_URL` +
   `POSTGRES_READONLY_PASSWORD`**, not a new `SUPPORT_DATABASE_URL` — adding
   a root `.env`/`.env.example` variable is outside this lane's ALLOWED
   paths. Flagged as a follow-up for whoever owns root config.
7. **The two-connection `FOR SHARE` test uses "ordering B"** (T_B renumbers
   first, uncommitted; T_A inserts second), not the ADR's own prose order —
   the prose order blocks regardless of `FOR SHARE`, because `seq` is itself
   part of a UNIQUE index and PostgreSQL promotes any update to a
   uniquely-indexed column to a lock strength that already conflicts with
   the self-FK's automatic `FOR KEY SHARE`. Verified RED without `FOR SHARE`
   and GREEN with it, on the ordering that actually isolates the trigger's
   contribution. ADR-0020 §5's "the FK does not help" claim needs correction
   at the ADR level — flagged, not fixed here.
8. **Test-only advisory lock** (`database/tests/trigger-mutation-lock.ts`)
   serialises every test that disables an `audit_log` trigger against every
   test that asserts one is enabled — `ALTER TABLE … TRIGGER` is DDL, commits
   immediately, and is visible cluster-wide the instant it does, so
   `fileParallelism: false` alone was measured insufficient.

## Gate

`npm run check:full` (with local placeholders 006–008 present), then
placeholders removed and `npm run check` + `npm run db:migrate:verify`
confirmed. See the final delivery report for exact status and the expected
sequential-numbering gap until 006–008 land for real.
