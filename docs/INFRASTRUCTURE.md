# INFRASTRUCTURE

**Status:** Factory Constitution v1
**Authority:** LEVEL 1 for isolation and access rules (§4, §6, §7); LEVEL 2 for sizing and provider choice.

---

## 1. Topology

Staging and production live with **different providers**. This is deliberate — provider-level separation means a Contabo outage cannot take production down.

```
                        Cloudflare
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
      staging.finsoft.app         app.finsoft.app
                │                       │
                ▼                       ▼
            CONTABO                 HOSTINGER
            STAGING                PRODUCTION
          4 vCPU / 8 GB          KVM 2 — 2 vCPU / 8 GB
                │                       │
                ▼                       ▼
         Docker Compose          Docker Compose
         ├ Next.js (web)         ├ Next.js (web)
         ├ NestJS (api)          ├ NestJS (api)
         ├ Worker                ├ Worker
         ├ PostgreSQL            ├ PostgreSQL
         └ Redis                 └ Redis
```

| Environment | Provider | Size | Purpose |
|-------------|----------|------|---------|
| Staging | Contabo | 4 vCPU / 8 GB | QA, UAT, migration rehearsal |
| Production | Hostinger | KVM 2 — 2 vCPU / 8 GB | Live tenants |
| Production (growth) | Hostinger | KVM 4 — 4 vCPU / 16 GB | When load requires |

Each provider plays to its strength: Contabo gives cheap CPU/RAM for CI and test workloads; Hostinger gives NVMe, simpler management and better backup tooling for production.

### The one caveat

**Staging is not a performance benchmark.** CPU allocation, storage, networking, contention and virtualisation differ between providers. If staging says 250 ms and production says 90 ms, neither number predicts the other.

That is fine, because staging exists to test *behaviour*: voucher creation, invoices, stock movements, migrations, authentication, permissions, regressions. None of those care who owns the hypervisor.

Performance budgets ([ARCHITECTURE §11](ARCHITECTURE.md)) are measured on **production-like hardware**, not on staging.

---

## 2. Software parity

Far more important than provider parity. These are identical across environments:

```
Ubuntu version        SAME
Node version          SAME
PostgreSQL version    SAME
Redis version         SAME
Docker images         SAME  (byte-identical, same digest)
Nginx configuration   SAME
Application build     SAME
Database schema       SAME
Migration mechanism   SAME
```

Only environment variables differ:

```
STAGING                              PRODUCTION
NODE_ENV=staging                     NODE_ENV=production
DATABASE_URL=...staging...           DATABASE_URL=...production...
APP_URL=https://staging.finsoft.app  APP_URL=https://app.finsoft.app
```

The same image digest that passed staging is what runs in production. We do not rebuild for production — a rebuild is a different artefact.

```
GitHub repository
       │
       ▼
Build Docker images  (once, tagged by commit SHA)
       │
  ┌────┴─────┐
  ▼          ▼
Contabo    Hostinger
staging    production
   same image digest
```

---

## 3. Deployment flow

```
feature/*
    ↓  PR + all gates
develop
    ↓  automatic
CONTABO STAGING
    ↓  QA / UAT
merge to main
    ↓  human approval (GitHub environment protection)
HOSTINGER PRODUCTION
    ↓
smoke tests
```

GitHub deployment environments enforce:

- Branch restrictions — only `main` may deploy to production.
- Protected environment secrets — production credentials are not visible to staging workflows.
- Required reviewers — a human approves the production job before it runs.
- **Self-approval prevented** — whoever initiated the deployment cannot be its approver.

No agent has a path to production deployment. An agent can open a PR; it cannot approve, merge, or deploy.

---

## 4. Database isolation — hard rule

```
Contabo                          Hostinger
├── staging web                  ├── production web
├── staging api                  ├── production api
├── staging worker               ├── production worker
└── staging PostgreSQL           └── production PostgreSQL
```

**Never:**

```
Contabo staging ──────► production PostgreSQL     ✗ FORBIDDEN
CI              ──────► production PostgreSQL     ✗ FORBIDDEN
local dev       ──────► production PostgreSQL     ✗ FORBIDDEN
```

For an accounting system this is not a hygiene preference. A staging test run pointed at production would write real vouchers, ledger entries, invoices, cheques, stock movements and balances — and under [NON_NEGOTIABLES](NON_NEGOTIABLES.md) rule 4 we cannot delete them to clean up.

Production credentials exist only in the production environment's protected secret store. They are not in `.env` files, not in the repository, not in CI logs, not in any agent's context.

