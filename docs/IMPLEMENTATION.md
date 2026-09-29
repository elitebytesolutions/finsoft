# IMPLEMENTATION PLAN — The Software Factory

**Status:** Factory Constitution v1
**Authority:** LEVEL 2 for sequencing; the gates and policies in §6–§10 are LEVEL 1 and require an ADR to change.
**Governed by [ADR-0024](adr/ADR-0024-operating-model.md) (2026-09-27):** §5–§10 describe the risk-tiered process — delivery brief, pipeline by tier, DoR, DoD per tier, reviewers per tier. Roles, tiers and the board are detailed in [OPERATING_MODEL.md](OPERATING_MODEL.md). The Technical Council owns this process; the Product Owner owns scope and sequencing priority.

This document describes **how work gets done** — how it is decomposed, assigned, bounded, reviewed and released. It is the operating manual for the factory.

---

## 1. The factory

We are not opening fifteen coding sessions and letting them work independently. We are running a controlled factory with ownership boundaries.

```
                         PRODUCT OWNER (human)
             scope · priority · budget · compliance · release · acceptance
                                │
                                ▼
                    ┌──────────────────────┐
                    │ FACTORY ORCHESTRATOR │   ← the main Claude Code session
                    └──────────┬───────────┘
                               │
             ┌─────────────────┼─────────────────┐
             ▼                 ▼                 ▼
      TECHNICAL COUNCIL — every implementation decision
      Architecture seat   Accounting seat   Database/Security seat
             │                 │                 │
             └────────┬────────┴────────┬────────┘
                      ▼                 ▼
               PLATFORM SQUAD      DOMAIN SQUADS          (engineers + QA)
            DB / migrations        Finance / GL
            Auth / tenant          Banking
            API framework          Customers / Vendors
            Design system          Inventory
            CI/CD                  Procurement
            Observability          Sales · Reporting · Tax
```

The Product Owner is asked only when a decision changes business scope, cost, compliance exposure or delivery date — as two options with impact ([ADR-0024](adr/ADR-0024-operating-model.md)). Everything technical closes in the Council within two working days.

**The orchestrator does not write most production code.** Its job is: decompose work into safe tasks, assign ownership, prevent collisions, verify acceptance criteria, track dependencies, and coordinate integration. That distinction is what keeps the repository coherent.

Agent definitions live in [`.claude/agents/`](../.claude/agents/) and are invocable as Claude Code subagents.

---

## 2. Control hierarchy

```
LEVEL 0   Financial invariants        Cannot be overridden by anyone
LEVEL 1   Architecture policies       Require an ADR, decided by the Technical Council
LEVEL 2   Product specifications      Require Product Owner approval
          Delivery process            Technical Council (ADR-0024)
LEVEL 3   Engineer implementation     Freely optimised within the brief's Paths
```

| Who | Decides |
|---|---|
| **Product Owner** | Business priority, workflow acceptance, budget, production and compliance risk, release readiness, PRD scope |
| **Technical Council** | Architecture, posting rules, schema, security — one seat within its domain, every touched seat across domains |
| **Engineers** | How to build it, inside the brief |

Never invert this into:

```
agent-generated code → becomes architecture → becomes business rule
```

That inversion is how large AI-built codebases become incoherent. An implementation detail does not get promoted to a rule by having survived a few merges.

---

## 3. How many parallel sessions

The limiting factor is **not** AI coding speed. It is integration, schema coordination, business-rule coordination, review, testing and merge conflicts. Ten agents producing incompatible code is slower than six agents inside clean boundaries.

| Phase | Active code-modifying sessions |
|-------|-------------------------------|
| Wave 0–1 (foundation) | 4–5 |
| Wave 2–4 (core) | 6–8 |
| Wave 5–7 (peak modules) | 8–10 |
| Integration / release | 3–5 |

Maximum **10–12 specialist contexts** may exist; normally only **6–8 should be actively modifying code at once**.

### Three layers move at three speeds

```
LAYER 1   Foundations         few agents, very careful
LAYER 2   Business modules    many parallel agents, fast
LAYER 3   Posting / integration   few guardian agents, very careful
```

The mistake would be treating all three the same. CRUD screens can move extremely fast. The accounting kernel moves deliberately.

### Never parallelise these

One team defines them; everyone else consumes them:

```
journal schema + posting algorithm     stock valuation algorithm
tenant architecture                    authentication model
permission model                       migration framework
money / currency representation        fiscal period locking
number sequencing
```

---

