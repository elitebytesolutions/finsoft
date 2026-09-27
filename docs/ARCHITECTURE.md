# ARCHITECTURE

**Status:** FROZEN for v1 — Factory Constitution v1
**Authority:** LEVEL 1. Changing anything in this document requires a new ADR approved by the Architecture Guardian. An agent may not reverse a decision here because an alternative was more convenient mid-ticket.

---

## 1. Shape of the system

FinSoft v1 is a **modular monolith**, not microservices.

```
                         Next.js (apps/web)
                                │
                                ▼
                        NestJS API (apps/api)
                                │
    ┌───────────┬───────────┬───┴───────┬───────────┬───────────┐
    │           │           │           │           │           │
 Identity    Tenants     Masters    Accounting   Banking     Audit
                                     Kernel
    │           │           │           │           │           │
 Customers   Vendors    Inventory  Procurement   Sales        Tax
                          Kernel
                                │
                                ▼
                          PostgreSQL
                                │
        ┌───────────┬───────────┼───────────┬───────────┐
        │           │           │           │           │
   operational   journal    stock ledger  audit log   outbox
      tables     ledger

        Redis                         Worker (apps/worker)
     caching / queues / locks    reports · PDFs · emails · imports
                                 exports · scheduled jobs

        Object storage
     invoices · attachments · reports · imports
```

### Why a monolith

A single sale must atomically produce:

```
Sale → stock movement → COGS → revenue → tax → receivable/cash → journal entry → audit record
```

All-or-nothing. A PostgreSQL transaction gives us that for free. A distributed transaction across six services does not, and every workaround (sagas, compensating transactions, eventual consistency) is a way of saying "the books may be wrong for a while" — which [NON_NEGOTIABLES](NON_NEGOTIABLES.md) forbids.

### What may become a service later

Only things that are **not** inside the posting transaction:

```
notifications · document generation (PDF) · analytics / OLAP
external integrations (FBR POS, SMS, email) · file processing
```

These are already separated behind the outbox and the worker, so extracting them later is a deployment change, not a rewrite.

---

## 2. Repository layout

```
finsoft/
│
├── apps/
│   ├── web/                 Next.js — UI only, no business rules
│   ├── api/                 NestJS — HTTP, auth, module wiring
│   └── worker/              Background jobs, queue consumers
│
├── packages/
│   ├── accounting-kernel/   Posting engine. The heart of the system.
│   ├── inventory-kernel/    Movement ledger + valuation
│   ├── auth/                Authentication primitives, session, JWT
│   ├── permissions/         Atomic permission catalogue + evaluation
│   ├── database/            Connection, tenant context, repository base, RLS helpers
│   ├── validation/          Shared schemas (zod), money/date/decimal primitives
│   ├── ui/                  Financial UI Kit — design system components
│   ├── reporting/           Report definitions, query builders, exporters
│   ├── observability/       Structured logging, correlation context, redaction (ADR-0016)
│   └── shared-types/        DTOs and contracts shared by web/api/worker
│
├── modules/
│   ├── customers/   vendors/   banking/    cheques/
│   ├── products/    inventory/ procurement/ sales/
│   ├── tax/         hr/        administration/
│   └── ...          Each: domain/ · application/ · infrastructure/ · api/ · ui/
│
├── database/
│   ├── migrations/          Immutable, numbered, forward-only
│   ├── seeds/               Reference data (COA templates, tax codes)
│   ├── fixtures/            Test data
│   └── tests/               Schema, constraint and RLS tests
│
├── tests/
│   ├── accounting/          FinancialInvariantSuite + golden scenarios
│   ├── integration/  e2e/  security/  performance/  reconciliation/
│
├── docs/
│   ├── architecture/  adr/  posting-rules/  requirements/
│   ├── workflows/     permissions/  agent-rules/
│
└── infrastructure/
    ├── docker/  github/  staging/  production/
```

### Module internal structure

Every module in `modules/` follows the same four-layer shape:

```
modules/sales/
├── domain/          Entities, value objects, domain services, invariants.
│                    Pure TypeScript. No NestJS, no ORM, no HTTP.
├── application/     Use cases / command handlers. Orchestrates domain +
│                    kernels + repositories inside a transaction.
├── infrastructure/  Repository implementations, external adapters, mappers.
├── api/             Controllers, DTOs, guards, OpenAPI decorators.
└── ui/              Route segments and components (re-exported to apps/web).
```

The dependency direction inside a module is strictly inward: `api → application → domain`, `infrastructure → domain`. `domain` imports nothing from the other three.

---

## 3. The accounting kernel

`packages/accounting-kernel` is the single implementation of accounting behaviour in the entire system. No module invents journal rows.

### Responsibilities

```
Posting Engine        Journal Validation    Account Resolution
Period Validation     Currency / Precision  Reversal Engine
Number Generation     Posting Rules         Idempotency
Audit Context         Financial Events
```

### The only way to post

Feature modules do **not** construct journal lines. They raise a financial event:

```ts
await postingEngine.post({
  event: FinancialEvent.SALE_POSTED,
  tenantId,
  referenceType: 'sale',
  referenceId: sale.id,
  occurredAt: sale.transactionDate,
  idempotencyKey: command.idempotencyKey,
  actor,
  payload: { /* typed, event-specific facts — amounts, party, lines */ },
}, tx);
```

The kernel resolves accounts, validates the period, builds balanced lines, assigns the document number, writes the audit record, and enforces idempotency — all inside the caller's transaction `tx`.

### Financial events

```
SALE_POSTED                  PURCHASE_RECEIVED
SALE_RETURNED                PURCHASE_RETURNED
CUSTOMER_PAYMENT_RECEIVED    SUPPLIER_PAYMENT_MADE
CHEQUE_ISSUED                CHEQUE_RECEIVED
CHEQUE_CLEARED               CHEQUE_DISHONOURED
STOCK_WRITTEN_OFF            STOCK_ADJUSTED
EXPENSE_RECORDED             JOURNAL_VOUCHER_POSTED
OPENING_BALANCE_LOADED       PERIOD_CLOSED
```

Each event maps to a declarative posting rule in `docs/posting-rules/`, reviewed by the Accounting Guardian, and implemented once.

Example — a cash sale of Rs 10,000 with COGS of Rs 7,000:

```
Dr Cash                        10,000
    Cr Sales Revenue                    10,000

Dr Cost of Goods Sold           7,000
    Cr Inventory                         7,000
```

Adding a new event, or changing an existing mapping, is an Accounting Guardian decision — never a side effect of a feature ticket.

---

## 4. The inventory kernel

`packages/inventory-kernel` mirrors the accounting kernel's philosophy. No module writes to `stock_movements` directly.

```ts
await inventoryKernel.postMovement({
  tenantId, productId, locationId, batchId,
  direction: 'OUT', quantity, reason: 'SALE',
  referenceType: 'sale', referenceId, occurredAt, actor,
}, tx);
```

The kernel owns: quantity ledger, batch/expiry selection (FEFO), weighted-average valuation, negative-stock policy, and the cost figure that the accounting kernel consumes for COGS.

FEFO (first-expired-first-out) governs **which batch is consumed**. Weighted average governs **what it cost**. These are separate concerns and both are the kernel's.

---

## 5. Dependency rules

Enforced mechanically by `dependency-cruiser` in CI, not by good intentions.

```
apps/web ──────► packages/ui, shared-types, validation
                 (never modules/*/domain, never accounting-kernel)

apps/api ──────► modules/*, packages/*
apps/worker ───► modules/*, packages/*

modules/sales ─────────┐
modules/procurement ───┤
modules/banking ───────┼──► accounting-kernel, inventory-kernel
modules/inventory ─────┘         (kernels never import modules)

packages/accounting-kernel ──► packages/database, validation, shared-types
                               (and NOTHING else)

packages/observability ──► packages/shared-types
                           (and node core — nothing else first-party)

apps/api, apps/worker ─────────┐
modules/*/{api,application,    ├──► packages/observability
           infrastructure}     │
packages/database, auth,       │
  permissions, reporting,      │
  validation ──────────────────┘
```

Hard rules:

- **Who may log, and who may not.** Amended by ADR-0016. The services, the modules outside their domain layer, and the five lower-level packages above may log — through `@finsoft/observability` only, never through `console`. The **kernels**, `modules/*/domain` and `apps/web` may not log at all: the kernels because §5's allow-list is the strongest sentence in this document and a logger would be its first exception; the domain layer because it is pure TypeScript that returns a result or throws, and the caller decides what is worth a line; `apps/web` because a server logger in a browser writes to a console nobody reads.

  Enforced in both directions — `observability-imports-almost-nothing` for what the logger may import, `observability-importers-are-allowlisted` for who may import it. The second exists because `packages/database` became the first importer while nothing constrained the inbound side, and an edge that is legal only because nobody wrote a rule is the same posture that let a dead `exclude` pattern survive two reviews.

  **Note what this does not say.** `packages/database` may log, and a kernel may import `packages/database`, so a kernel will transitively link against the logger once the kernels have any content. That is accepted: "and NOTHING else" has always been a statement about **direct** edges enforced by a direct-edge allow-list, and `packages/database` already carries `pg`, `kysely` and `node:async_hooks` behind it. The containment is that `packages/database`'s public surface re-exports nothing from observability, so `getLogger` is not nameable through the allowed edge.

- **The kernels know nothing about feature modules, HTTP, or UI.** `accounting-kernel` importing from `modules/sales` is a build failure.
- **Modules do not import each other's internals.** `modules/sales` may not import `modules/inventory/domain/*`. Cross-module interaction goes through a published application-layer interface or a domain event.
- **A module never writes to another module's tables.** Sales does not `UPDATE products`. It calls the inventory kernel.
- **`apps/web` contains no business rules.** If the browser is deciding a number, that is a bug.

---

## 6. Multi-tenancy

Shared database, shared schema, `tenant_id` discriminator, with PostgreSQL Row Level Security as the backstop (ADR-0003, ADR-0004).

```
JWT / session               tenant_id is a signed claim
      ↓
NestJS TenantContext        AsyncLocalStorage, set by a global guard
      ↓
Repository layer            every query filtered; base repo makes it default
      ↓
PostgreSQL RLS              policy per table; app role has no BYPASSRLS
```

Implementation shape:

```sql
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON journal_entries
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

`app.tenant_id` is set per transaction by the connection wrapper from the tenant context — never from user-supplied input. **One carve-out, for authentication only: [ADR-0023](adr/ADR-0023-pre-tenant-authentication-reads.md) §1.** `/auth/login` has no tenant context yet — establishing one is what it is for — so it resolves a tenant code from the request against the *global* `tenants` table and sets `app.tenant_id` from the result. That is permitted **only** at the two unauthenticated endpoints that MINT a claim, never at one that consumes it, and only through the single branded resolver ADR-0023 §3 confines to `packages/database`. A wrong code cannot open a tenant the credential does not open: it yields a miss, and a miss is the same 401 as a wrong password. RLS defaults to deny when enabled with no applicable policy, which is the behaviour we want if someone forgets a policy on a new table. A schema test asserts that *every* table carrying `tenant_id` has RLS enabled and forced.

Tenant customisation (custom fields, document layouts, posting-rule variants, numbering formats) is **configuration**, stored per tenant. It is never a forked code path.

---

## 7. Transactions and the outbox

The posting transaction is the unit of correctness:

```
BEGIN
  set app.tenant_id
  validate command + permissions (already done at guard, re-asserted)
  domain operations
  inventoryKernel.postMovement(...)
  postingEngine.post(...)        ← journal + numbering + audit + idempotency
  INSERT INTO outbox (...)       ← side effects, same transaction
COMMIT
```

Anything that can fail independently of the books — email, PDF, FBR push, webhook, cache invalidation — goes into `outbox` inside the transaction and is dispatched by the worker afterwards. Nothing that touches an external system happens inside the posting transaction.

Isolation level: `READ COMMITTED` with explicit row locks (`SELECT ... FOR UPDATE`) on the contended rows — stock balances, numbering counters, account balance caches. Where a whole-entity serialisation is needed, use an advisory lock keyed by `(tenant_id, entity)`.

---

## 8. Permissions

Atomic permissions, not role names, all the way down. Roles are collections of permissions, and roles are per tenant so customisation does not require code.

```
voucher.view      voucher.create    voucher.approve
voucher.post      voucher.reverse

