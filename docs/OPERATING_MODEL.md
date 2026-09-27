# Operating model

**Authority:** LEVEL 1, by [ADR-0024](adr/ADR-0024-operating-model.md). This is the practical companion: who decides, how much process each change pays, and how progress is reported.

> Keep the architecture and every financial protection. Spend process in proportion to risk. Ship workflows the Product Owner can use.

Nothing here relaxes [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md). Exact money, RLS, reversal-only correction, audit, period locking, idempotency and server-side authorization apply to every tier. What varies by tier is the gate a PR runs and who reviews it.

---

## 1. Roles

| Role | Owns | Does not own |
|---|---|---|
| **Product Owner** (human) | Business priority · user-workflow acceptance · budget · production and compliance risk · release readiness · PRD scope | Technical mechanisms — schemas, triggers, lint rules, index shapes |
| **Technical Council** (guardian agents) | Every implementation decision: architecture, posting rules, schema, security | Scope, cost, date, compliance exposure |
| **Engineers** (engineer agents) | Building inside a delivery brief's Paths | Changing a boundary, a kernel or a decision |
| **Orchestrator** (main session) | Decomposing work into briefs, assigning, tracking [BOARD.md](BOARD.md), integrating | Most production code |
| **Maintainer** (human) | Merging and deploying | — agents never merge or deploy |

## 2. The Council

| Seat | Held by | Decides |
|---|---|---|
| Architecture | `architecture-guardian` | Boundaries, interfaces, ADRs, API conventions, cross-cutting concerns |
| Accounting | `accounting-guardian` | Posting rules, COA, tax treatment, reversal, valuation, periods |
| Database/Security | `database-guardian` + `security-guardian` | Migrations, RLS, roles and grants; auth, sessions, permissions, secrets |

Delegated owners decide within their domain the same way: `design-system` (tokens, components, archetypes) and `devops-guardian` (CI, environments, deployment).

**Quorum.** One seat decides inside its domain. A change crossing domains needs each seat it touches. A seat can **reject within its domain**, and no other seat overrides that rejection. A dispute — between seats, or between an engineer and a seat — goes to the Council; it reaches the Product Owner only under §3.

**Timebox.** Every Council decision closes within **2 working days** as *approved*, *rejected*, or *two options with impact*. A seat that cannot approve in time rejects. The request and its date go in [BOARD.md](BOARD.md) "Decisions needed".

## 3. When the Product Owner is asked

Only when a decision materially changes one of:

- **Business scope** — what a user can do, what the PRD promises
- **Cost** — spend, plan, hosting, headcount
- **Compliance exposure** — anything in NON_NEGOTIABLES, [COMPLIANCE_GAPS.md](COMPLIANCE_GAPS.md), or production readiness
- **Delivery date** — a demo or release moving

Also: a tax or statutory rule that is not written down, and a business acceptance criterion that is ambiguous. Those are business rules, not mechanisms.

The ask is always **two options with impact**:

```
DECISION   one line
OPTION A   what happens · cost · date · risk
OPTION B   what happens · cost · date · risk
COUNCIL    which one the Council recommends, and why, in one line
BY         the date the answer is needed
```

Never ask the Product Owner to sign a mechanism.

## 4. Risk tiers

The **highest tier touched wins**. `develop`, release and nightly runs execute **everything**.

**On every PR, at every tier:** static checks, secret scanning, and the **FinancialInvariantSuite**. The last two are LEVEL 0 — [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md) rule 20 and §3 require them *on every PR, not nightly*, and no tier waives them. The invariant suite needs a database, so every PR gets a Postgres service in CI even when nothing else in its tier does.

