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
17. **Never make unrelated refactors.** Stay inside your delivery brief's `ALLOWED` paths.
18. **Never merge your own PR.**
19. **Never deploy yourself to production.**
20. **Stop and flag any financial invariant violation** you discover. Do not work around it.

---

## Your delivery brief

Every task you receive has a one-page brief ([ADR-0024](docs/adr/ADR-0024-operating-model.md), [OPERATING_MODEL.md](docs/OPERATING_MODEL.md) §5):

```
ID & TITLE    M2-004 · Trial balance endpoint
OUTCOME       an accountant sees a balanced trial balance for any open period
SCOPE         in: TB query + endpoint     out: P&L, export
PATHS         ALLOWED   modules/ledger/**, tests/integration/ledger/**
              FORBIDDEN packages/accounting-kernel/**, database/migrations/**
BEHAVIOUR     GET /v1/ledger/trial-balance?period=… → 200 | 403 | 404
TIER          T3 → full financial gate + Accounting seat
ACCEPTANCE    3–8 testable checks
OWNER         backend-engineer · Accounting seat
```

- `ALLOWED` is the **only** place you may write. Everything else you may read and must not modify.
- `FORBIDDEN` names what you might drift into. Do not touch it, even to "quickly fix" something.
- The **tier** decides your gate. Highest tier touched wins; unsure, take the higher one.

**If your task requires changing something outside `ALLOWED`, stop and report it.** Say what you need, why, and which file. Do not expand your own scope. Do not leave a workaround in `ALLOWED` that compensates for a problem outside it.

If you were given no brief, write one with the `delivery-brief` skill before your first edit.

---

## Where the rules live

| Document | Authority | What it governs |
|----------|-----------|-----------------|
| [docs/NON_NEGOTIABLES.md](docs/NON_NEGOTIABLES.md) | **LEVEL 0** | Financial invariants. Never overridable. |
| [docs/adr/](docs/adr/) | LEVEL 1 | Architecture decisions. Change requires a new ADR. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | LEVEL 1 | Structure, boundaries, dependency rules. |
| [docs/PRD.md](docs/PRD.md) | LEVEL 2 | Product scope. |
| [docs/OPERATING_MODEL.md](docs/OPERATING_MODEL.md) | LEVEL 1 | Roles, Technical Council, risk tiers, briefs, board. [ADR-0024](docs/adr/ADR-0024-operating-model.md). |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | LEVEL 1–2 | Pipeline by tier, DoR, DoD, gates, MVP slice, waves. |
| [docs/design-system/](docs/design-system/) | LEVEL 2 | UI tokens, components, page archetypes, and the per-page contracts in [pages/](docs/design-system/pages/). Any UI task reads its page document first. |
| Your delivery brief | LEVEL 3 | What you may touch today. |

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

Do not report a task complete until everything for your tier holds. Tiers are cumulative; the highest tier your change touches applies.

```
ALL TIERS
☐ Acceptance checks in the brief met
☐ Type check · lint · format · depcruise pass
☐ Secret scan and FinancialInvariantSuite pass (LEVEL 0 — every PR, every tier)
☐ No secrets, no TODOs hiding incomplete work
☐ Stayed inside ALLOWED paths

T0  docs, copy, prototype UI
☐ Affected unit tests pass · web build passes if web changed

T1  normal UI/API behaviour
☐ Affected unit and API tests pass · one relevant Playwright journey passes
☐ API documented (OpenAPI) · UI states handled: empty, loading, error, partial, success
☐ RBAC tested (missing permission → 403, not 500, not 200)
☐ Structured logging for business events

T2  auth, permissions, tenancy, migrations, infra, CI
☐ Schema, security and integration suites pass on the DB stack (`npm run check:full`)
☐ Tenant isolation tested adversarially (tenant B cannot reach tenant A)
☐ Migration reviewed and safe (if any) · named Council seat reviewed

T3  posting, money, inventory, tax, periods
☐ Golden scenarios · reconciliation · accounting suite pass
☐ Audit records asserted in tests · Accounting seat reviewed
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

Stop — do not improvise — and ask **the Council seat that owns it** if:

- An invariant in NON_NEGOTIABLES.md appears to be violated by existing code. *(Accounting seat)*
- Your task seems to require changing the accounting kernel, the inventory kernel, the permission model, the tenancy model, or a released migration. *(the owning seat)*
- The acceptance criteria are ambiguous about a financial outcome. *(Accounting seat)*
- You need a credential, production data, or access you do not have. *(Database/Security seat)*
- The correct fix is outside your `ALLOWED` paths. *(the orchestrator, who reissues the brief)*
- Two documents in `docs/` contradict each other. *(Architecture seat)*

Ask **the Product Owner** only for business rules — a tax, statutory or compliance rule not written down anywhere; an ambiguous business acceptance criterion; or anything that changes scope, cost, delivery date or compliance exposure. The ask is two options with impact ([OPERATING_MODEL.md](docs/OPERATING_MODEL.md) §3).

Asking costs one message. Guessing wrong about accounting costs a restatement.

---

## Specialist agents

Defined in [`.claude/agents/`](.claude/agents/) and invocable as Claude Code subagents:

| Agent | Role |
|-------|------|
| `architecture-guardian` | **Council — Architecture seat.** Module boundaries, dependency rules, interfaces, ADRs. Can reject within its domain. |
| `accounting-guardian` | **Council — Accounting seat.** COA, posting rules, ledgers, periods, reversal, costing, tax treatment. Reviews anything that moves money; can reject within its domain. |
| `database-guardian` | **Council — Database/Security seat.** Schema, constraints, indexes, migrations, RLS, query plans. Can reject within its domain. |
| `security-guardian` | **Council — Database/Security seat.** Threat model, auth, RBAC, secrets, dependencies, ASVS. Can reject within its domain; can block a release. |
| `backend-engineer` | NestJS modules, domain services, APIs, transactions. |
| `frontend-engineer` | Next.js, forms, tables, workflow UI, accessibility. |
| `design-system` | The Financial UI Kit. Delegated owner of tokens, components and archetypes. |
| `qa-engineer` | Acceptance criteria, test cases, regression, Playwright, edge cases. |
| `devops-guardian` | Delegated owner of Docker, CI/CD, environments, backups, monitoring, rollback. |
| `migration-agent` | Legacy extraction, import, cleanup, reconciliation. |

A seat's rejection stands within its domain. Disputes go to the Technical Council, and reach the Product Owner only under [ADR-0024](docs/adr/ADR-0024-operating-model.md)'s escalation criteria.

The **Factory Orchestrator** is the main session: it writes briefs, assigns, tracks [docs/BOARD.md](docs/BOARD.md) and coordinates integration. It does not write most production code.
