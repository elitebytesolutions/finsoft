# M1-R · RBAC — roles, permissions, guard

```
ID & TITLE    M1-R · RBAC: roles, role_permissions, user_roles + permission catalogue + guard
OUTCOME       every atomic permission is defined once in packages/permissions and checked
              server-side, from the database, before any Nest route runs its handler
SCOPE         in:  migration 008 (roles / role_permissions / user_roles + RLS + grants +
                   permission_version bump), packages/permissions (catalogue, system role
                   templates, resolvePermissions, seedSystemRoles, UI capability export),
                   @RequirePermission decorator + PermissionGuard in apps/api/src/common,
                   schema/RLS/roles/exact-ACL tests, RBAC integration + security tests
              out: a demo-protected route, packages/auth's real TenantGuard (stub only,
                   owned by m1-auth), packages/shared-types AuthContext (owned by m1-auth),
                   the full ARCHITECTURE §8 permission catalogue (MVP subset only),
                   MFA enforcement for privileged permissions (flagged, not enforced — GAP-003)
PATHS         ALLOWED   database/migrations/008_*.sql, database/migrations/CHECKSUMS,
                        database/tests/**, packages/permissions/**,
                        packages/database/src/generated/schema.d.ts (codegen output only),
                        packages/database/src/rbac/** + its export lines in
                        packages/database/src/index.ts (Architecture seat ruling below —
                        query construction is confined to packages/database by
                        kysely-is-allowlisted; packages/permissions is not on that
                        allowlist), apps/api/src/common/permission*.ts,
                        tests/integration/**, tests/security/** (RBAC cases only),
                        eslint.config.mjs (one new, separate block — Architecture seat
                        merge condition, see Decisions)
              FORBIDDEN database/migrations/006_*.sql, database/migrations/007_*.sql,
                        database/migrations/009_*.sql, packages/auth/**,
                        packages/shared-types/** (other than reading), apps/web/**,
                        infrastructure/**, docs/** other than this brief, NON_NEGOTIABLES.md
BEHAVIOUR     No HTTP route is added. `@RequirePermission('voucher.post')` on a Nest route
              handler + global `PermissionGuard` → 401 when `req.auth` is absent, 403
              `{statusCode:403, error:'forbidden', message:'You do not have permission to do
              this.'}` when the resolved permission set (from the database, never the JWT)
              does not contain every required code, otherwise the handler runs. A route with
              no `@RequirePermission` is unaffected (explicit opt-in, not a global deny).
TIER          T2 → DB stack + schema/security/integration suites + Database/Security Council
                   seat named review
ACCEPTANCE    1. migration 008 creates roles/role_permissions/user_roles, tenant-owned,
                  RLS enabled+forced with tenant_isolation policy, composite FKs on tenant_id,
                  no DELETE grant anywhere, revocation by revoked_at/revoked_by column
               2. schema.spec.ts / rls.spec.ts / roles.spec.ts pass unmodified against the
                  new tables (they are catalog-driven); a new exact-ACL spec asserts the
                  literal column privilege sets for all three tables against finsoft_test
               3. packages/permissions exports exactly the 11 MVP permission codes, marks
                  voucher.reverse / audit.view / admin.user_manage privileged, and ships
                  Owner / Accountant / Viewer system role templates matching the brief
               4. resolvePermissions(tx, userId) returns the union of non-revoked
                  role_permissions for non-revoked user_roles, scoped to the current tenant
               5. seedSystemRoles(tx, tenantId) inserts the three system roles + their
                  role_permissions rows, idempotently rejecting a second call (unique
                  per-tenant role code)
               6. granting or revoking a role, or changing a role's permissions, bumps
                  users.version for every affected user in the same transaction
               7. PermissionGuard: no req.auth → 401; req.auth present but missing permission
                  → 403 with the exact body above; permission present → handler runs; a route
                  without @RequirePermission is unaffected
               8. security tests: a role granted in tenant A is invisible and unassignable in
                  tenant B (RLS + composite FK); Viewer cannot pass a voucher.post check
OWNER         backend-engineer · Database/Security Council seat (database-guardian +
              security-guardian)
```

## Decisions this brief locks in

- **Architecture seat ruling (mid-task, binding): the query bodies for
  `resolvePermissions` and `seedSystemRoles` live in `packages/database/src/rbac/*.ts`,
  not in `packages/permissions`.** `packages/permissions` is not on depcruise's
  `kysely-is-allowlisted` allow-list (that list is `packages/database`, the two kernels,
  `packages/reporting`, and `modules/*/infrastructure`), so it must not build a Kysely
  query. `packages/database` exports `selectEffectivePermissionCodes(tx, userId)` and
  `insertSeededRoles(tx, tenantId, seeds)`; `packages/permissions` holds the catalogue,
  the system role templates (the `seeds`), the `PermissionCode` type, `isPrivileged`, the
  UI capability map, and thin wrappers — `resolvePermissions(tx, userId)` and
  `seedSystemRoles(tx, tenantId)` — that call them. `packages/permissions/README.md`'s
  "May import" line is updated to add `packages/database`, since that dependency is now
  real and approved.
- **Architecture seat ruling (mid-task, final, 2026-09-27), binding:**
  (1) `packages/database` holds no business rules and imports neither `packages/permissions`
  nor `packages/auth` — `insertSeededRoles(tx, tenantId, seeds)` already took the role/permission
  templates as an argument rather than knowing them, so this was already satisfied; confirmed
  rather than changed. (2) merge condition: the ESLint rule blocking query construction on a
  bare transaction handle (`tx.selectFrom(...)` etc.), previously scoped to `apps/**` only,
  is extended to `packages/permissions/src/**` in `eslint.config.mjs`, as its own block reusing
  the existing `appsQuerySyntax`/`connectionOwnershipSyntax`/`stripOnlySyntax` arrays rather
  than editing the shared `packages/*/src/**` block — the auth lane is making the identical,
  separate addition for `packages/auth` at the same time, and two new blocks merge cleanly
  where two edits to one shared block do not. A failing-fixture pair (catches the violation,
  leaves `packages/database` alone) is added to `tests/security/lint-boundaries.spec.ts`.
- **permission_version bump target: `users.version`**, not a new dedicated column and not
  `sessions.permission_version`. `sessions.permission_version` belongs to migration 005
  (m1-auth's file, FORBIDDEN here) and adding a trigger that writes into another lane's table
  from this migration risks a grant/behaviour collision with work landing concurrently on that
  same table. `users.version` already exists (migration 002), is already table-level
  UPDATE-granted to `finsoft_app`, and is the optimistic-lock counter every future user-profile
  write already compares against. Bumping it on a role change is not a misuse of optimistic
  locking — it correctly tells a concurrent profile editor "this row changed, re-read before
  you write" — it is simply conservative about *why* it changed. The auth lane's `perm_ver`
  JWT claim is 0 today and unwired; when it is wired, its guard compares the session's minted
  snapshot against this counter (or against a value derived from it) to force a refresh. This
  keeps the mechanism entirely inside this lane's ALLOWED paths.
- **`permission_code` is a shape-checked free-text column, not a CHECK-enumerated one.** The
  catalogue in `packages/permissions` is the single source of truth (ARCHITECTURE §8); a SQL
  CHECK listing all eleven codes would be a second source of truth that silently drifts the
  next time a code is added there and not here. The column is constrained to
  `^[a-z_]+\.[a-z_]+$` (namespace.action) only — a shape guard against garbage, not a catalogue
  mirror.
- **`roles` gets a `status` column** (`ACTIVE`/`INACTIVE`) even though the brief's column list
  named only `code`, `name`, `is_system`. Rule 4 forbids hard-deleting a role; without a status
  column a tenant could never retire a custom role. This is the table's own lifecycle, decided
  inside this migration, not scope creep into another table.
- **MFA enforcement for `voucher.reverse` / `audit.view` / `admin.user_manage` is flagged, not
  enforced.** ADR-0009 requires MFA before a privileged role becomes effective; there is no
  MFA state to check yet (m1-auth, GAP-003). `isPrivileged(code)` is exported so the guard and
  the future MFA gate can both read it; the guard does not itself block on it.
- **No demo route.** `@RequirePermission` and `PermissionGuard` are exercised by integration
  tests against a minimal fixture controller inside `tests/integration/`, not by a route added
  to a real module. `apps/api/src/app.module.ts` is left unwired (outside ALLOWED) — the first
  lane to add a real `@RequirePermission` route also adds `PermissionGuard` as a second
  `APP_GUARD` there, after `TenantGuard`.
- **Test placement.** `database/tests/rbac.spec.ts` — exact-ACL grants (catalog-driven, no
  fixtures) plus `seedSystemRoles`/`resolvePermissions`/`permission_version` functional
  correctness (mirrors `outbox.spec.ts`'s precedent for fixture-based tests in this
  directory). `tests/security/rbac-tenant-isolation.spec.ts` — adversarial cross-tenant
  RLS/composite-FK cases. `tests/integration/permission-guard.spec.ts` — the guard through a
  real Nest app and real HTTP, with a test-only middleware standing in for the not-yet-built
  auth guard's documented contract (reads test headers, sets `req.auth` and `TenantContext`).
  `packages/permissions/src/*.spec.ts` — catalogue and template unit tests (no DB).
- **Local-only migration gap.** `db:migrate:verify` fails locally with "expected 006_*.sql,
  found 008_create_rbac.sql" once the throwaway placeholders are removed, as anticipated by
  this brief. This is expected to clear once the branch is rebased onto `develop` after the
  m1-auth lane's 006/007 land — not fixed here.
- **OBSERVED, not fixed:** `tests/integration/api-app.spec.ts`'s
  "keeps REQUIRED_SCHEMA_VERSION in step with the migrations on disk" fails locally because
  `apps/api/src/health/health.service.ts`'s `REQUIRED_SCHEMA_VERSION` (5) is now behind the
  highest migration on disk (8). That file is outside this brief's ALLOWED paths; whoever
  lands migration 008 for real (post-rebase) should bump it. Separately,
  `tests/integration/outbox-dispatcher.spec.ts`'s replay-dedup case failed once under the full
  sequential suite and passed in isolation — a pre-existing timing-sensitive flake in a file
  this brief does not touch, not a regression from this work.