## 4. Branches and worktrees

Each session works in its own git worktree or branch, with an explicit file ownership boundary.

```
main
├── agent/platform-auth
├── agent/accounting-kernel
├── agent/database-core
├── agent/design-system
├── agent/testing-foundation
├── agent/banking
├── agent/customers
└── agent/inventory
```

Branches are short-lived. `main` is always production-quality. No long-running integration branches — they hide conflicts until they are expensive.

---

## 5. The delivery brief

Every task has a one-page brief. An agent without a brief writes one with the [`delivery-brief` skill](../.claude/skills/delivery-brief/SKILL.md) before its first edit.

```
ID & TITLE    INV-021 · Create stock movement entity
OUTCOME       the inventory kernel can represent an inward or outward movement
SCOPE         in: value object + rejections    out: repository, migration
PATHS         ALLOWED   packages/inventory-kernel/src/domain/**, tests/accounting/inventory/**
              FORBIDDEN database/migrations/**, packages/auth/**, modules/**
BEHAVIOUR     none (domain only)
TIER          T3 → full financial gate + Accounting seat
ACCEPTANCE    - Quantity is decimal, never number
              - tenant_id required and typed
              - Rejects zero and negative quantity; a unit test per rejection
              - No import from modules/* or NestJS
OWNER         backend-engineer · Accounting seat
```

`ALLOWED` is the only place the agent may write. `FORBIDDEN` is not advisory. An agent that needs to change something outside `ALLOWED` **stops and reports** — it does not "quickly also fix" the adjacent thing. The tier sets the gate ([OPERATING_MODEL.md](OPERATING_MODEL.md) §4); the highest tier touched wins.

This is what prevents an agent from casually refactoring the entire application while implementing a list endpoint.

---

## 6. Task size

Do not issue: *"Build inventory."*

Issue one brief per coherent change:

```
INV-021  Create stock movement entity                          T3
INV-022  Create stock movement repository + migration          T3
INV-023  Implement stock-in transaction                        T3
INV-024  Implement stock-out transaction with FEFO batch selection  T3
INV-025  Enforce negative-stock policy                         T3
INV-026  Implement running balance query                       T3
INV-027  Stock movement listing UI                             T1
INV-028  Inventory reconciliation invariant tests              T3
```

**Target: one task = one coherent PR, within the WIP limit on [BOARD.md](BOARD.md).** Agent output quality falls off sharply above that size, and review quality falls off with it.

---

## 7. The feature pipeline — by tier

Process is spent in proportion to risk ([OPERATING_MODEL.md](OPERATING_MODEL.md) §4). The highest tier touched wins.

```
T0 / T1   docs, copy, prototype UI, normal UI/API behaviour
   Brief → Build → Affected tests → PR → Merge

T2 / T3   auth, permissions, tenancy, migrations — posting, money, inventory, tax, periods
   Brief
   ↓  Specification — posting rule, threat model or schema note; the accounting impact is decided here
   ↓  Build
   ↓  Unit + integration + schema/security suites (T3: + full financial gate)
   ↓  Named Council seat review (T3: Accounting seat)
   ↓  PR → Merge
   ↓  Verified on staging
```

An agent never goes from *"user wants cheque management"* directly to *"write 8,000 lines"*. For T2/T3 there is always an intermediate specification, and that specification is where the accounting impact gets decided.

Release to production keeps its own gates regardless of tier: staging → UAT → Product Owner release readiness → production (§12, §16).

### Board

Work is tracked on [BOARD.md](BOARD.md): **Now · Next · Blocked · Decisions needed · Demo ready**. WIP limit: the current MVP increment plus one platform task. **Agents may not start a task with no brief.**

---

## 8. Definition of Ready

A task is ready when it has **a delivery brief with a tier** — ID and title, outcome, scope, Paths, behaviour, tier, 3–8 testable acceptance checks, owner (and Council seat for T2/T3).

T2 and T3 briefs also state, explicitly:

```
☐ Accounting impact  (or: none)          ☐ Inventory impact (or: none)
☐ Permissions required                   ☐ Audit requirement
☐ Negative and concurrency test cases    ☐ Affected tables
```

"Accounting impact: none" must be *stated*, not left blank — the act of stating it is the check.

---

## 9. Definition of Done — per tier

A ticket is not done because the page looks right. Tiers are cumulative.