| Tier | Change type | Example paths | Required gate |
|---|---|---|---|
| **T0** | Docs, copy, prototype UI | `docs/**`, `*.md`, `apps/web/src/mocks/**`, prototype screens | Static (typecheck, lint, format, depcruise) + secrets + affected unit tests + web preview build if web changed |
| **T1** | Normal UI/API behaviour | `apps/web/**`, `apps/api/src/**` (not auth), `modules/*/api/**`, `modules/*/ui/**`, `packages/ui/**` | T0 + affected unit/API tests + one relevant Playwright journey |
| **T2** | Auth, permissions, tenancy, migrations | `packages/auth/**`, `packages/permissions/**`, `packages/database/**`, `database/**`, guards, `infrastructure/**`, `.github/**` | T1 + DB stack + schema, security (adversarial) and integration suites + named Council review (Database/Security or Architecture seat) |
| **T3** | Posting, money, inventory, tax, periods | `packages/accounting-kernel/**`, `packages/inventory-kernel/**`, `packages/validation/**`, posting modules' `domain/` and `application/`, `docs/posting-rules/**`, `tests/accounting/**` | T2 + full financial gate (accounting suite, golden scenarios, reconciliation — the invariant suite already runs on every tier) + Accounting seat review |

**Local.** `npm run check` — fast, no Docker, before every push; CI still runs the invariant suite on the PR. `npm run check:full` — the DB stack and all suites, before any T2 or T3 PR. Both land with OPS-002, which also adds `tools/ci/classify.mjs` to pick the tier from changed paths.

**Pipeline by tier.**

```
T0/T1   brief → build → affected tests → PR → merge
T2/T3   brief → spec (posting rule, threat or schema note) → build → full suites
              → named Council review → PR → merge → verified on staging
```

## 5. The delivery brief

Every task has one. One page. Written with the [delivery-brief skill](../.claude/skills/delivery-brief/SKILL.md).

```
ID & TITLE    M2-004 · Trial balance endpoint
OUTCOME       one sentence, in the user's terms
SCOPE         in: …   out: …
PATHS         ALLOWED   modules/ledger/**, tests/integration/ledger/**
              FORBIDDEN packages/accounting-kernel/**, database/migrations/**
BEHAVIOUR     endpoints, shapes, errors, UI states — or "none"
TIER          T0–T3 → the gate from §4
ACCEPTANCE    3–8 testable checks
OWNER         agent role · Council seat (T2/T3)
```

**Paths are binding.** If the correct fix is outside ALLOWED, stop and report it. The module boundaries in [ARCHITECTURE.md](ARCHITECTURE.md) apply whatever the tier.

## 6. The board

[BOARD.md](BOARD.md) is the single view of work. Columns: **Now · Next · Blocked · Decisions needed · Demo ready**.

- **WIP limit:** the current MVP increment plus one platform task. Nothing else in Now.
- **Blocked** items carry a deadline. Blocked for **2 working days** → it becomes a Council decision, or a Product Owner decision if §3 applies.
- **Decisions needed** names the decider (Product Owner or a Council seat) and the date asked.
- **Demo ready** holds only workflows that run against the real API on staging. A mock-backed screen never goes here.

## 7. Weekly status

One page, in `docs/status/YYYY-Www.md`:

```
WHAT CHANGED       merged this week, in user terms
DEMOABLE           workflows that run on staging against the real API — or "nothing yet"
NEXT WEEK          the increment and its target demo
DECISIONS NEEDED   at most three, each as two options with impact
RISKS              what could move the date, and what is being done
METRICS            the four below
```

## 8. Delivery metrics

| Metric | Why |
|---|---|
| **API-backed workflows working on staging** | **The primary metric.** The only one the Product Owner can use |
| CI minutes per tier | Proves low-risk work stopped paying high-risk process |
| Failed-gate causes | Which checks catch real defects, which are noise |
| Hours waiting for decisions | Proves the timebox holds |

## 9. The MVP slice

Delivered before Waves 3–10 resume. Full text in [IMPLEMENTATION.md](IMPLEMENTATION.md) §13 and [PRD.md](PRD.md) §6.

```
Login → tenant membership → permission check → customer → service invoice (non-stock, no tax)
      → payment → journal entry → customer ledger → trial balance → reversal → audit trail
```

Working on staging for two tenants. **M1** minimum platform · **M2** accounting core · **M3** customers, service invoice, receipts · **M4** API-backed screens and the Playwright journey, then the Product Owner's acceptance demo.

**No new mock-only business screens** until M1–M4 works. Existing mock screens are prototypes, not delivered functionality.
