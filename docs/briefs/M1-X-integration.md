# M1-X · Integration and exit — TenantContext, PermissionGuard, audit wiring, demo seed, W1-006

```
ID & TITLE    M1-X · M1 integration and exit: request-wide TenantContext, global
              PermissionGuard, perm_ver/status checks, audit wiring, GET /api/audit,
              demo seed (BHATTI1/BHATTI2), W1-006 exit suite
OUTCOME       a real authenticated request runs with tenant isolation and permission
              checks enforced end-to-end (not per-handler, not by convention), every
              financial-adjacent mutation this wave ships writes its audit row in the
              same transaction, and the W1-006 suite proves — through the real HTTP
              surface, never a test-only stand-in — that authorised access succeeds
              and cross-tenant access fails, in both directions
SCOPE         in:  the request-wide TenantContext interceptor (Council C5), wiring
                   PermissionGuard as a global APP_GUARD + a startup route-decoration
                   check (SEC-C1/C2), perm_ver + account-status checks on every
                   authenticated request (L1), audit wiring for login/logout/failed-
                   login (rule 9, same transaction), GET /api/audit with a rate limit,
                   tools/seed/demo-tenants.mjs for staging tenants BHATTI1/BHATTI2,
                   the W1-006 exit suite (both directions, both at the API and by
                   connecting as the restricted role)
              out: a demo-protected business route (M2+), request-correlation
                   middleware (separate task, must land before the first M2 posting-
                   engine PR), reading an audit row as itself an audited event (M2),
                   cache-invalidation callers for future status/role-write paths
                   beyond login/logout/PATCH-me, an IDOR startup rule for :id routes
                   (none exist on this surface yet), a dedicated
                   users.permission_version column (TD, booked below), running the
                   seed script against staging (a human runs it there, not this agent)
PATHS         ALLOWED   apps/api/src/common/** (tenant.guard.ts,
                        tenant-context.interceptor.ts, permission.guard.ts,
                        permission.decorator.ts, authenticated-only.decorator.ts,
                        route-decoration.check.ts), apps/api/src/app.module.ts,
                        apps/api/src/audit/**, apps/api/src/auth/**,
                        packages/database/src/request-scope.ts (new, narrow
                        subpath export), packages/database/src/transaction.ts,
                        packages/database/src/index.ts,
                        packages/database/src/auth/** (login.ts, refresh.ts,
                        session.ts, index.ts), packages/database/src/provisioning.ts,
                        packages/database/package.json (exports map only),
                        packages/auth/src/** (throttle.ts, audit-sink.ts, login.ts,
                        logout.ts, refresh.ts, guard.ts, account-state-cache.ts,
                        index.ts), tools/seed/demo-tenants.mjs (new),
                        tests/integration/**, tests/security/**,
                        eslint.config.mjs, .dependency-cruiser.cjs (tools/ target +
                        the one named exception it forces), package.json (depcruise
                        target, seed script), docs/TECH_DEBT.md,
                        docs/LOCK_REGISTRY.md, docs/briefs/M1-X-integration.md (this
                        file), docs/BOARD.md — for the demo-cadence decision only (the
                        M1-X exit row, the decision-log row, and the supersession
                        strike through the superseded "Weekly demo day: Monday" row —
                        three edits, not one), with provenance: "Product Owner
                        decision 2026-09-28, relayed in session by the orchestrator"
              FORBIDDEN packages/accounting-kernel/**, packages/inventory-kernel/**,
                        modules/**, database/migrations/** (010–016 are reserved for
                        M2/M3; no new migration in this task — see the permission-
                        version Decision below), packages/permissions/** (catalogue
                        and templates are M1-R's, read-only here),
                        packages/shared-types/**, apps/web/**, infrastructure/**,
                        docs/** other than the four files named above,
                        NON_NEGOTIABLES.md
BEHAVIOUR     TenantContextInterceptor establishes TenantContext from the verified
              req.auth for the whole request (guards run before interceptors, so
              PermissionGuard — which runs as a guard — opens its own narrow scope
              via withTenantAsPrincipal instead, throwing rather than silently
              overriding an ambient one it disagrees with). PermissionGuard is a
              global APP_GUARD: no @RequirePermission → unaffected; missing
              permission → 403; an inactive account or a stale perm_ver claim → the
              same 401 as every other bad-credential case (no enumeration signal).
              RouteDecorationCheck aborts app.init() if any route carries zero, or
              more than one, of @Public()/@RequirePermission(...)/@AuthenticatedOnly(),
              or an @RequirePermission() naming no codes. GET /api/audit requires
              audit.view, is tenant-scoped, and is rate-limited. PATCH /api/auth/me
              takes a required version, 409s (no audit row) on a stale one, 200s
              (with an accurate before/after audit row) on a match.
              tools/seed/demo-tenants.mjs provisions BHATTI1/BHATTI2 with three
              ACTIVE users each, idempotently, refuses to run outside dev/test unless
              FINSOFT_ENVIRONMENT=staging is explicit AND every existing tenant is
              already in the demo set, and never prints a password.
TIER          T2 → DB stack + schema/security/integration suites + Database/Security
                   Council seat named review (auth, tenancy, RBAC enforcement,
                   staging-reachable seed script)
ACCEPTANCE    1. every route in apps/api carries exactly one of
                  @Public()/@RequirePermission(...)/@AuthenticatedOnly(), enforced at
                  boot, not by review
               2. a request with no permission for a @RequirePermission route gets
                  403; one with an inactive account or stale perm_ver gets the
                  identical 401 every other bad-credential case gets
               3. login, logout and failed-login each write their audit row in the
                  same transaction as the state change they describe
               4. GET /api/audit: tenant-scoped, audit.view required, rate-limited,
                  never returns another tenant's rows
               5. tools/seed/demo-tenants.mjs refuses to run in production without
                  FINSOFT_ENVIRONMENT=staging + a clean demo-tenant-only database,
                  and never prints a password to stdout
               6. W1-006: authorised access succeeds (criterion 1) and cross-tenant
                  access fails by every door that exists on this surface — header,
                  body, query (criterion 2) — missing/tampered/expired/revoked
                  credentials are each rejected (criterion 3), the API connects as
                  the restricted database role (criterion 4), concurrent A/B
                  requests stay isolated (criterion 5)
               7. npm run check:full green twice
OWNER         backend-engineer · Database/Security Council seat (database-guardian +
              security-guardian), Architecture Guardian for the boundary conditions
              below
```

