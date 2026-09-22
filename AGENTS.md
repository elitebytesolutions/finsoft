# AGENTS.md

**Read this before writing any code in this repository.**

This file is the operating agreement for every AI coding agent working on FinSoft. It applies to you regardless of which task you were given, which model you are, or who asked.

---

## What this system is

FinSoft is a **multi-tenant double-entry accounting and distribution ERP** for a real trading business. The numbers it produces get filed with the FBR, paid tax on, and used to decide whether the business is solvent.

A rendering bug is an inconvenience. A posting bug is a financial misstatement that may be found months later, after hundreds of transactions have been built on top of it.

> **Be aggressive about producing code. Be conservative about changing truth.**

Truth means: accounting rules, ledger balances, stock quantities, cost values, tenant ownership, authorization, audit history, fiscal periods, compliance.

---

## The twenty rules

1. **Never change accounting rules** without explicit task scope and Accounting Guardian approval.
2. **Never modify posted financial data.** Posted is frozen. Correct by reversal.
3. **Never use float for currency.** `numeric` in the database, a decimal library in TypeScript.
4. **Never disable a test to make CI pass.** A red test is information, not an obstacle.
5. **Never remove validation to fix a bug.** The validation is usually right and the caller is wrong.
6. **Never create a schema migration** without Database Guardian review.
7. **Never access production secrets** or production data. You have local and CI only.
8. **Never write directly to another module's tables.** Call its interface or the kernel.
9. **Never bypass authorization.** Every endpoint declares and checks its permission server-side.
10. **Never expose another tenant's data.** Tenant ID comes from the session, never the request.
11. **Never hard-delete a financial transaction.** Status transitions only.
12. **Never silently catch a posting failure.** A swallowed posting error is corrupted books.
13. **Never auto-correct an accounting imbalance.** Report it. Do not "fix" it.
14. **Never guess tax rules.** Ask. Wrong tax is a legal exposure, not a bug.
15. **Never change an API contract invisibly.** Version it, document it, announce it.
16. **Never add a dependency casually.** New dependencies need justification and a security check.
17. **Never make unrelated refactors.** Stay inside your task contract's `ALLOWED` paths.
18. **Never merge your own PR.**
19. **Never deploy yourself to production.**
20. **Stop and flag any financial invariant violation** you discover. Do not work around it.

---

## Your task contract

Every task you receive has explicit boundaries:

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

DEPENDS ON  DB-014

ACCEPTANCE  - ...
```

- `ALLOWED` is the **only** place you may write.
- `READ ONLY` you may read for context and must not modify.
- `FORBIDDEN` you may not touch, even to "quickly fix" something.

**If your task requires changing something outside `ALLOWED`, stop and report it.** Say what you need, why, and which file. Do not expand your own scope. Do not leave a workaround in `ALLOWED` that compensates for a problem in `FORBIDDEN`.

If you were given no task contract, ask for one before you start.

---

## Where the rules live

| Document | Authority | What it governs |
|----------|-----------|-----------------|
| [docs/NON_NEGOTIABLES.md](docs/NON_NEGOTIABLES.md) | **LEVEL 0** | Financial invariants. Never overridable. |
| [docs/adr/](docs/adr/) | LEVEL 1 | Architecture decisions. Change requires a new ADR. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | LEVEL 1 | Structure, boundaries, dependency rules. |
| [docs/PRD.md](docs/PRD.md) | LEVEL 2 | Product scope. |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | LEVEL 1–2 | Pipeline, DoR, DoD, gates, waves. |
| [docs/design-system/](docs/design-system/) | LEVEL 2 | UI tokens, components, page archetypes, and the per-page contracts in [pages/](docs/design-system/pages/). Any UI task reads its page document first. |
| Your task contract | LEVEL 3 | What you may touch today. |

**Never invert this.** Code you generated does not become architecture by surviving a few merges, and architecture does not become a business rule because it was convenient.

---

## Things agents get wrong here

These are the specific failure modes this codebase is built to prevent. Recognise them in your own output.

### Constructing journal lines yourself

```ts
// WRONG — Sales does not know accounting
await db.insert(journalLines).values([
  { account: '1100', debit: total },
  { account: '4000', credit: total },
]);

// RIGHT — raise the event, let the kernel decide
await postingEngine.post({
  event: FinancialEvent.SALE_POSTED,
  tenantId, referenceType: 'sale', referenceId: sale.id,
  occurredAt: sale.transactionDate,
  idempotencyKey: command.idempotencyKey,
  actor, payload,
}, tx);
```

### Float arithmetic

```ts
// WRONG
const total = qty * price;                 // number × number
const tax = total * 0.17;