```
ALL   acceptance checks met · type check · lint · format · depcruise · secret scan clean
      FinancialInvariantSuite green (NON_NEGOTIABLES §3: every PR, not nightly)
      no TODOs masking incomplete work · stayed inside ALLOWED

T0    affected unit tests · web preview build if web changed

T1    affected unit + API tests · one relevant Playwright journey
      RBAC tested (missing permission → 403, not 500, not 200)
      API documented (OpenAPI) · UI and error states handled · structured logging for business events

T2    DB stack: schema, integration and adversarial security suites
      tenant isolation tested (adversarial: tenant B cannot reach tenant A)
      migration reviewed and safe (forward, backward-compatible first)
      named Council seat review · verified on staging

T3    golden scenarios · reconciliation · accounting suite · domain invariants tested
      audit records asserted in tests · Accounting seat review
```

---

## 10. Review and merge policy — per tier

Required checks on a PR are selected by tier (`tools/ci/classify.mjs`, OPS-002). **Every PR, at every tier, runs secret scanning and the FinancialInvariantSuite** — both are LEVEL 0 requirements on every PR, and a tier cannot waive them. **`develop`, release and nightly run everything.**

| Tier | Required checks | Required reviewer |
|------|-----------------|-------------------|
| **T0** | build · typescript · lint · format · depcruise · secret scanning · FinancialInvariantSuite · affected unit | One peer agent |
| **T1** | T0 + affected API tests · Playwright journey | One peer agent; `packages/ui/**` → design-system |
| **T2** | T1 + database integration · schema · security (adversarial) · migration checks · SAST | Database/Security seat (migrations, RLS, auth, permissions); Architecture seat (`packages/database/**`, guards); `infrastructure/**`, CI → devops-guardian + Security |
| **T3** | T2 + golden scenarios · reconciliation · accounting suite | Accounting seat + Architecture seat (kernels, module domain that posts); Database/Security seat for financial-table migrations |

**An agent never merges its own PR.** A seat's rejection is final within its domain and is not argued around. A dispute goes to the **Technical Council**, which closes it within two working days; it reaches the Product Owner only when it changes scope, cost, compliance exposure or delivery date ([ADR-0024](adr/ADR-0024-operating-model.md)), as two options with impact.

---

## 11. Migration policy

```
001_create_tenants.sql
002_create_users.sql
003_create_accounts.sql
...
```

Rules:

- **Immutable after release.** A released migration is never edited. Fix forward.
- Forward migration preferred; backward-compatible change first, then cleanup in a later release.
- Data migration is reviewed separately from schema migration.
- Large-table migrations are tested against production-sized data before release.
- Backup taken and verified before any destructive migration.
- Rollback strategy documented in the PR.
- **`ALTER` on production by hand is forbidden** outside a documented emergency procedure.

Every production transaction table carries:

```
id · tenant_id · created_at · created_by · updated_at · updated_by · version
```

And where relevant:

```
posted_at · posted_by · reversed_at · reversed_by
status · fiscal_period_id · reference_number
```

Schema rules enforced in `database/tests/`:

```
PK on every table                 FK wherever a relationship exists
NOT NULL aggressively             CHECK constraints for enums and ranges
unique business constraints       numeric money types only
tenant_id indexed, leading        RLS enabled and forced on tenant tables
no MAX(id)+1                      no ON DELETE CASCADE on financial relations
```

---

## 12. Release model

One release train. One version. One schema version.

```
Development   continuously
Staging       daily
Production    weekly / controlled
```

Different agents do **not** independently deploy different modules. The ERP ships as one artefact — `FinSoft 1.x.y` — with known-compatible components.

```
main → CI → Docker image → immutable release
     → staging → regression → human approval → production → smoke tests
```

---

## 13. The waves

### Wave 0 — Factory foundation

Build the factory before building the product.

```
monorepo + workspace tooling      Docker local stack
CI/CD skeleton                    coding standards + lint + format
AGENTS.md + NON_NEGOTIABLES       ADR-0001..0012
structured logging                test framework + fixtures
design system skeleton            database framework + tenant context + RLS helpers
```

**Do not build business features in Wave 0.** Exit criterion: an empty-but-real vertical (one health endpoint, one page, one table, one migration, one test of each kind) goes from a branch to staging through the full pipeline, automatically.

