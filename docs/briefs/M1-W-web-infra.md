ID & TITLE    M1-W · Web + infra — login, API client, real session, staging HTTPS
OUTCOME       a person can open the staging site over HTTPS, log in against the real
              auth API, see their own name/tenant in the shell, sign out, and have
              their session silently restored on reload — while every screen still
              backed by mock data says so, out loud, on every page.
SCOPE         in:  login page + its page doc; browser API client (in-memory access
                   token, single-flight refresh, 401/403 handling); session context
                   replacing the role-mock in the shell; a persistent prototype
                   banner; staging Caddy/compose/CI/provision changes for HTTPS on
                   31-220-74-159.sslip.io
              out: any new mock-only business screen; building packages/ui
                   components myself (request from design-system agent instead);
                   touching packages/auth, packages/permissions, or any migration;
                   ssh-ing to the staging host or applying the ufw rule there
PATHS         ALLOWED   apps/web/app/login/**, apps/web/app/layout.tsx,
                        apps/web/next.config.mjs (dev-only /api rewrite),
                        apps/web/src/screens/login.tsx (new file only — no
                          existing ported screen in this folder is touched),
                        apps/web/src/lib/api/**, apps/web/src/app-context.tsx,
                        apps/web/src/components/guard.tsx,
                        apps/web/src/components/shell.tsx,
                        apps/web/src/components/app-frame.tsx,
                        apps/web/src/test/**, apps/web/vitest.config.ts,
                        docs/design-system/pages/login/**,
                        docs/briefs/M1-W-web-infra.md,
                        infrastructure/staging/Caddyfile,
                        infrastructure/staging/compose.yaml,
                        infrastructure/staging/provision.sh,
                        infrastructure/staging/smoke.sh,
                        infrastructure/staging/deploy.sh (only if a staging-URL
                          change genuinely requires it),
                        .github/workflows/ci.yml (deploy-staging job only),
                        docs/workflows/ci-tiers.md (STAGING_URL doc note only),
                        tests/e2e/login.spec.ts (new),
                        tests/e2e/playwright.config.ts (added a second
                          project + webServer entry so login.spec.ts can
                          drive the rendered Next.js app on its own origin —
                          the existing API-only project/webServer is
                          untouched and still runs unmodified),
                        tests/e2e/playwright.deployed.config.ts (only if
                          E2E_BASE_URL default needs the STAGING_URL var name)
              READ ONLY apps/web/src/mocks/**, apps/web/src/screens/**,
                        apps/web/src/lib/router.tsx, packages/ui/**,
                        packages/validation/**, packages/shared-types/**,
                        packages/auth/**, docs/**, tests/e2e/web-origin.deployed.spec.ts
              FORBIDDEN packages/accounting-kernel/**, packages/inventory-kernel/**,
                        packages/auth/** (write), packages/permissions/**,
                        database/migrations/**, modules/**, any file under
                        packages/ui/** (write — request the design-system agent)
BEHAVIOUR     POST /api/auth/login, /api/auth/refresh, /api/auth/logout,
              GET /api/auth/me — per the fixed contract in the task message
              (mocked with `page.route` / MSW-less fetch stubs until the auth
              lane's real endpoints land). UI states: idle, submitting,
              invalid credentials (generic), rate-limited (Retry-After shown),
              network error, session-expired banner. 401 after one refresh
              attempt -> /login?next=…; 403 -> /unauthorized.
TIER          T2 — infra (Caddy/compose/provision/CI) + auth-adjacent session
              handling are in the changed paths, so the higher tier applies
              even though most of the work is ordinary UI. Gate: npm run check
              AND npm run check:full.
ACCEPTANCE    1. docs/design-system/pages/login/README.md exists, reviewed
                 shape (archetype, fields, every state's copy), before the
                 page code.
              2. /login renders from packages/ui + tokens only; no raw hex/px
                 shadow in apps/web; no one-off form controls if the kit
                 already has (or gains) Field/TextInput.
              3. The API client keeps the access token in a module/context
                 variable only — grep for `localStorage`/`sessionStorage`
                 touching a token finds nothing.
              4. Only one refresh request is ever in flight per tab under
                 concurrent 401s (unit-tested with a shared-promise assertion).
              5. A 401 after a failed refresh redirects to /login?next=<path>;
                 a 403 redirects to /unauthorized; both unit- and
                 e2e-tested.
              6. Every route except /login and /unauthorized requires a
                 session client-side; the shell header shows the real user
                 and tenant from /auth/me, not the role `<select>`.
              7. Every screen not yet on the API-backed allowlist (initially:
                 all except /login) shows the non-dismissable prototype
                 banner; /login never shows it.
              8. Caddyfile serves 31-220-74-159.sslip.io over automatic HTTPS
                 with HTTP->HTTPS redirect, keeps /api/* and JSON logs and the
                 502/503 handler; compose publishes 443/tcp (+443/udp
                 optional); CI's deploy-staging job and
                 playwright.deployed.config.ts resolve the base URL from a
                 `STAGING_URL` repo variable with the existing
                 `http://$STAGING_HOST` behaviour as fallback, documented.
              9. provision.sh idempotently allows 443/tcp; the one host-side
                 command the orchestrator must run is stated verbatim in the
                 final report, and this task does not ssh to the host itself.
              10. npm run check and npm run check:full are green before push.
OWNER         frontend-engineer (web) · devops-guardian informed (T2 infra
              paths) · security-guardian informed (session/cookie handling
              follows ADR-0009/ADR-0022/ADR-0023 as given, not re-decided)
