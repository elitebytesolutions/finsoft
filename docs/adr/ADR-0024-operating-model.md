# ADR-0024: Operating model — risk tiers, a Technical Council, demo-first MVP

**Status:** Proposed
**Date:** 2026-09-27
**Deciders:** Product Owner, Architecture Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Supersedes:** the *process* in [IMPLEMENTATION.md](../IMPLEMENTATION.md) §5–§10 (task contract, single pipeline, single Definition of Ready and Done, one required-check set, guardian rejection escalating to the Product Owner), and the governance aspect of every earlier ADR's `Deciders:` line — **by reference only**. No Accepted ADR body is edited ([README](README.md) rule 4). No decision, constraint or protection in any ADR or in [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) changes.

## Context

The architecture and the financial protections are working: RLS, exact money, reversal-only correction, period locking, idempotency, the audit chain, the kernels. The delivery process around them is not.

- The Product Owner is a Decider on every ADR and is asked to sign technical mechanisms — index shapes, trigger bodies, lint rules — that a business owner cannot evaluate and should not have to.
- Every task needs a full contract and the full gate, so a copy change pays the same process as a posting rule.
- A guardian rejection escalates to the Product Owner, turning technical disagreements into business meetings.
- Foundation-first has run for two waves and nothing user-facing is real. The screens that exist are mock-backed prototypes.

Decided by the Product Owner, 2026-09-27: **keep the architecture and every financial protection; replace the delivery process** with a risk-tiered modular monolith, delegated technical governance and a demo-first MVP.

## Decision

**1. Two owners.** The **Product Owner** owns business priority, user-workflow acceptance, budget, production and compliance risk, release readiness and PRD scope. The **Technical Council** owns every implementation decision.

**2. Council seats.**

| Seat | Held by | Domain |
|---|---|---|
| Architecture | `architecture-guardian` | Boundaries, interfaces, ADRs, cross-cutting concerns |
| Accounting | `accounting-guardian` | Posting rules, tax treatment, reversal, valuation, periods |
| Database/Security | `database-guardian` + `security-guardian` | Migrations, RLS, auth, permissions, secrets |

One seat decides a change inside its domain. A change crossing domains needs every seat it touches. Each guardian keeps the power to **reject within its domain**; no seat overrides another seat's rejection inside that seat's domain. Disputes go to the Council, not to the Product Owner. `design-system` (UI kit) and `devops-guardian` (CI, environments) are delegated owners: they decide within their domain the same way, and their disputes go to the Council.

**3. Escalation to the Product Owner** happens only when a decision materially changes **business scope, cost, compliance exposure** (anything in NON_NEGOTIABLES, [COMPLIANCE_GAPS](../COMPLIANCE_GAPS.md), or production readiness) **or delivery date**. It is presented as **two options with impact**, never as a mechanism to sign.

**4. Timebox.** Every Council decision closes within **2 working days** as *approved*, *rejected*, or *two options with impact*. A seat that cannot approve in time rejects; silence is not approval.

**5. Risk tiers replace the single gate.** The highest tier touched wins. Paths and gates are in [OPERATING_MODEL.md](../OPERATING_MODEL.md) §4. **Every PR, at every tier, runs secret scanning and the FinancialInvariantSuite** — NON_NEGOTIABLES rule 20 and §3 require both on every PR, and a tier cannot waive LEVEL 0.

| Tier | Change | Gate |
|---|---|---|
| T0 | Docs, copy, prototype UI | Static + secrets + affected unit tests (+ web preview build) |
| T1 | Normal UI/API behaviour | T0 + affected unit/API tests + one relevant Playwright journey |
| T2 | Auth, permissions, tenancy, migrations, infra, CI | T1 + DB stack + schema, adversarial security and integration suites + named Council review |
| T3 | Posting, money, inventory, tax, periods | T2 + full financial gate (golden scenarios, reconciliation, accounting suite) + Accounting seat review |

`develop`, release and nightly runs execute everything regardless of tier.

