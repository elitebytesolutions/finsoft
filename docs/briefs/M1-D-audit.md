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

## Council review — Database and Security seats, APPROVED WITH CONDITIONS

Both seats reviewed the branch above; decisions 1–4 and 6 were accepted as
written. Fixes applied in response, by item:

**R1 — partitioning text rewritten** in 009's own comment and a new
`TD-006` in TECH_DEBT.md: NOT partitioned in 009; `RANGE (occurred_at)`
withdrawn as the intended key (it would force `occurred_at` into
`UNIQUE (tenant_id, seq)`, and `DETACH` manufactures the exact seq-gap
signal §6 defines as tampering); `HASH (tenant_id)` is the future path and
needs an ADR-0021 §1 amendment (PK becomes `(tenant_id, id)`); retention
needs a further ADR defining sealed chain segments; revisit at ~50M rows /
50GB / any tenant at 10M rows. `ip`'s grant comment now states why that
column specifically: it is one of the twelve hashed columns, so a write
through a defeated trigger is caught by the verifier, unlike a column
excluded from the hash.

**R2 — verifier structural check** now compares against explicit,
named `REQUIRED_TRIGGERS`/`REQUIRED_CONSTRAINTS` lists (a query that only
inspects existing catalog rows cannot see something DROPPED — it reports
zero issues over an empty result). Tested by actually dropping
`audit_log_no_truncate` and `audit_log_not_self` and confirming both are
named in the failure.

**R3 — `openSupportConnection` asserts `current_user = 'readonly_support'`**
immediately after connecting and aborts otherwise (`SupportConnectionRoleError`).
Measured and reproduced: `node-pg`/libpq honour a `?user=`/`?password=`
query-string override of a connection string's own userinfo —
`postgresql://readonly_support:pw@host/db?user=finsoft_app&password=...`
genuinely connects as `finsoft_app`. Tested in
`database/tests/audit-support-connection.spec.ts`.

**R4 — exact ACL via `aclexplode`** in `audit-log.spec.ts`, not
`has_table_privilege`: table-level `{finsoft_app: SELECT/INSERT,
readonly_support: SELECT}`, column-level `{finsoft_app: UPDATE(ip)}`,
nobody else anything (owner excluded with its own justification; `PUBLIC`
grantee explicitly resolved via `coalesce(role, 'PUBLIC')` rather than an
inner join that would silently drop it).

