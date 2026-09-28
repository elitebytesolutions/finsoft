# Runbook: provisioning `finsoft_refresh` on the existing staging cluster

**ADR-0023 §2 / migration 006.** `finsoft_refresh` is the owner of the
pre-tenant refresh resolver (`auth_lookup.resolve_refresh`). It is created by
`infrastructure/docker/postgres/init/00-bootstrap.sh`, which only runs on an
**empty** Postgres data directory. The staging cluster on Contabo already has
a populated volume (`postgres-data`, per `infrastructure/staging/compose.yaml`)
and will not re-run init scripts on the next deploy — so the updated bootstrap
script does **not** reach it. The role must be created **out of band, once**,
before migration 006 is allowed to run there.

This is a one-time operation. It is not part of `deploy.sh` and never will
be: `CREATE ROLE` requires the bootstrap superuser, and `deploy.sh` never
holds that credential (`infrastructure/staging/compose.yaml`'s own comment:
the running application, and by extension the deploy path, must never hold
more than `finsoft_app`'s or `finsoft_migration`'s credentials).

## Gate

**This step is a hard blocker.** Migration 006 opens with:

```sql
DO $g$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finsoft_refresh') THEN
    RAISE EXCEPTION 'finsoft_refresh is missing. ...';
  END IF;
END $g$;
```

so a deploy that reaches migration 006 without this step fails loudly at that
guard, inside `docker compose run --rm migrate` — the deploy stops there and
nothing downstream (the API, the worker) starts on a schema migration 006
half-applied. That is the safe failure mode, but it still means a failed
production... **staging** deploy, at 3am, for a condition this runbook
exists to prevent in advance.

**Run this BEFORE merging the PR that ships migrations 006/007 and
`packages/auth` to `main`** — i.e. before that PR's deploy job reaches
staging. Do not wait for the deploy to fail and fix it reactively.

I (the agent that wrote this) do not have SSH access to the staging host and
have not run this. A human operator with `deploy`/staging access runs the
commands below.

## Prerequisites

- SSH access to the Contabo staging host as the `deploy` user (or root),
  per `infrastructure/staging/provision.sh`.
- `/opt/finsoft/.env` exists on that host (written once, by hand, during
  initial provisioning — `infrastructure/staging/deploy.sh`'s own comment:
  "a workflow run never handles a database password"). It defines
  `POSTGRES_BOOTSTRAP_USER`, `POSTGRES_BOOTSTRAP_PASSWORD`, `POSTGRES_DB`,
  which `infrastructure/staging/compose.yaml` uses to configure the
  `postgres` service.
- **Also required before this same PR's deploy reaches staging, and unrelated
  to this role:** [`RUNBOOK-jwt-keys.md`](RUNBOOK-jwt-keys.md) — the `api`
  service will not boot under `NODE_ENV=production` without
  `AUTH_JWT_PRIVATE_KEY`/`AUTH_JWT_KID`/`AUTH_JWT_PUBLIC_KEYS` set in the same
  `/opt/finsoft/.env`. Two independent one-time host steps, two independent
  runbooks — do both before merging.

## Step 1 — confirm the container name and load the env

```sh
ssh deploy@<staging-host>
cd /opt/finsoft
docker compose ps postgres          # expect: finsoft-staging-postgres-1
set -a; source .env; set +a         # loads POSTGRES_BOOTSTRAP_USER, POSTGRES_DB
```

`finsoft-staging-postgres-1` is the default Compose v2 container name for the
`postgres` service under `name: finsoft-staging` (top of
`infrastructure/staging/compose.yaml`) — confirm with `docker compose ps`
rather than assuming it, in case the naming ever changes.

## Step 2 — create the role (idempotent — safe to re-run)

```sh
docker exec -i finsoft-staging-postgres-1 \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_BOOTSTRAP_USER" -d postgres <<'SQL'
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finsoft_refresh') THEN
    CREATE ROLE finsoft_refresh NOLOGIN NOBYPASSRLS;
  END IF;
END $do$;

-- D6, security/database re-review 2026-09-27. Idempotent correction for a
-- role that might already exist on this cluster from an earlier, HAND-RUN
-- provisioning attempt (exactly the failure mode ADR-0023 §2's own
-- "measurement rule" names — a role created by hand during a measurement
-- session, absent from any script, that every later assertion would then
-- pass for the wrong reason). Restates the two attributes CREATE ROLE
-- already set on a fresh role, and adds NOSUPERUSER, which the DO block
-- above never asserts either way. A no-op on a role this script itself just
-- created; a correction if the role pre-existed with different attributes.
ALTER ROLE finsoft_refresh NOLOGIN NOBYPASSRLS NOSUPERUSER;

GRANT finsoft_refresh TO finsoft_migration WITH INHERIT FALSE, SET TRUE;
SQL
```

This is the exact text of ADR-0023 §2 and of the block added to
`00-bootstrap.sh` in this change — copied, not re-derived, so what runs on
staging is what was reviewed and what runs on every future fresh cluster.
No password, secret or connection string appears in this command; the
bootstrap superuser's credential is supplied by the container's own
environment (`-U` names the role, `docker exec` runs inside the container
where trust/peer or the container's own `PGPASSWORD`-free `psql` config
applies — the same mechanism `00-bootstrap.sh` itself relies on).