> **Task register:** the `FND-000…018` contracts — scope, dependencies, acceptance criteria, status and evidence — are recorded in
> [WAVE_0_REGISTER.md](WAVE_0_REGISTER.md). They previously existed only in planning conversation, which meant the scope of Wave 0 was
> not durable between sessions.
>
> **"One test of each kind" has an open scope question.** `tests/reconciliation/` has no suite and cannot have a meaningful one until a
> posting exists. A deferral to Wave 5/6 is proposed, with an owner and acceptance criteria — see the register. Under
> [ADR-0024](adr/ADR-0024-operating-model.md) the decision moved from the Product Owner to the **Technical Council** (Architecture
> seat); it is tracked on [BOARD.md](BOARD.md). Wave 0 does not close on that deliverable until the decision is recorded.

### Wave 1 — Platform

```
Session A → Authentication
Session B → Tenant system + RLS
Session C → RBAC + permission catalogue
Session D → Audit log + hash chain
Session E → CI hardening + test foundation
```

Exit: a user in tenant A provably cannot read tenant B's data, by test, at both API and SQL levels.

### Wave 2 — Financial kernel *(the milestone that matters)*

```
Accounting Guardian → Chart of Accounts + posting rules spec
Database Guardian   → journal schema, constraints, indexes
Backend Engineer    → posting engine + journal API
Frontend Engineer   → voucher entry UI
QA Engineer         → FinancialInvariantSuite + golden scenarios
Backend Engineer 2  → account ledger + trial balance
```

Delivers: COA · journal voucher · general ledger · trial balance · period controls · reversal · audit.

**If these are not mathematically reliable, stop everything else.** No wave 3 work starts while an invariant is red.

### MVP slice (M1–M4) — *the demo that proves the factory*

Waves 1 and 2 are delivered as **one thin, demoable journey** rather than as complete layers. Approved by the Product Owner, 2026-09-27 ([ADR-0024](adr/ADR-0024-operating-model.md)).

```
Login → tenant membership → permission check → customer → service invoice (non-stock, no tax)
      → payment → journal entry → customer ledger → trial balance → reversal → audit trail
```

Working on **staging, for two tenants**. No sales tax, no stock, MFA deferred ([GAP-003](COMPLIANCE_GAPS.md)), a minimal ~20-account standard chart of accounts.

| Increment | Delivers |
|---|---|
| **M1 — Minimum platform** | Auth including tenant-code login and refresh rotation · real `TenantGuard` · RBAC migration 008 with the MVP permissions · `audit_log` migration 009 + chain verifier per ADR-0020 · web login page + API client · staging HTTPS on `31-220-74-159.sslip.io` · the W1-006 exit suite |
| **M2 — Accounting core** | Posting-rules spec including the standard COA · migrations 010 `accounts`, 011 `fiscal_periods`, 012 `journal_entries`/`journal_lines`, 013 `document_sequences` · `postingEngine` · account ledger + trial balance · invariants 1, 2, 4, 5, 6, 8 enforced |
| **M3 — Customers, service invoice, receipts** | Migrations 015–017 (renumbered 2026-09-29; 014 taken by the M2-B permission backfill — [M3 README](design/M3/README.md) §2) · AR subledger · invariant 9, AR half |
| **M4 — The journey, on real screens** | API-backed screens replacing the mocks for the journey · a Playwright journey passing for both tenants on staging · **Product Owner acceptance demo** |

- **Each increment must be demoable.** The Product Owner accepts workflows, not database details.
- **WIP limit:** the current increment plus one platform task.
- **No new mock-only business screens** until M1–M4 works. Existing mock screens are prototypes, not delivered functionality.
- **Waves 3–10 resume after M4 acceptance.** Wave 1's and Wave 2's remaining scope folds into them or into later increments on [BOARD.md](BOARD.md).

### Wave 3 — Cash and banking

Cash receipts/payments · cash book · bank accounts · bank receipts/payments · bank book · cheque lifecycle · bank reconciliation. Every flow posts through the accounting kernel.

### Wave 4 — Customers and vendors

Customers · vendors · customer ledger · vendor ledger · receivables · payables · credit terms · statements · allocations. At this point the system is already a serious accounting platform.

### Wave 5 — Products and inventory

```
Squad A → products, classes, companies, barcodes, units
Squad B → movements, warehouses, batches, expiry, transfers,
          adjustments, physical count, valuation
```

The inventory kernel mirrors the accounting kernel: no other module changes quantity — everything calls `inventory.postMovement(...)`.

### Wave 6 — Procurement

```
Demand → PO → GRN → Inventory → Supplier payable → GL
```

One end-to-end flow is worth more than twenty disconnected screens. Build the vertical, then widen it.

### Wave 7 — Sales

```
Quotation → Sale → Stock Out → Invoice → GL → Payment → Customer Ledger
```

