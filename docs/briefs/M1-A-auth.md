# M1-A · Authentication

```
ID & TITLE    M1-A · packages/auth, migrations 006/007, apps/api auth module
OUTCOME       a user in a tenant can log in with a tenant code + email + password,
              get a short-lived access token and a rotating refresh cookie, refresh
              and log out, and every other authenticated endpoint can trust
              req.auth.tenantId/userId as a server-asserted fact
SCOPE         in:  migration 006 (refresh-path pre-tenant resolver, ADR-0023 §2),
                   migration 007 (users column-scoped regrant + transition trigger,
                   TD-005), packages/auth (argon2id, JWT RS256 + JWKS, refresh
                   rotation, Redis throttle), packages/shared-types AuthContext,
                   apps/api auth module + real TenantGuard, seam for audit (no-op
                   AuthAuditSink), a tenant+user test-seed helper
              out: packages/permissions (RBAC lane), migrations 008/009, MFA
                   endpoints (ADR-0023 leaves /auth/mfa gated on an Architecture
                   decision not yet made), lockout table (RBAC lane owns it per
                   ADR-0023 §5), apps/web, infrastructure/** (bootstrap script —
                   see BLOCKED)
PATHS         ALLOWED   database/migrations/006_*.sql, 007_*.sql, CHECKSUMS
                        database/tests/**
                        packages/auth/**
                        packages/shared-types/** (AuthContext export only)
                        packages/database/** (generated types; withResolvedTenant,
                          ResolvedTenantId only)
                        apps/api/src/** (auth module, guard, app.module wiring)
                        tests/integration/**, tests/security/** (auth cases)
                        .env.example (new env var names)
              FORBIDDEN packages/permissions, migration 008/009, apps/web,
                        infrastructure/**, docs other than this brief,
                        docs/NON_NEGOTIABLES.md
BEHAVIOUR     POST /api/auth/login    {tenantCode,email,password} -> 200 body+cookie | 401 | 429
              POST /api/auth/refresh  cookie + X-Requested-With: finsoft -> 200 | 401 | 403 | 429
              POST /api/auth/logout   same header -> 204
              GET  /api/auth/me       bearer -> {user,tenant,sessionId,permissionVersion}
              GET  /api/auth/jwks     public -> JWKS
              TenantGuard: verifies RS256 bearer, checks session ACTIVE
                (Redis -> Postgres), sets TenantContext from the verified claim only
TIER          T2 -> DB stack + schema/security/integration suites + Database/Security
                    Council seat review (named in the report)
ACCEPTANCE    - login succeeds for a seeded ACTIVE user and fails identically for
                unknown tenant / unknown email / wrong password / non-ACTIVE user
              - exactly one argon2id verification per login request (counted)
              - refresh rotates the token, spent-token replay revokes the family
                (no grace window, ADR-0022), and re-proves the cross-tenant IDOR
                property through the migration-006 resolver
              - migration 006's positive/negative gate (ADR-0023 Compliance)
                discriminates the SECURITY DEFINER resolver from a BYPASSRLS twin
              - migration 007 narrows finsoft_app's grant on tenants (excl.
                code/status) and on users (TD-005), with a transition trigger
              - a request carrying tenantId in body/query/header never changes the
                issued claim (4 injection points tested)
              - algorithm-confusion (alg:none, wrong key) tokens are rejected
              - login/refresh fail closed (503) when Redis is unreachable
              - tenant B cannot use tenant A's access token or refresh token
OWNER         backend-engineer · Database/Security Council seat (database-guardian +
              security-guardian)
```

## Notes carried from the task message

- Builds to ADR-0023's *current* text (Proposed; Security Guardian and Database
  Guardian have signed; Architecture Guardian and Product Owner have not recorded
  a signature in the copy read for this task, though the PO's two decisions —
  tenant-code field, throttle/lockout split — are recorded and binding per
  `docs/WAVE_1_REGISTER.md`).
- Migrations merge in order 006 -> 007 -> 008 -> 009; this PR must merge before
  RBAC's (008).
- `/auth/login` must not ship emitting `Set-Cookie` before the cookie-prefix
  question is settled (ADR-0023 "Open" item). Decision recorded under DECISIONS
  below rather than left implicit.
