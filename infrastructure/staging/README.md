# Staging (Contabo) — one-time host steps

`infrastructure/staging/compose.yaml`, `deploy.sh`, `Caddyfile` and
`infrastructure/docker/postgres/init/*` are shipped to `/opt/finsoft` by the
`deploy-staging` CI job on every full run (`.github/workflows/ci.yml`). That
covers everything CI can reach. It does **not** cover the staging Postgres
cluster's existing (non-empty) data directory, and it never will hold a
signing key or a database password — those live only on the host, in
`/opt/finsoft/.env`, written by hand.

The two runbooks below are each a **hard blocker**: a deploy that reaches
staging without them fails — the first at migration 006's own guard inside
`docker compose run --rm migrate`, the second with the `api` service
crash-looping on `packages/auth/src/jwt.ts`'s boot check (or, since
`compose.yaml`'s `AUTH_JWT_*` entries carry a `:?` guard, `docker compose
up` itself refusing to start `api` at all).

## MUST run before merging a PR that reaches staging

- [ ] **[`RUNBOOK-finsoft-refresh-role.md`](RUNBOOK-finsoft-refresh-role.md)**
      — required before merging any PR that ships migration 006/007 and
      `packages/auth` to `main`. Creates the `finsoft_refresh` role on the
      existing (non-empty) staging Postgres volume, which the updated
      bootstrap script cannot reach because it only runs against an empty
      data directory.
- [ ] **[`RUNBOOK-jwt-keys.md`](RUNBOOK-jwt-keys.md)** — required before
      merging any PR that ships `packages/auth` to `main` (same PR, as of
      this writing). Generates the RSA key pair staging's `api`/`worker`
      need to boot under `NODE_ENV=production`, and appends
      `AUTH_JWT_PRIVATE_KEY` / `AUTH_JWT_KID` / `AUTH_JWT_PUBLIC_KEYS` to
      `/opt/finsoft/.env`.

Both are one-time (until the JWT keys are rotated, or the volume is rebuilt
from empty) and both are run by a human operator with SSH access to the
staging host — no agent has, or should ever be given, that access or the
contents of `/opt/finsoft/.env`.

See also [`docs/workflows/ci-tiers.md`](../../docs/workflows/ci-tiers.md)
for what CI runs automatically, and
[`docs/INFRASTRUCTURE.md`](../../docs/INFRASTRUCTURE.md) for the environment
topology and database-role model these steps sit inside.