## Decisions this brief locks in

- **`withTenantAsPrincipal` lives at `@finsoft/database/request-scope`, not the package
  root.** It is a privileged, narrow-purpose function — a guard-scoped principal opened
  before the request-wide TenantContext exists yet — and has exactly one legitimate
  caller (`PermissionGuard`, which runs before `TenantContextInterceptor` in Nest's
  guards-before-interceptors ordering). Exporting it from the same surface as
  `withTenant`/`withGlobal` invites a second caller to open a second, competing scope
  mid-request. It throws (`TenantContextError`) rather than silently overriding an
  ambient `TenantContext` that names a different principal — this can only be
  constructed today via a test's own contrived middleware, since nothing in the real
  guard chain establishes `TenantContext` before `PermissionGuard` runs, but the
  function does not trust that invariant to hold forever.
- **`TenantContext` import, not call-pattern, is what is restricted.** `apps/**`
  (except `tenant-context.interceptor.ts`, `permission.guard.ts` and the worker's job
  runner), `modules/**`, and every `packages/*` other than `database` and `auth` may
  not import `TenantContext` at all — caught by `no-restricted-imports` on the plain
  name, the aliased name (`import { TenantContext as T }`), and destructuring
  (`const { run } = TenantContext`). A call-pattern rule can be worked around by
  wrapping the call; an import ban cannot.
