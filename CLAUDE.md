# CLAUDE.md — FinSoft ERP

Multi-tenant double-entry accounting + distribution ERP. Next.js · NestJS · PostgreSQL · Redis · Docker, as a **modular monolith**.

This project is built by a controlled software factory, not by ad-hoc sessions. **Read [AGENTS.md](AGENTS.md) before writing code.**

---

## The one rule that generates the others

> Be aggressive about producing code. Be conservative about changing truth.

Truth = accounting rules · ledger balances · stock quantities · cost values · tenant ownership · authorization · audit history · fiscal periods · compliance.

These numbers get filed with the FBR and used to decide whether a real business is solvent. A posting bug is a financial misstatement, not a defect.

---

## Authority levels — never inverted

| Level | Source | To change it |
|-------|--------|--------------|
| **0** | [docs/NON_NEGOTIABLES.md](docs/NON_NEGOTIABLES.md) | Never. Not for a deadline, not for a green build. |
| **1** | [docs/adr/](docs/adr/), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/OPERATING_MODEL.md](docs/OPERATING_MODEL.md) | A new ADR, approved by the Architecture seat of the Technical Council (+ Accounting where it touches money) |
| **2** | [docs/PRD.md](docs/PRD.md) scope | Product Owner approval |
| **2** | [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) process | Technical Council ([ADR-0024](docs/adr/ADR-0024-operating-model.md)) |
| **3** | Implementation inside your delivery brief | Freely, within boundaries |

Code you generated does not become architecture by surviving a few merges.

---

## Hard rules (full list in [AGENTS.md](AGENTS.md))

- Posted records are **immutable**. Correct by reversal + re-entry, never by `UPDATE`.
- **No hard deletes** of financial or operational records. Ever.
- Money is `numeric` in PostgreSQL and a **decimal library** in TypeScript. Never float, never JS `number` arithmetic.
- `tenant_id` on every tenant-owned row, enforced at JWT → context → repository → **PostgreSQL RLS**. Tenant never comes from the request body or a header.
- Modules **never** construct journal lines. They raise a financial event: `postingEngine.post({ event, ... }, tx)`.
- Modules **never** write `stock_movements`. They call `inventoryKernel.postMovement({ ... }, tx)`.
- Closed fiscal periods reject postings — including from jobs, imports and admin scripts. No system bypass.
- Posting is **idempotent**. Three identical requests produce one journal entry.
- Every financial mutation writes an **append-only audit record** in the same transaction.
- Document numbers come from the server/database. Never `MAX(id)+1`.
- Never disable a test, add a rounding tolerance, or swallow a posting error to get to green.
- **AI never autonomously posts a financial transaction.** Suggest, don't execute.

---

## Boundaries

```
apps/web ─────► packages/ui, shared-types, validation     (no business rules)
modules/* ────► accounting-kernel, inventory-kernel
kernels ──────► database, validation, shared-types         (and nothing else)
```

- Kernels know nothing about feature modules, HTTP or UI.
- Modules never import each other's internals or write to each other's tables.
- Enforced by `dependency-cruiser` in CI, not by good intentions.

Module layers: `api → application → domain`, `infrastructure → domain`. `domain` is pure TypeScript — no NestJS, no ORM, no HTTP.

---

## Delivery briefs

Every task has a one-page brief: outcome, scope, Paths (`ALLOWED` / `FORBIDDEN`), behaviour, risk tier, acceptance checks, owner. Write only inside `ALLOWED` — **Paths are binding at every tier.**

If the correct fix is outside your Paths: **stop and report it**. Do not expand scope, do not "also quickly fix" the adjacent thing, do not leave a compensating workaround inside your boundary.

No brief? Write one with the `delivery-brief` skill before the first edit. Tiers, roles and the Council: [docs/OPERATING_MODEL.md](docs/OPERATING_MODEL.md).

**No new mock-only business screens** until the MVP slice (M1–M4) works. Existing mock screens are prototypes, not delivered functionality.

