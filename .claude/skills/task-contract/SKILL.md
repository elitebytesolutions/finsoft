---
name: task-contract
description: Write or check a FinSoft task contract — the ALLOWED / READ ONLY / FORBIDDEN path boundary, acceptance criteria and definition of done that every task needs before code is written. Use when starting work that has no contract, when delegating to a specialist agent, when scope is ambiguous, or when deciding whether a fix belongs inside your boundary.
---

# Task contracts

`CLAUDE.md`: **no task contract, no start.** The contract is what stops a session from
wandering out of its lane and quietly becoming the architecture.

A contract is cheap to write and expensive to omit. Write it before the first edit.

## The shape

```markdown
## Task: <one line, in the user's terms>

**Why**: the outcome someone actually wants. Not "refactor X" — what breaks if we don't.

**ALLOWED** (write here)
- apps/web/src/screens/voucher-register.tsx
- apps/web/app/vouchers/page.tsx

**READ ONLY** (understand, never edit)
- packages/ui/**
- docs/design-system/pages/voucher-register/**
- ui-prototype/**

**FORBIDDEN** (not yours, at all)
- packages/accounting-kernel/**
- database/migrations/**
- anything under modules/*/domain/

**Acceptance**
- [ ] specific, checkable, and written before the code
- [ ] each one falsifiable — "the filter bar persists across navigation", not "works well"

**Done means**
type check · lint · unit · integration · FinancialInvariantSuite ·
tenant isolation tested adversarially · RBAC tested · audit asserted ·
OpenAPI updated · UI states handled · no secrets · stayed in ALLOWED
```

## Drawing the boundary

Start from the change and widen only as far as the work genuinely reaches.

- **ALLOWED** is the smallest set of paths that can contain a correct fix. If it lists a
  whole package, you have probably not thought hard enough about the change.
- **READ ONLY** is everything you need to understand: the page document, the kit, the
  ADRs, the prototype. Being able to read the kernel is not permission to change it.
- **FORBIDDEN** is explicit for anything a reasonable person might drift into. The
  kernels, migrations, the permission model, the tenancy model and released ADRs belong
  here on nearly every frontend or module task.

## The rule that makes contracts work

> If the correct fix is outside your boundary: **stop and report it.**

Do not expand scope. Do not "also quickly fix" the adjacent thing. Do not leave a
compensating workaround inside your boundary to route around a defect outside it — that
is the worst option of the three, because it hides the real bug and adds a second one.

Report it under `OBSERVED`. That is what the section is for: problems found outside your
scope that you correctly did **not** fix.

## Stop and ask when

From `CLAUDE.md` — any one of these ends the task and starts a message:

- an invariant appears violated by existing code
- the work seems to need a change to the kernels, permission model, tenancy model, or a
  released migration
- a financial acceptance criterion is ambiguous
- a tax rule is not written down anywhere
- you need access you do not have
- two documents contradict each other

Asking costs one message. Guessing wrong about accounting costs a restatement.

## Delegating with a contract

When handing work to a specialist agent, the contract goes in the prompt. Include:

1. Enough context to act without re-deriving it — what exists, what runs where, what was
   already decided and why.
2. The three path lists, explicitly.
3. The traps you already know about. An agent that rediscovers a trap you could have named
   has spent your tokens to learn what you knew.
4. What to do on a blocker: report it, do not work around it.
5. The report format: `DONE · FILES · TESTS · DECISIONS · BLOCKED · OBSERVED`.

Tell the agent plainly not to weaken a test, add a rounding tolerance, disable a check or
tune a threshold to reach green — and that a failing test which caught a real defect is a
successful outcome, not a task it failed.

## Checking a contract you were handed

Before starting, confirm: can the acceptance criteria actually be met inside ALLOWED? If
not, say so now rather than halfway through. A contract whose criteria require edits
outside its own boundary is a broken contract, and discovering that early costs one
message instead of a discarded branch.