**R5 — `LOCK_REGISTRY.md`** gained a "Row locks on `audit_log`" section
(the only sanctioned one is `audit_log_link`'s own `FOR SHARE`) and a
"test-only advisory lock" entry for `trigger-mutation-lock.ts`, correcting
an earlier, wrong claim that its key was "far outside" the real key space —
it is one point in the same 2^64 space, not outside it; only the space's
size makes collision negligible. `tests/security/lock-registry.spec.ts`
gained a source scan rejecting `FOR (UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)`
near `audit_log` outside migration 009 (comments stripped first, verified
to actually fire on a planted violation), and `audit-log.spec.ts` gained an
`INSERT … ON CONFLICT (…) DO UPDATE SET ip` rejection test (ON CONFLICT DO
UPDATE is still an UPDATE internally — same trigger, same rejection).

**R6 — one exported `AUDIT_LOCK_TIMEOUT_MS = 2000`**
(`packages/database/src/audit/lock-timeout.ts`), used by both `writer.ts`
and `anchor.ts`. The comment now states correctly that `SET LOCAL
lock_timeout` bounds every later lock wait in the transaction, not only the
advisory-lock acquisition — the linkage trigger's `FOR SHARE` and the
self-FK's `KEY SHARE` both happen afterward, inside the `INSERT`, which is
now also wrapped to map `55P03` to `AuditLockTimeoutError`. TD-001 marked
**RESOLVED** with the value and both call sites named.

**R8 — fixed message, and the RED-run record.** The concurrency test's
"still pending" assertion previously attributed an early *rejection* to the
same cause as an early *resolution*, which is not always true (a rejection
could be an unrelated bug). It now fails loudly with the actual rejection
reason if that branch is hit. Requested RED-without-`FOR SHARE` output,
captured directly:

```
AssertionError: promise resolved "{ …(5) }" instead of rejecting
+ {
+   "hash": "ce56b9e982fb7cd1b4be924b7d1a71857a644d5c6135b558d4f7056296b47766",
+   "previousHash": "69df31d161db9b53f81d67ad9adc1a50da2e8a1423006af0f736993ed6332c05",
+   "seq": "3",
+ }
```

T_A's insert of seq 3 SUCCEEDED (it should have rejected), producing exactly
the committed sequence the ADR calls a false gap: **seq 0 (anchor), 1, 3
(pointing at the pre-renumber hash), 99 (T_B's renumbered row)** — 2 is
gone, nothing failed. Restored to green immediately after capture; the
committed function always carries `FOR SHARE`.

**R9 — index added**: `audit_log_actor_idx (tenant_id, actor_user_id, seq)`.
`EXPLAIN (ANALYZE, BUFFERS)` against 1,000,000 synthetic rows for one
tenant (dev database, dropped afterward), as `finsoft_app` under RLS:

| Filter | Plan | Buffers | Execution |
|---|---|---|---|
| base (`seq DESC LIMIT 50`) | Index Scan Backward, `audit_log_tenant_seq_key` | hit=3 read=3 | 0.18 ms |
| `+ action` | same index, filter applied | hit=26 read=2 | 0.22 ms |
| `+ entity_type + entity_id` | Index Scan Backward, `audit_log_entity_idx` | read=3 | 0.13 ms |
| `+ actor_user_id` | Index Scan Backward, `audit_log_actor_idx` | hit=11 read=3 | 0.12 ms |
| `+ occurred_at range` | `audit_log_tenant_seq_key`, filter applied | hit=6 | 0.06 ms |
| cursor (`seq < X`) | `audit_log_tenant_seq_key` | hit=5 read=6 | 0.25 ms |
| verifier batch (`seq > last LIMIT 5000`) | Index Scan, `audit_log_tenant_seq_key` | hit=4 read=232 | 3.8 ms |

Every plan is an index scan; none is a sequential scan. All comfortably
inside the ARCHITECTURE §11 800ms posting-path budget (this is a read path,
with far more headroom).

**R10 — verifier reads in keyset batches** (`seq > $last ORDER BY seq LIMIT
5000`, continuing across batches) rather than one unbounded result set per
tenant.

**`normalizeIp` and zone IDs — reversed to not throw.** A zone-ID-bearing
address (`fe80::1%eth0`) now returns `null` rather than throwing:
`recordAudit` runs inside the caller's own business transaction (a sale, a
login), and a real, legitimately-scoped address arriving from a proxy is
far more likely in production than the malformed inputs the other branches
reject — throwing would abort the business operation over IP formatting.
Fixed narrowly (only a string whose PREFIX before `%` is itself a valid
IPv6 address triggers this; `'%s%s%s%n'`-style garbage still throws).

### Security seat (S1–S7)

- **S1**: `verifyAuditChain` now fails for a tenant id that does not exist
  and for a tenant with a missing or malformed seq=0 anchor, rather than
  reporting a silent `ok: true` with zero rows. Adversarial tests added: a
  cross-tenant splice is detected (caught by the linkage trigger, since the
  attacker's own real seq=1 row does not have the victim's hash); a **tail
  deletion is documented as NOT detected** — demonstrated with a real
  `DELETE` (as the owning role, trigger disabled) rather than simulated,
  because "the chain ends at seq N" is indistinguishable from "seq N+1 was
  deleted" without an independent record of the expected tail. Rule 4's
  grants (no `DELETE` at all, ever) are the real control; this is a stated
  boundary of what "verified" means, not a gap silently left open.
- **S2**: `recordAudit` rejects any key at any depth in `before_json`/
  `after_json` matching `/pass(word)?|secret|token|refresh|otp|totp|
  recovery|api_?key|authori[sz]ation|cookie|session_?id|_hash$/i` with a
  named `AuditSecretKeyError` — tested per pattern, at depth, and inside
  arrays.
- **S3**: the verifier now checks RLS enabled+forced, the `tenant_isolation`
  policy's presence, and table/column privileges via the same
  `aclexplode`-based exact map as R4 (redundant by design with the CI-side
  tests — this is the production-reachable counterpart). `verifyAuditChain`
  no longer stops at the first broken tenant when checking the whole
  cluster: it checks every tenant and returns every break (`breaks: []`,
  `firstBreak` kept for the common case).
- **S4**: a test boots the REAL `AppModule` (not the test harness's
  approximation) and confirms `GET /api/audit` with no credentials at all is
  refused (403 under today's stub `TenantGuard`; will become 401 once M1-A
  lands real authentication — the test accepts either).
- **S5**: cursor bounded to `^\d{1,19}$` AND `<= int8 max` (a 19-digit
  string can still exceed `bigint`'s range); `from`/`to` bounded to
  1970–2100. Caught a real bug while adding this: the `BigInt(cursor)`
  refine ran even when the shape regex had already failed (zod does not
  short-circuit `.refine()` after a failed `.regex()`), so `not-a-number`
  crashed with an uncaught `SyntaxError` — a 500, not the 400 the shape
  check was supposed to guarantee. Fixed and tested for both the malformed
  and the oversized cases.
- **S6**: `createAuditChainAnchor` moved off the package root
  (`@finsoft/database`) to a dedicated `@finsoft/database/provisioning`
  export — a privileged, provisioning-only operation is no longer reachable
  from the same surface as `recordAudit`.
- **S7**: `cli.ts`'s uncaught-error handler now prints only
  `error.message`/`error.code` with any URL-shaped substring redacted,
  never the raw error object (which could carry a connection string via
  `pg`'s own error messages). Extracted to a pure, directly-testable
  `describeCliError` (`cli.ts` itself runs `main()` unconditionally on
  import, matching this repo's other CLI entrypoints, so the redaction
  logic needed its own file to unit-test without invoking the CLI).

Deferred to M1-X per the coordinator's instruction (not done in this lane):
`@RequirePermission('audit.view')`, 401/403 via the real `AppModule` once
auth lands, `actorUserId`/`ip` sourced from request context, rate limiting
`/api/audit`, logging audit reads, OpenAPI 401/403 documentation.
Rebase-time duties, also deferred: bump `REQUIRED_SCHEMA_VERSION` to 9,
append 009's `CHECKSUMS` line last (after 006–008's), regenerate codegen
against the real 001–009 sequence.