---

## Before reporting done — by tier (highest tier touched wins)

```
all   type check · lint · format · depcruise · secret scan · FinancialInvariantSuite (LEVEL 0: every PR) · stayed in ALLOWED
T0    docs, copy, prototype UI   → affected unit tests · web build if web changed
T1    normal UI/API behaviour    → + affected API tests · one Playwright journey · UI states handled · OpenAPI updated
T2    auth, tenancy, migrations  → + schema · adversarial tenant isolation · RBAC · integration · Council seat review
T3    posting, money, stock, tax → + golden scenarios · reconciliation · audit asserted · Accounting seat review
```

"The page looks right" is not done.

Report as: `DONE · FILES · TESTS · DECISIONS · BLOCKED · OBSERVED`.
`OBSERVED` = problems found outside your scope that you correctly did **not** fix.

---

## Stop and ask when

**Ask the Council seat that owns it** when: an invariant appears violated by existing code · your task seems to need a change to the kernels, permission model, tenancy model or a released migration · a financial acceptance criterion is ambiguous · you need access you don't have · two docs contradict each other.

**Ask the Product Owner** only for business rules: a tax rule isn't written down · a business acceptance criterion is ambiguous · the work changes scope, cost, delivery date or compliance exposure. Present it as two options with impact.

Asking costs one message. Guessing wrong about accounting costs a restatement.

---

## Documents

| | |
|---|---|
| [AGENTS.md](AGENTS.md) | Agent operating rules, anti-patterns, DoD |
| [docs/NON_NEGOTIABLES.md](docs/NON_NEGOTIABLES.md) | The 22 invariants + FinancialInvariantSuite |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Structure, kernels, tenancy, dependency rules |
| [docs/PRD.md](docs/PRD.md) | Scope, personas, MVP, out-of-scope |
| [docs/OPERATING_MODEL.md](docs/OPERATING_MODEL.md) | Roles, Technical Council, risk tiers, delivery brief, board, metrics |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | Waves, MVP slice, pipeline by tier, DoR/DoD, gates |
| [docs/BOARD.md](docs/BOARD.md) | Now · Next · Blocked · Decisions needed · Demo ready |
| [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) | Environments, deployment, backups, DB roles |
| [docs/design-system/](docs/design-system/) | The Financial UI Kit — tokens, components, page archetypes, and [one document per page](docs/design-system/pages/) |
| [docs/adr/](docs/adr/) | Frozen decisions |
| [.claude/agents/](.claude/agents/) | The ten specialist agents |

---

## Current state

**Wave 0 — the factory foundation — is built.** Workspaces, migrations 001–005, a staging environment that deploys automatically from `develop`, and a full test gate.

**No feature exists yet, and both kernels are `export {}`.** Nothing can post a journal entry, move stock or raise an invoice. The screens in `apps/web` are mock-backed prototypes.

**Now: the MVP slice, M1–M4, before Waves 3–10** ([ADR-0024](docs/adr/ADR-0024-operating-model.md), [IMPLEMENTATION.md §13](docs/IMPLEMENTATION.md)). One journey — login → customer → service invoice → payment → journal → customer ledger → trial balance → reversal → audit trail — working on staging for two tenants. Track it on [docs/BOARD.md](docs/BOARD.md).

Worth knowing before you start:

- **Production is blocked by two open gaps** in [docs/COMPLIANCE_GAPS.md](docs/COMPLIANCE_GAPS.md). **GAP-001:** branch protection is unavailable, so a failing check cannot block a merge — production waits for merge protection *and* a deliberately failing secret scan proven to block a merge. **GAP-003:** MFA is deferred to pre-production — production waits for TOTP, recovery codes and step-up.
- **[docs/WAVE_0_REGISTER.md](docs/WAVE_0_REGISTER.md)** and **[docs/WAVE_1_REGISTER.md](docs/WAVE_1_REGISTER.md)** are history: what was built, what was deferred and why. Open technical signatures there now belong to the Technical Council.