// RIGHT
const total = Decimal(qty).times(price);
const tax = total.times('0.17').toDecimalPlaces(4, ROUND_HALF_UP);
```

### Mutating a balance column

```ts
// WRONG — balances are derived, not stored-and-edited
await db.update(products).set({ qtyOnHand: sql`qty_on_hand - ${qty}` });

// RIGHT
await inventoryKernel.postMovement({ direction: 'OUT', quantity, ... }, tx);
```

### Taking tenant from the request

```ts
// WRONG
const tenantId = req.body.tenantId;
const tenantId = req.headers['x-tenant-id'];

// RIGHT
const tenantId = tenantContext.get().tenantId;   // from the signed session
```

### Copying names into transactions

```ts
// WRONG
saleLine.productName = product.name;   // used later for grouping — now it rots

// RIGHT
saleLine.productId = product.id;                    // the relationship
saleLine.productNameSnapshot = product.name;        // printing only, never joined
```

### Making a test pass

```ts
// WRONG
it.skip('trial balance must balance', ...);
expect(diff).toBeLessThan(0.01);        // "rounding tolerance"
try { await post(); } catch {}          // "it's flaky"

// RIGHT
// Stop. Report the invariant violation. It is telling you something true.
```

### Helpful side quests

Renaming things you noticed, tidying an adjacent file, upgrading a dependency, "improving" a query you did not need to touch. Every one of these turns a reviewable 200-line PR into an unreviewable 900-line one, and reviewers stop catching real problems.

Stay in scope. Note the observation in your report instead.

---

## Definition of Done

Do not report a task complete until all of these hold:

```
☐ Acceptance criteria met
☐ Type check passes          ☐ Lint passes
☐ Unit tests pass            ☐ Integration tests pass
☐ FinancialInvariantSuite passes
☐ Tenant isolation tested adversarially (tenant B cannot reach tenant A)
☐ RBAC tested (missing permission → 403, not 500, not 200)
☐ Audit records asserted in tests
☐ API documented (OpenAPI)
☐ Migration reviewed and safe (if any)
☐ UI states handled: empty, loading, error, partial, success
☐ Structured logging for business events
☐ No secrets, no TODOs hiding incomplete work
☐ Stayed inside ALLOWED paths
```

"It works on my machine and the page looks right" is not done.

---

## How to report

When you finish, report:

```
DONE        what you implemented, against which acceptance criteria
FILES       what you changed
TESTS       what you added, what they prove
DECISIONS   any judgement call a reviewer should check
BLOCKED     anything you could not do and why
OBSERVED    problems you found outside your scope and did NOT fix
```

`OBSERVED` is important. It is how out-of-scope problems reach the orchestrator instead of either being silently ignored or silently "fixed".

---

## When to stop and ask

Stop — do not improvise — if:

- An invariant in NON_NEGOTIABLES.md appears to be violated by existing code.
- Your task seems to require changing the accounting kernel, the inventory kernel, the permission model, the tenancy model, or a released migration.
- The acceptance criteria are ambiguous about a financial outcome.
- A tax, statutory or compliance rule is not written down anywhere.
- You need a credential, production data, or access you do not have.
- The correct fix is outside your `ALLOWED` paths.
- Two documents in `docs/` contradict each other.

Asking costs one message. Guessing wrong about accounting costs a restatement.

---

## Specialist agents

Defined in [`.claude/agents/`](.claude/agents/) and invocable as Claude Code subagents:

| Agent | Role |
|-------|------|
| `architecture-guardian` | Module boundaries, dependency rules, ADRs. Can reject changes. |
| `accounting-guardian` | COA, posting rules, ledgers, period close, costing. Reviews anything that moves money. |
| `database-guardian` | Schema, constraints, indexes, migrations, RLS, query plans. |
| `backend-engineer` | NestJS modules, domain services, APIs, transactions. |
| `frontend-engineer` | Next.js, forms, tables, workflow UI, accessibility. |
| `design-system` | The Financial UI Kit. Owns reusable patterns. |
| `qa-engineer` | Acceptance criteria, test cases, regression, Playwright, edge cases. |
| `security-guardian` | Threat model, auth, RBAC, RLS, secrets, dependencies, ASVS. |
| `devops-guardian` | Docker, CI/CD, environments, backups, monitoring, rollback. |
| `migration-agent` | Legacy extraction, import, cleanup, reconciliation. |

The **Factory Orchestrator** is the main session: it decomposes, assigns, tracks dependencies and coordinates integration. It does not write most production code.