`postgres` is the system database — `CREATE ROLE` is cluster-scoped, so which
database this connects to at the top level does not matter, but `postgres`
is always present and never `finsoft`'s own accidental victim of a typo.

## Step 3 — verify

```sh
docker exec -i finsoft-staging-postgres-1 \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_BOOTSTRAP_USER" -d "$POSTGRES_DB" <<'SQL'
SELECT rolname, rolcanlogin, rolbypassrls
FROM pg_roles WHERE rolname = 'finsoft_refresh';

SELECT g.rolname AS member, r.rolname AS role,
       m.inherit_option, m.set_option, m.admin_option
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.roleid
JOIN pg_roles g ON g.oid = m.member
WHERE r.rolname = 'finsoft_refresh';
SQL
```

Expected, exactly:

```
   rolname     | rolcanlogin | rolbypassrls
finsoft_refresh| f           | f

   member          |     role        | inherit_option | set_option | admin_option
finsoft_migration  | finsoft_refresh | f               | t          | f
```

These are the same properties `tools/db/verify.mjs` now asserts on every
freshly-bootstrapped local and CI cluster (`finsoft_refresh is NOLOGIN and
NOBYPASSRLS`, `finsoft_refresh membership options exact`) — this step brings
the existing staging cluster to the same state by hand, once.

If either query returns no rows, or any value differs from the table above,
**stop** — do not proceed to merge/deploy migration 006 against this cluster.

## Notes

- This does not touch `finsoft_app`, `finsoft_migration`'s password, or any
  table. It creates one inert role and one role-membership grant. It cannot
  be used to read or write any tenant data.
- `finsoft_refresh` holds no privileges until migration 006 itself runs
  (`GRANT SELECT (tenant_id, id, token_hash) ON refresh_tokens`, the
  `refresh_lookup` policy, the `auth_lookup` schema and function). This
  runbook only creates the role migration 006's guard checks for.
- Re-running Step 2 after migration 006 has already applied is harmless: the
  `CREATE ROLE` is skipped (already exists) and the `GRANT ... WITH INHERIT
  FALSE, SET TRUE` re-grant is a no-op on PostgreSQL 17 when the membership
  already has those exact options.
- If staging is ever rebuilt from an empty volume (`docker compose down -v`
  on that host — not expected, but possible during a disaster-recovery
  drill), this step is unnecessary: the updated `00-bootstrap.sh` creates the
  role automatically, since CI ships
  `infrastructure/docker/postgres/init/*` to `/opt/finsoft/postgres/init/`
  on every deploy (`.github/workflows/ci.yml`, the "ship configuration"
  step).

## Unrelated but adjacent: the refresh cookie prefix differs by environment

Not part of provisioning `finsoft_refresh` — recorded here because it is the
other piece of ADR-0023 that is environment-specific and easy to copy
verbatim by mistake between staging and production.

`infrastructure/staging/compose.yaml`'s `api` service now sets:

```yaml
AUTH_REFRESH_COOKIE_NAME: __Host-finsoft_rt
AUTH_REFRESH_COOKIE_PATH: /
```

This is **staging-only**. The staging host (`31-220-74-159.sslip.io`) shares
its registrable domain, `sslip.io`, with every other service hosted under
sslip.io — `sslip.io` is not on the Public Suffix List, so the browser treats
it as one registrable domain, not as a suffix. ADR-0023's Open item on the
cookie prefix names exactly this case as the exception to its own default
recommendation: `__Host-`'s anti-subdomain-shadowing property wins when the
app shares a registrable domain with anything else. `__Host-` forces
`Path=/`, which is why both variables change together.

**Production must use the ADR's default recommendation instead**, because
production does not share its registrable domain with anything else:

```yaml
AUTH_REFRESH_COOKIE_NAME: __Secure-finsoft_rt
AUTH_REFRESH_COOKIE_PATH: /api/auth
```

`apps/api/src/auth/cookie.ts`'s `assertProductionCookieSecurity()` fails
startup (refuses to boot) when `NODE_ENV=production` and
`AUTH_REFRESH_COOKIE_NAME` carries neither prefix — so a deploy that forgets
to set it at all fails loudly at boot, in either environment, rather than
serving an unprefixed cookie. It does **not** and cannot enforce which of
the two prefixes is *correct* for a given host, only that one of them is
present; that judgement (registrable-domain sharing) is an environment fact,
recorded here rather than in code.

**Governance note, stated plainly rather than silently assumed:** ADR-0023's
own "Open" section marks the cookie prefix as a **GATE** — *"`/auth/login`
emits no `Set-Cookie` until this is recorded. Decider: Architecture Guardian
plus whoever owns the domain layout."* As of this commit, `docs/adr/ADR-0023-pre-tenant-authentication-reads.md`'s
signature block still shows the Architecture Guardian's line for that gate
unchecked. This runbook implements the environment-specific *values* that
follow from the ADR's own stated rule once a domain topology is known; it
does not substitute for that rule itself being recorded as decided. Before
this configuration is relied on for a real deploy, confirm the Architecture
Guardian has signed off on the cookie-prefix decision in the ADR itself —
if the "HTTPS cut-over review" that requested this change already carries
that sign-off, the ADR's Open section and signature block should be updated
to say so; if it does not, this configuration is technically sound but
formally ungated.
