---
name: delivery-brief
description: Write or check the one-page FinSoft delivery brief every task needs before code is written — outcome, scope, ALLOWED / FORBIDDEN paths, behaviour, risk tier, acceptance checks and owner. Use when starting work that has no brief, when delegating to a specialist agent, when deciding the risk tier (T0–T3) and therefore the gate, or when deciding whether a fix belongs inside your Paths.
---

# Delivery briefs

Governed by [ADR-0024](../../../docs/adr/ADR-0024-operating-model.md); tiers and gates in
[OPERATING_MODEL.md](../../../docs/OPERATING_MODEL.md) §4. **No brief, no start** — but a
brief is one page and takes minutes. Write it before the first edit.

## The template

```
ID & TITLE    M3-002 · Post a service invoice
OUTCOME       one sentence, in the user's terms — what they can do afterwards
SCOPE         in:  …
              out: …   (name the tempting adjacent thing)
PATHS         ALLOWED   modules/sales/**, tests/integration/sales/**
              FORBIDDEN packages/accounting-kernel/**, database/migrations/**
BEHAVIOUR     endpoints, shapes, errors, UI states — or "none"
TIER          T0 | T1 | T2 | T3  →  the gate it runs
ACCEPTANCE    3–8 checks, each testable
OWNER         agent role · Council seat if T2/T3
```

## Deciding the tier

Take the **highest** tier any changed path reaches. Every tier also runs secret scanning and
the FinancialInvariantSuite on the PR — LEVEL 0 requires both on every PR.

| Tier | If the change touches | Gate |
|---|---|---|
| T0 | docs, copy, prototype UI, mocks | static + secrets + affected unit tests (+ web build) |
| T1 | normal UI/API behaviour | T0 + affected unit/API tests + one Playwright journey |
| T2 | auth, permissions, tenancy, migrations, `database/`, infra, CI | T1 + DB stack + schema/security/integration suites + Council seat |
| T3 | posting, money, inventory, tax, periods, kernels, `packages/validation` | T2 + full financial gate + Accounting seat |

Unsure between two tiers? Take the higher one. A brief that under-tiers a posting change is
the one way this model can let a financial defect through a PR.

## Drawing the Paths

- **ALLOWED** is the smallest set of paths that can contain a correct fix. A whole package
  usually means the change has not been thought through.
- **FORBIDDEN** names what a reasonable person might drift into: the kernels, migrations,
  the permission and tenancy models, Accepted ADRs.
- Everything else is readable. Being able to read the kernel is not permission to change it.
- Module boundaries ([ARCHITECTURE.md](../../../docs/ARCHITECTURE.md)) apply at every tier.

**If the correct fix is outside ALLOWED: stop and report it.** Do not expand scope, do not
"also quickly fix" the adjacent thing, and never leave a compensating workaround inside your
Paths — that hides the real bug and adds a second one. Report it under `OBSERVED`.

## Who to ask

A technical question — kernel, schema, permission model, tenancy, a released migration, two
docs contradicting — goes to the **Council seat** that owns it. The Product Owner is asked
only for business rules: an unwritten tax rule, an ambiguous business acceptance criterion,
or a change to scope, cost, date or compliance exposure — as two options with impact.

## Delegating with a brief

The brief goes in the prompt, plus:

1. Enough context to act without re-deriving it — what exists, what was decided and why.
2. The traps you already know about.
3. What to do on a blocker: report it, do not work around it.
4. The report format: `DONE · FILES · TESTS · DECISIONS · BLOCKED · OBSERVED`.

Say plainly: never weaken a test, add a rounding tolerance, disable a check or tune a
threshold to reach green. A failing test that caught a real defect is a success.

## Checking a brief you were handed

Can every acceptance check be met inside ALLOWED? Is the tier right for the paths? If not,
say so now — one message, not a discarded branch.
