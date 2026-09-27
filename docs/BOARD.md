# Board

**Rules:** [OPERATING_MODEL.md](OPERATING_MODEL.md) §6. Updated by the orchestrator whenever a card moves.

- **WIP limit:** the current MVP increment plus one platform task in **Now**. Nothing else starts.
- **Blocked 2 working days** → it becomes a Council decision, or a Product Owner decision if it changes scope, cost, compliance exposure or date.
- **Decisions needed** name the decider and the date asked; each closes within 2 working days.
- **Demo ready** holds only workflows running against the real API on staging. Mock screens never go here.

*Last updated: 2026-09-27.*

---

## Now

| ID | Item | Tier | Owner | Brief |
|---|---|---|---|---|
| OPS-001 | Operating model — ADR-0024, delivery-brief skill, governing docs, this board | T0 | architecture-guardian | branch `feature/OPS-001-operating-model` |
| OPS-002 | CI by tier — `tools/ci/classify.mjs`, `npm run check` / `check:full` | T2 | devops-guardian · Database/Security seat | parallel session. **Must keep secrets + FinancialInvariantSuite on every PR** (NON_NEGOTIABLES §3, rule 20) |

## Next — M1, minimum platform

| Lane | Items | Tier | Seat |
|---|---|---|---|
| **Auth** | W1-002 auth package + W1-003 login / refresh endpoints — tenant-code login, refresh rotation (ADR-0022, ADR-0023) | T2 | Database/Security |
| **RBAC** | W1-004 — migration 008, MVP permission catalogue, real `TenantGuard` | T2 | Database/Security + Architecture |
| **Audit** | W1-005 — migration 009 `audit_log` + chain verifier per ADR-0020. **After merging** `feature/W1-000-adr-0020-audit-canonicalisation` | T2 (T3 for the financial-mutation hook) | Database/Security + Accounting |
| **Web + infra** | Login page · API client · prototype banner on mock screens · staging HTTPS on `31-220-74-159.sslip.io` · seed for two demo tenants | T1 / T2 | Architecture · devops-guardian |
| **Exit** | W1-006 exit suite — authorised access succeeds, cross-tenant fails, at API and SQL | T2 | Database/Security |

Then **M2** accounting core · **M3** customers, service invoice, receipts · **M4** API-backed journey + Product Owner demo ([IMPLEMENTATION.md](IMPLEMENTATION.md) §13).

## Blocked

| Item | Blocked on | Deadline |
|---|---|---|
| W1-002 / W1-003 merge | ADR-0023 Architecture seat signature | 2026-09-29 |
| W1-005 | ADR-0020 branch merged to `develop` | 2026-09-29 |

## Decisions needed

| Decider | Decision | Asked | Council recommendation |
|---|---|---|---|
| **Product Owner** | Sign [ADR-0024](adr/ADR-0024-operating-model.md) | 2026-09-27 | Sign. Note one change from the brief: the FinancialInvariantSuite runs on every PR at every tier, because NON_NEGOTIABLES §3 requires it |
| **Product Owner** | Names of the two demo tenants | 2026-09-27 | Two fictitious trading companies; no real business names on staging |
| **Product Owner** | Weekly demo day | 2026-09-27 | One fixed day; the status page is written the day before |
| **Council — Architecture** | ADR-0023, pre-tenant authentication reads — the remaining signature (Product Owner slot withdrawn by ADR-0024) | 2026-09-27 | — |
| **Council — Accounting + Architecture** | Service sale: a `SALE_POSTED` variant, or a new financial event | 2026-09-27 | **Variant** — one sale event with a non-stock line type keeps a single posting rule family; stock lines add COGS later without a new event |
| **Council — Architecture (+ Accounting for D4, D6)** | The D1–D9 deferrals and the reconciliation-scope deferral ([RECONCILIATION-2026-09](adr/RECONCILIATION-2026-09.md), [WAVE_0_REGISTER](WAVE_0_REGISTER.md)) — moved from the Product Owner by ADR-0024 | 2026-09-27 | — |

## Demo ready

*Nothing yet.* No workflow runs against the real API on staging. The screens in `apps/web` are prototypes.
