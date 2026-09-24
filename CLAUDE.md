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
| **1** | [docs/adr/](docs/adr/), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | A new ADR, approved by the Architecture Guardian |
| **2** | [docs/PRD.md](docs/PRD.md), [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | Product Owner approval |
| **3** | Implementation inside your task contract | Freely, within boundaries |

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

## Task contracts

Every task states `ALLOWED` / `READ ONLY` / `FORBIDDEN` paths. Write only inside `ALLOWED`.

If the correct fix is outside your boundary: **stop and report it**. Do not expand scope, do not "also quickly fix" the adjacent thing, do not leave a compensating workaround inside your boundary.

No task contract? Ask for one before starting.

---

## Before reporting done

```
type check · lint · unit · integration · FinancialInvariantSuite
tenant isolation tested adversarially · RBAC tested · audit asserted
OpenAPI updated · UI states handled · no secrets · stayed in ALLOWED
```

"The page looks right" is not done.

Report as: `DONE · FILES · TESTS · DECISIONS · BLOCKED · OBSERVED`.
`OBSERVED` = problems found outside your scope that you correctly did **not** fix.

---

## Stop and ask when

An invariant appears violated by existing code · your task seems to need a change to the kernels, permission model, tenancy model or a released migration · a financial acceptance criterion is ambiguous · a tax rule isn't written down · you need access you don't have · two docs contradict each other.

Asking costs one message. Guessing wrong about accounting costs a restatement.

---

## Documents

| | |
|---|---|
| [AGENTS.md](AGENTS.md) | Agent operating rules, anti-patterns, DoD |
| [docs/NON_NEGOTIABLES.md](docs/NON_NEGOTIABLES.md) | The 22 invariants + FinancialInvariantSuite |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Structure, kernels, tenancy, dependency rules |
| [docs/PRD.md](docs/PRD.md) | Scope, personas, MVP, out-of-scope |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | Waves, task contracts, DoR/DoD, gates |
| [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) | Environments, deployment, backups, DB roles |
| [docs/design-system/](docs/design-system/) | The Financial UI Kit — tokens, components, page archetypes, and [one document per page](docs/design-system/pages/) |
| [docs/adr/](docs/adr/) | Frozen decisions |
| [.claude/agents/](.claude/agents/) | The ten specialist agents |

---

## Current state

**Wave 0 — the factory foundation — is built.** Thirteen workspaces, four migrations, a staging environment that deploys automatically from `develop`, and a gate of 714 tests. ADR-0013, 0014, 0016 and 0019 are Accepted; ADR-0010 is superseded by 0019.

**No feature exists yet, and both kernels are `export {}`.** Nothing can post a journal entry, move stock or raise an invoice. Wave 1 is Platform — authentication, tenancy, RBAC, audit chain.

Two things worth knowing before you start:

- **[GAP-001](docs/COMPLIANCE_GAPS.md) is open.** Branch protection is unavailable on this plan, so a failing check cannot block a merge. Every gate runs and reports; nothing enforces the result. It is accepted for foundation and staging only — **production is blocked** until merge protection is enabled *and* a deliberately failing secret scan is proven to block a merge.
- **[docs/WAVE_0_REGISTER.md](docs/WAVE_0_REGISTER.md)** is the contract-by-contract record, including what is deferred and why. A deferral there is a decision with a signature, not a gap someone forgot.

Build the factory before building features — and the factory is now the thing you are building on, not the thing you are building.