### Wave 8 — Reporting

Only after transactional correctness. Reports read operational truth and **contain no hidden accounting corrections**. A report that needs to adjust a number is reporting a bug, not a number.

### Wave 9 — Compliance

Tax engine · GST · further tax · FBR POS · NTN · Zakat · controlled-substance register — all behind adapters and configuration, so a regulatory change never requires editing Sales.

### Wave 10 — Migration

```
Extract → Normalize → Validate → Import → Reconcile
```

Not complete until legacy and new trial balances, customer balances, vendor balances and stock agree.

---

## 14. Parallel execution — worked example

Implementing procurement. **Not** "10 agents → purchase module". Instead:

```
Session 1   PO domain model
Session 2   PO APIs
Session 3   PO frontend
Session 4   GRN domain
Session 5   Inventory integration
Session 6   Accounting integration
Session 7   Test automation
Session 8   Security / permission review
```

With explicit dependencies:

```
PO domain
   ↓
API ───── UI
   ↓
GRN
   ↓
Inventory
   ↓
Accounting
```

Agents blocked on a dependency work **against the agreed interface** — the published types and contract — rather than editing one another's code or waiting idle. The interface is agreed before the dependent work starts; that agreement is the orchestrator's job.

---

## 15. The UI factory

We have already explored many UI directions for banking, cheques, vouchers, ledgers, customers, vendors, product classes and reports. Agents must **not** recreate those independently.

The Financial UI Kit in `packages/ui`:

```
PageHeader        FinancialKPI      EntityCard       DataGrid
LedgerGrid        MoneyCell         DebitCreditCell  RunningBalance
StatusBadge       FilterBar         DateRange        AccountPicker
CustomerPicker    VendorPicker      ProductPicker    VoucherPreview
JournalLines      ApprovalTimeline  AuditDrawer      DetailDrawer
CommandBar
```

A feature agent that needs a component that does not exist **requests it from the Design System Agent**; it does not invent a one-off. This is what keeps the product visually coherent and makes later modules fast.

---

## 16. Security gates

Three gates, three different questions.

**PR gate** — *is this change safe?*
```
SAST · dependency vulnerabilities · secret scan
authorization tests · tenant isolation tests
```

**Staging gate** — *is the running system safe?*
```
OWASP ASVS verification · session testing · privilege escalation
IDOR · tenant escape attempts · rate limiting · upload testing · API abuse
```

**Release gate** — *are we allowed to ship?*
```
critical findings = 0
high findings = 0, or explicitly accepted in writing by the Product Owner
backups verified · rollback verified · migrations verified
```

OWASP ASVS is the technical verification baseline. NIST SSDF is the secure-SDLC baseline for the factory itself.

---

## 17. Factory dashboard

The factory reports on itself in two places ([OPERATING_MODEL.md](OPERATING_MODEL.md) §6–§8):

- **[BOARD.md](BOARD.md)** — Now · Next · Blocked (with deadline) · Decisions needed (Product Owner or Council, with date) · Demo ready.
- **`docs/status/YYYY-Www.md`** — one page a week: what changed, what is demoable, next week, at most three decisions, risks.

Metrics, in priority order:

```
API-backed workflows working on staging        ← the primary metric
CI minutes per tier · failed-gate causes · hours waiting for decisions
Invariant suite status (must be green)
```

---

## 18. Delivery sequence

| Stage | Outcome |
|-------|---------|
| Factory setup | Engineering platform |
| Platform | Tenants, auth, RBAC, audit |
| Accounting core | COA, JV, GL, trial balance |
| Banking | Cash, bank, cheques |
| AR / AP | Customers, vendors |
| Inventory | Products, stock, cost |
| Procurement | PO, GRN, purchase |
| Sales | Quotation, sale, return |
| Reports | Financial + operational |
| Compliance | Tax, FBR |
| Migration | Legacy data |
| Pilot | Real business validation |

A high-quality **accounting-core MVP** can move far faster than a conventional team. The **complete ERP** ships incrementally — we do not hold the release for all 100+ screens, and we do not promise the whole thing in weeks.

---

## 19. Related documents

- [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md) — LEVEL 0
- [ARCHITECTURE.md](ARCHITECTURE.md) — LEVEL 1
- [PRD.md](PRD.md) — LEVEL 2
- [INFRASTRUCTURE.md](INFRASTRUCTURE.md) — environments and deployment
- [../AGENTS.md](../AGENTS.md) — agent operating rules
- [adr/](adr/) — decision records