bank.view         bank.create       cheque.receive
cheque.issue      cheque.clear      cheque.dishonour

period.view       period.close      period.reopen

customer.create   customer.credit_override
sale.discount_override    price.override
inventory.adjust  inventory.negative_allow
report.financial  report.export
audit.view        admin.user_manage  admin.role_manage
```

The catalogue lives in `packages/permissions` as the single source of truth and is code-generated into both the API guards and the UI's capability checks. A permission that is not in the catalogue does not exist.

---

## 9. Audit architecture

Separate from application logging, and structurally different from it.

```
audit_log
  id, tenant_id, occurred_at, actor_user_id, action,
  entity_type, entity_id, before_json, after_json,
  ip, request_id, hash, previous_hash
```

- Append-only, enforced by grants (`INSERT` only for the app role) and a trigger.
- Hash-chained per tenant for tamper evidence.
- Written in the same transaction as the change it describes.
- Not reachable by any UPDATE/DELETE path in the application.

This replaces the legacy `MUSER`/`MTIME` last-writer-wins pattern entirely. "Who last touched this row" is not an audit trail.

---

## 10. Observability

Every request carries and propagates:

```
request_id · tenant_id · user_id · session_id
```

Structured JSON logs, correlated end-to-end through the API, the worker, and the outbox dispatch.

Business events logged at `info` with structured fields:

```
SALE_POSTED   JV_REVERSED   CHEQUE_CLEARED   PERIOD_CLOSED
ROLE_CHANGED  STOCK_ADJUSTED  LOGIN_FAILED   EXPORT_CREATED
```

Monitored: HTTP error rate, DB latency, slow queries, failed jobs, login failures, posting failures, reconciliation failures, queue depth, storage, backup status.

**Never logged:** passwords, tokens, session IDs in plaintext, full card/bank credentials, or entire financial payloads where an identifier would do.

---

## 11. Performance guardrails

Budgets are set now, not after the first complaint.

| Surface | Budget |
|---------|--------|
| List/search API, normal dataset | P95 < 500 ms |
| Posting transaction | P95 < 800 ms |
| Trial balance, one period | P95 < 3 s |
| Page interactive (staging) | < 2.5 s |

Watched for and rejected in review: N+1 queries, unbounded result sets, queries without a tenant-leading index, browser-side filtering of server data, JSON responses over a few hundred KB.

Heavy analytics move to a read replica, materialised views, or reporting tables — never by slowing the posting path.

---

## 12. Environments

```
Local  →  CI  →  Development  →  Staging  →  Production
```

Each has its own database, credentials, secrets, storage and queues. Staging never connects to the production database. See [INFRASTRUCTURE.md](INFRASTRUCTURE.md) for hosting, deployment and backup detail.

---

## 13. Technology decisions (frozen for v1)

| Layer | Choice | ADR |
|-------|--------|-----|
| Frontend | Next.js (App Router), TypeScript | ADR-0001 |
| Backend | NestJS, TypeScript | ADR-0001 |
| Database | PostgreSQL | ADR-0002 |
| Tenancy | Shared DB + `tenant_id` + RLS | ADR-0003, ADR-0004 |
| Posting | Central double-entry engine | ADR-0005 |
| Records | Immutable posted transactions | ADR-0006 |
| Costing | Weighted average | ADR-0007 |
| Inventory | Movement ledger + FEFO batch selection | ADR-0008 |
| Sessions | JWT access + rotating refresh | ADR-0009 |
| Side effects | Transactional outbox | ADR-0019 |
| Money | `numeric` + decimal library | ADR-0011 |
| Periods | Fiscal period locking | ADR-0012 |
| Cache/queue | Redis | ADR-0002 |
| Packaging | Docker, one image per app | — |

---

## 14. Related documents

- [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md) — LEVEL 0 invariants
- [PRD.md](PRD.md) — product scope
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — how the work is sequenced and gated
- [INFRASTRUCTURE.md](INFRASTRUCTURE.md) — hosting, CI/CD, backups
- [adr/](adr/) — the decision records