- **No migration in this task for `permission_version`.** `users.version` doubles as
  the permission-version signal (M1-R's own Decision, reaffirmed here); a dedicated
  `users.permission_version` column would need a forward migration repointing 008's
  cascade functions, and 010–016 are reserved for M2/M3. Booked as
  [TD-008](../TECH_DEBT.md), owner Database seat, due before any role-management UI.
  What this task does instead: `tests/integration/account-state-guard.spec.ts` clears
  the account-state cache explicitly (rather than waiting out its 15s TTL) after
  PATCH /me and after a second login, and asserts the resulting 401-then-recovers
  behaviour directly — so `exit-m1.spec.ts`'s later cases do not depend on that TTL's
  timing, and a slow CI run cannot make them flake either direction.
- **PATCH /api/auth/me is optimistic-locked.** `SELECT ... FOR UPDATE`, a required
  `version` in the request body, a version mismatch is a 409 with **no** audit row
  (nothing changed; there is nothing to describe), a match is a 200 with an audit row
  whose `before_json`/`after_json` reflect the actual old and new `fullName`.
- **The failed-login audit write does not become a tenant-enumeration or per-tenant
  DoS oracle.** An unauthenticated caller can trigger this write for any
  (tenant, email) pair; unbounded, it would let them either exhaust the audit hash
  chain's per-tenant advisory lock queue (ADR-0020 §5) or, by comparing response
  timing/behaviour, infer whether a tenant code exists at all. Fixed by: a blocking
  per-tenant throttle layer (`failedLoginAuditLayer`, 30/5min) ahead of the write —
  once exhausted, the attempt is still rejected as unauthenticated, it simply stops
  generating a new audit row — and a decoy round-trip (`decoyAuditRoundTrip`, two
  reads against the global `tenants` table) on the unknown-tenant branch, so a known-
  tenant and an unknown-tenant failed login do equal work. The row's `actor_user_id`
  is `NULL` (no session, no verified actor) with the target user in `entity_id`.
  Proven by a counting assertion (`failedLoginAuditWorkCountForTests`), not a
  wall-clock timing measurement.
- **The seed script owns no query bodies.** Every query
  `tools/seed/demo-tenants.mjs` needs is a named export in
  `@finsoft/database/provisioning`, taking parameters and returning rows — no
  business rule, no idempotency decision, no password handling. The script decides
  what to do; the package only knows how to do it. `tools/` was added to the
  dependency-cruiser scan for this reason, surfacing one pre-existing, already-
  documented, test-database-only violation in `tools/db/outbox-plan.mjs` (a narrow,
  justified exception was added for that one file — unrelated to this task, caused
  by widening the scan, not newly introduced).

## Council re-review conditions (all applied on this branch before merge)

The Council's first review returned Security APPROVED WITH CONDITIONS, Database
APPROVED WITH CONDITIONS, Architecture REJECTED (fixable; no cross-tenant path was
found). All conditions below are applied; delta re-review only.

- **T1 (Arch R1 / Sec 1 / DB C1)** — `withTenantAsPrincipal` moved off the package
  root to `@finsoft/database/request-scope`; importable only from
  `apps/api/src/common/permission.guard.ts` (lint-enforced,
  `tests/security/lint-boundaries.spec.ts`); throws rather than silently overriding a
  conflicting ambient principal.
- **T2 (Arch R2 / Sec 1)** — the call-pattern rule replaced with an import ban on
  `TenantContext` across `apps/**` (except the interceptor and the worker's job
  runner), `modules/**`, and `packages/*` except `database` and `auth`. Tested against
  a module, a kernel, an aliased import, bracket access (`TenantContext['run']`), and
  destructuring, plus negative controls for every allowed caller.
- **PERMISSION VERSION (DB C2 / Sec 4 / Arch debt)** — no new migration; TD-008 books
  the dedicated column for a future forward migration after M3's numbers, owner
  Database seat. `account-state-guard.spec.ts` clears the cache explicitly around
  PATCH /me and a second login instead of depending on the 15s TTL's timing.
- **PATCH /me (DB C3)** — `SELECT ... FOR UPDATE` + a required version predicate;
  mismatch is 409 with no audit row; match audits the real before/after full name.
  OpenAPI added: operation, body, 200/400/401/409 responses.
- **LOCK_REGISTRY (DB C4)** — two notes added to `docs/LOCK_REGISTRY.md`: a future
  role-grant endpoint's audit write is not covered by migration 008's ascending-id
  lock order documented there, and must audit *before* that cascade, not after;
  `sessions.permission_version` is registered as unused (TD), not fixed by a
  migration here.
- **FAILED-LOGIN AUDIT (Sec 5)** — see the Decision above: blocking per-tenant
  throttle layer + decoy round-trip for equal work on the known/unknown-tenant
  branches; actor `NULL`, target user in `entity_id`; tested by counting, not timing.
- **SEED SCRIPT (Sec 2, Sec 3 absolute stop, Arch R3)**:
  - **S1** — refuses to run unless `NODE_ENV` is `development`/`test`, or
    `FINSOFT_ENVIRONMENT=staging` is explicit AND every existing tenant code is
    already in `{BHATTI1, BHATTI2}` (or none exist). `NODE_ENV=production` alone
    (staging's own compose setting) is never sufficient. Tested for every refusal
    path.
  - **S2** — never prints a password. Outside dev/test, requires `DEMO_*_PASSWORD`
    env vars or generates them and writes them to a 0600 file at
    `--credentials-out` (validated to resolve outside the repository), printing only
    the file path. The script's own header states a human — the Product Owner —
    reads that file; this agent does not, and does not run the script against
    staging.
  - **S3** — every query body moved into `@finsoft/database/provisioning` as named
    exports; `tools/` added to the depcruise scan.
- **SMALL (Arch R4–R7, Sec 6, Sec L2)** — `tenant.guard.ts`'s header comment rewritten
  (it no longer claims each handler opens its own TenantContext — stale since
  `TenantContextInterceptor` was added); `authenticated-only.decorator.ts:8`'s stale
  filename reference fixed; `RouteDecorationCheck` now rejects, at boot, more than one
  marker on a route and an `@RequirePermission()` naming zero codes (previously only
  caught by `PermissionGuard`, at request time); the exit suite gained an expired-
  ACCESS-token case (distinct from the existing expired-refresh-token case, which is a
  database-constraint concern, not the JWT's own `exp`) and a logged-out-access-token
  case proving the session-cache flush is immediate, not merely eventual.
- **R7** — this brief, written and committed, naming the Council conditions above and
  `docs/BOARD.md`'s ALLOWED demo-cadence decision — the M1-X exit row, the decision-log
  row, and the supersession strike — with its provenance.

## Deferred (explicitly not done here)

- **Request-correlation middleware** — a separate task; must merge before the first
  M2 posting-engine PR.
- **Audit-read-as-audit-row** — reading the audit log is not itself audited; M2.
- **Cache-invalidation callers for future status/role-write paths** — only
  login/logout/PATCH-me invalidate the account-state or session caches today; a
  future role-grant or status-change endpoint must add its own call.
- **An IDOR startup rule for `:id` routes** — no resource-by-path-id route exists on
  this surface yet (GET /api/audit takes filters as query parameters; GET/PATCH
  /api/auth/me operate on "self" from the verified token). Belongs with the first
  resource that has one (M2/M3).

## OBSERVED, not fixed here

- `tests/integration/demo-tenants-seed.spec.ts`'s "passwords are generated and
  written to a file" path (S2) is proven by code review and by the mechanism's
  individual pieces (path validation, file-write, no-stdout-printing for the
  pinned-password case), not by one end-to-end run against a genuinely fresh
  database: the shared TEST database already has both demo tenants from this same
  file's own idempotency test, and rule 4 forbids deleting them to manufacture fresh
  state in a fixture. A CI job that seeds a throwaway database from empty would close
  this gap.
- The written credentials file's exact `0600` mode could not be verified on this
  Windows development host — `chmodSync`/`writeFileSync({ mode })` do not produce
  real POSIX permission bits there (measured: reported back as `666`). This is a
  host limitation, not a code one; the deployment target is Linux, and a Linux CI job
  running this script is where that mode should be asserted.
