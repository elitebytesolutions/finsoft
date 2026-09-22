# IMPLEMENTATION PLAN — The Software Factory

**Status:** Factory Constitution v1
**Authority:** LEVEL 2 for sequencing; the gates and policies in §6–§10 are LEVEL 1 and require an ADR to change.

This document describes **how work gets done** — how it is decomposed, assigned, bounded, reviewed and released. It is the operating manual for the factory.

---

## 1. The factory

We are not opening fifteen coding sessions and letting them work independently. We are running a controlled factory with ownership boundaries.

```
                         PRODUCT OWNER (human)
                                │
                                ▼
                    ┌──────────────────────┐
                    │ FACTORY ORCHESTRATOR │   ← the main Claude Code session
                    └──────────┬───────────┘
                               │
             ┌─────────────────┼─────────────────┐
             ▼                 ▼                 ▼
      Architecture       Accounting          QA / Security
        Guardian          Guardian             Guardians
             │                 │                 │
             └────────┬────────┴────────┬────────┘
                      ▼                 ▼
               PLATFORM SQUAD      DOMAIN SQUADS
            DB / migrations        Finance / GL
            Auth / tenant          Banking
            API framework          Customers / Vendors
            Design system          Inventory
            CI/CD                  Procurement
            Observability          Sales · Reporting · Tax
```

**The orchestrator does not write most production code.** Its job is: decompose work into safe tasks, assign ownership, prevent collisions, verify acceptance criteria, track dependencies, and coordinate integration. That distinction is what keeps the repository coherent.

Agent definitions live in [`.claude/agents/`](../.claude/agents/) and are invocable as Claude Code subagents.

---

## 2. Control hierarchy

```
LEVEL 0   Financial invariants        Cannot be overridden by anyone
LEVEL 1   Architecture policies       Require an ADR to change
LEVEL 2   Product specifications      Require Product Owner approval
LEVEL 3   Agent implementation        Freely optimised within boundaries
```

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

## 5. The task contract

Every task issued to an agent is a contract with explicit boundaries. An agent without a contract does not start.

```
TASK        INV-021
TITLE       Create stock movement entity

ALLOWED     packages/inventory-kernel/src/domain/**
            tests/accounting/inventory/**

READ ONLY   packages/database/**
            packages/accounting-kernel/**
            docs/**

FORBIDDEN   database/migrations/**
            packages/auth/**
            modules/**

DEPENDS ON  DB-014 (stock_movements table)

ACCEPTANCE  - Movement value object with direction, quantity, reason
            - Quantity is decimal, never number
            - tenant_id required and typed
            - Rejects zero and negative quantity
            - Unit tests cover each rejection
            - No import from modules/* or NestJS
```

`ALLOWED` is the only place the agent may write. `FORBIDDEN` is not advisory. An agent that needs to change something outside `ALLOWED` **stops and reports** — it does not "quickly also fix" the adjacent thing.

This is what prevents an agent from casually refactoring the entire application while implementing a list endpoint.

---

## 6. Task size

Do not issue: *"Build inventory."*

Issue:

```
INV-021  Create stock movement entity
INV-022  Create stock movement repository + migration
INV-023  Implement stock-in transaction
INV-024  Implement stock-out transaction with FEFO batch selection
INV-025  Enforce negative-stock policy
INV-026  Implement running balance query
INV-027  Stock movement listing UI
INV-028  Inventory reconciliation invariant tests
```

**Target: one task = one coherent PR.** Agent output quality falls off sharply above that size, and review quality falls off with it.

---

## 7. The feature pipeline

Every feature, without exception, follows the same path:

```
Requirement
   ↓  Domain specification
   ↓  Acceptance criteria
   ↓  Accounting + threat impact assessment
   ↓  Technical design
   ↓  Task decomposition
   ↓  Parallel implementation
   ↓  Unit tests
   ↓  Integration tests
   ↓  Peer agent review
   ↓  Domain guardian review
   ↓  QA
   ↓  Staging
   ↓  UAT
   ↓  Production
```

An agent never goes from *"user wants cheque management"* directly to *"write 8,000 lines"*. There is always an intermediate specification, and that specification is where the accounting impact gets decided.

### Board states

```
SPEC → READY → IN DEVELOPMENT → IN REVIEW → IN QA → STAGING → ACCEPTED → RELEASED
```

**Agents may not start a task in `SPEC`.** Moving `SPEC → READY` is the orchestrator's decision and requires the Definition of Ready.

---

## 8. Definition of Ready

A task cannot enter `READY` — and therefore cannot be started — without all of:

```
☐ Business purpose
☐ User story
☐ Acceptance criteria (testable, not aspirational)
☐ Domain rules that apply
☐ Permissions required
☐ Affected entities and tables
☐ API behaviour (endpoints, shapes, errors)
☐ UI states (empty, loading, error, partial, success)
☐ Error states and messages
☐ Accounting impact  (or explicitly: none)
☐ Inventory impact   (or explicitly: none)
☐ Audit requirement
☐ Test scenarios, including negative and concurrency cases
☐ File ownership boundary (ALLOWED / READ ONLY / FORBIDDEN)
```

This single policy prevents more AI-generated rework than any other rule in this document. "Accounting impact: none" must be *stated*, not left blank — the act of stating it is the check.

---

## 9. Definition of Done

A ticket is not done because the page looks right.

```
☐ Implementation complete against acceptance criteria
☐ Type check passes
☐ Lint passes
☐ Unit tests pass, meaningful coverage of branches
☐ Integration tests pass
☐ FinancialInvariantSuite passes
☐ Tenant isolation tested (adversarial: tenant B cannot reach tenant A)
☐ RBAC tested (missing permission → 403, not 500, not 200)
☐ Audit records asserted in tests
☐ Domain invariants tested
☐ API documented (OpenAPI)
☐ Migration reviewed and safe (forward, backward-compatible first)
☐ UI states handled
☐ Error states handled and user-comprehensible
☐ Structured logging added for business events
☐ No secrets, no TODOs masking incomplete work
☐ Security scan clean
☐ Review completed by the required reviewers
☐ Verified on staging
```

---

## 10. Review and merge policy

Required checks on every PR:

```
build · typescript · lint · unit · FinancialInvariantSuite
database integration · API integration · Playwright smoke
migration checks · dependency audit · secret scanning · SAST
```

Required reviewers by area:

| Area touched | Required reviewers |
|--------------|-------------------|
| `packages/accounting-kernel/**` | Architecture + Accounting + QA |
| `packages/inventory-kernel/**` | Architecture + Accounting + QA |
| `database/migrations/**` | Database Guardian (+ Accounting if financial tables) |
| `packages/auth/**`, `packages/permissions/**` | Security + Architecture |
| Module domain layer | Architecture (+ Accounting if it posts) |
| Module API layer | Backend peer + Security |
| `packages/ui/**` | Design System Agent |
| `infrastructure/**`, CI | DevOps + Security |
| Everything else | One peer agent |

**An agent never merges its own PR.** A guardian's rejection is final within its domain and is escalated to the Product Owner, not argued around.

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

The factory reports on itself:

```
Backlog · Active agents · Open PRs · CI state · Failed tests
Blocked tasks · Architecture decisions pending · Security findings
Migration status · Module completion · Regression coverage
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