**6. A delivery brief replaces the task contract.** One page: outcome, scope, Paths (ALLOWED / FORBIDDEN — still binding), behaviour, tier, acceptance checks, owner and seat. Template: [delivery-brief skill](../../.claude/skills/delivery-brief/SKILL.md).

**7. Demo-first MVP.** The MVP slice M1–M4 ([IMPLEMENTATION.md](../IMPLEMENTATION.md) §13, [PRD](../PRD.md) §6) is delivered before Waves 3–10 resume. **No new mock-only business screens** until M1–M4 works; existing mock screens are prototypes, not delivered functionality.

**8. Transition.** Every open technical signature moves to the Council:

- ADR-0023, pre-tenant authentication reads (on `feature/W1-002-auth-package`, not yet on `develop`) — the Product Owner slot is withdrawn; the Architecture seat is the remaining signature. The Product Owner's 2026-09-25 decisions it records stay recorded as decisions.
- The D1–D9 deferrals and the reconciliation-scope deferral in [WAVE_0_REGISTER.md](../WAVE_0_REGISTER.md) and [RECONCILIATION-2026-09.md](RECONCILIATION-2026-09.md) — the Architecture seat, with Accounting for D4 and D6.

The only Product Owner signature this reset needs is on this record. **Unchanged:** amending NON_NEGOTIABLES still needs Product Owner + Architecture + Accounting, recorded as an ADR — so [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) keeps its three Deciders. GAP-001, GAP-002 and GAP-003 stay Product Owner items. Release gates keep "high findings = 0 or accepted in writing by the Product Owner".

## Consequences

**Positive.** The Product Owner decides business questions in business terms. Low-risk work stops paying high-risk process. Technical disputes close in days. Delivery is measured by API-backed workflows, not by documents.

**Negative / accepted costs.**

- Guardians are agents; the Council is a set of in-session reviews, not independent people. That was already true of guardian review — the change removes a human checkpoint on *technical* items only. Compliance, scope, cost and release checkpoints keep it.
- Tier classification can be wrong. A misclassified T3 change reviewed as T1 skips the financial gate on its PR. Mitigated by path-based classification, highest-tier-wins, and the full gate on `develop` catching what a PR run missed — after merge, not before.
- T0 is not Docker-free in CI. The tier table as first drafted ran the FinancialInvariantSuite only at T3; NON_NEGOTIABLES §3 requires it on **every PR**, so it runs at every tier, with a Postgres service. `npm run check` stays Docker-free locally; the PR is where the suite is enforced.
- Line citations into IMPLEMENTATION.md (`:247`, `:250`, `:287`) move.

## Compliance

| Rule | Enforced by |
|---|---|
| Tier and gate per PR | `tools/ci/classify.mjs` (OPS-002) maps changed paths to T0–T3 and selects jobs; `develop`/release/nightly run all. **Until OPS-002 merges, tiering is procedural** |
| Named reviewer per tier | `.github/CODEOWNERS` routing comments. Routing only while [GAP-001](../COMPLIANCE_GAPS.md) is open |
| Every task has a brief with a tier | `delivery-brief` skill; DoR in IMPLEMENTATION.md §8; a PR without one is rejected by the Architecture seat |
| Decisions close in 2 days; demo cadence | [BOARD.md](../BOARD.md) "Decisions needed" carries a date; weekly `docs/status/` report counts hours waiting |
| No weakening of protection | NON_NEGOTIABLES byte-identical to its prior revision; the classifier always selects `secrets` and the FinancialInvariantSuite (§3 of NON_NEGOTIABLES: every PR, not nightly); every existing CI job still runs on `develop` |

## Signatures

| Seat | Verdict |
|---|---|
| **Product Owner** | ☐ not recorded |
| **Architecture Guardian** | ✅ **APPROVED, 2026-09-27** — author. See note |

> **Architecture Guardian — author, 2026-09-27.** No module boundary, dependency direction, kernel surface or LEVEL 0 rule changes; this record moves *who decides* and *how much gate each risk tier pays*. Authorship and the Architecture verdict are the same seat — the Product Owner's signature is the independent one, and the status flips on it and not before.