If staging needs realistic data, it gets an **anonymised, sanitised copy**: names, addresses, phone numbers, NTNs, bank accounts and user emails replaced; amounts optionally scaled. The sanitisation job is code, reviewed, and run in a controlled environment — never a manual `pg_dump | psql`.

---

## 5. Production database roles

No shared passwords, no shared accounts.

| Role | Grants | Used by |
|------|--------|---------|
| `finsoft_app` | CRUD on application tables, **subject to RLS**, INSERT-only on audit | The running API/worker |
| `finsoft_readonly` | SELECT only, subject to RLS | Support queries, read replica |
| `finsoft_migration` | DDL, `BYPASSRLS` | Migration job only, during deploy |
| `finsoft_breakglass` | Superuser | Emergencies only |
| `finsoft_refresh` | `NOLOGIN`, `NOBYPASSRLS`; owns `auth_lookup.resolve_refresh` (migration 006, ADR-0023 §2) and a column-scoped `SELECT (tenant_id, id, token_hash)` on `refresh_tokens`; a member of nothing, and `finsoft_migration` holds `SET` (not `INHERIT`) on it | Never connects directly — reached only via `SET ROLE` inside migration 006's own `SECURITY DEFINER` function body, so the refresh path can resolve a token's tenant before any session exists |

`finsoft_refresh` is created by `infrastructure/docker/postgres/init/00-bootstrap.sh` on an empty data directory (`finsoft_migration` has no `CREATEROLE`, so a migration cannot create it). An **existing** cluster — including this table's own production and staging clusters at the time migration 006 first ships — needs it provisioned out of band, once: see `infrastructure/staging/RUNBOOK-finsoft-refresh-role.md`.

Break-glass use is:

```
logged · time-limited · MFA-protected · reason-required · reviewed afterward
```

`finsoft_app` must **not** have `BYPASSRLS`. A schema test asserts this on every deploy — it is the difference between RLS being a control and RLS being decoration.

---

## 6. Secrets

- Stored in GitHub environment secrets and injected at deploy; never in the repository.
- Production secrets are scoped to the production environment only.
- Rotated on a schedule and on any suspected exposure.
- Never logged, never echoed in CI output, never placed in an agent's prompt or context.
- Secret scanning runs on every PR and blocks merge.

An agent that needs a credential to complete a task has been given the wrong task.

---

## 7. Backups

Minimum policy:

```
continuous WAL archiving     daily full backup
weekly backup                monthly retention
encrypted at rest            off-site copy (different provider than production)
```

Targets: **RPO ≤ 15 minutes, RTO ≤ 4 hours.**

The metric that matters is **not** "backup succeeded". It is:

> Can we restore, and how long did it take?

Automated restore drills run on a schedule into an isolated environment, and the drill asserts more than "the database started": it runs the FinancialInvariantSuite against the restored data. A restore that produces an unbalanced trial balance is a failed restore.

Backup status is a monitored metric. A missed backup pages someone.

---

## 8. Observability stack

```
Application  →  structured JSON logs  →  log aggregation
             →  metrics               →  dashboards + alerting
             →  traces (request_id)   →  correlation across api/worker
```

Alerting thresholds:

| Signal | Alert |
|--------|-------|
| HTTP 5xx rate | > 1% over 5 min |
| Posting failures | any |
| Reconciliation failure | any |
| Invariant check failure (scheduled prod run) | any — Sev-1 |
| Queue depth | sustained growth over 15 min |
| DB connection saturation | > 80% |
| Failed login burst | threshold per tenant |
| Backup job | any failure or missed window |
| Disk / storage | > 80% |
| Certificate expiry | < 21 days |

---

## 9. Growth path

Initial setup is correct for now. The change to make **later**, when the data becomes valuable, is not "move staging to Hostinger" — it is:

```
Hostinger production app VPS
            │
            ▼
   separate PostgreSQL host (dedicated VPS or managed)
            │
            ▼
   off-site encrypted backups + read replica for reporting
```

Separating production PostgreSQL from the application server matters considerably more than whether staging and production share a provider.

Later, also: move heavy reporting to the read replica, and extract notifications / PDF generation / FBR integration into separate workers.

---

## 10. Local development

```
docker compose up
├── postgres   (same major version as production)
├── redis
├── api        (watch mode)
├── web        (watch mode)
└── worker
```

Seeded with fixtures and a demo tenant. Every developer and every agent gets an isolated database. `docker compose down -v && docker compose up` must produce a working system from scratch — if it does not, that is a Wave 0 bug.

---

## 11. Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — system structure
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — release model and gates
- [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md) — rules 20, 21
