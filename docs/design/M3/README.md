# M3 design pack — customers, service invoice, customer receipt, customer ledger

| | |
|---|---|
| **Task** | M3-000b · docs only — no code, no migration |
| **Author** | Architecture seat, Technical Council ([ADR-0024](../../adr/ADR-0024-operating-model.md)) |
| **Date** | 2026-09-28 |
| **Authority** | LEVEL 3 design, below the posting rules and the ADRs. Where this pack and a [posting rule](../../posting-rules/) disagree, the rule wins and this pack is wrong. Two decisions here need LEVEL 1 records before code starts; they are listed in §6 and are **not** in force until those records are Accepted |
| **Depends on** | M2-A (`feature/M2-A-accounting-core`) merged · ADR-0026 party dimension (pending, `feature/M3-000a-party-dimension`) Accepted · M1-X's global `PermissionGuard` merged |

The goal of this pack: when M2-A merges, M3 coding starts with nothing left to decide. Every
choice a lane would otherwise make on its own is made here, with the reason.

| Document | Contents |
|---|---|
| [modules.md](modules.md) | The two modules, their layers, what each owns, the one published interface between them, the posting transaction, status machines, allocation, idempotency, numbering, locks, audit |
| [api-contract.md](api-contract.md) | Every M3 endpoint: request, response, permission, errors, pagination |
| [ui-plan.md](ui-plan.md) | For M4: which mock screens become API-backed, what changes in each page document, required states, what stays prototype |
| [open-questions.md](open-questions.md) | The two Product Owner decisions (M3-Q1 receipt drafts, M3-Q2 system-generated customer codes), both decided 2026-09-28, and the contradictions referred elsewhere |

---

## 1. Scope

**In.** The MVP-slice segment `customer → service invoice → payment → journal entry → customer
ledger → reversal` ([PRD](../../PRD.md) §6.1, [IMPLEMENTATION](../../IMPLEMENTATION.md) §13 M3):

- **Customers** — create (with a **system-generated code**, `CUST-000001`, PO 2026-09-28), list,
  view, edit a limited field set, deactivate and reactivate.
- **Sales invoice, service lines only** — draft create / edit / cancel, post
  (`SALE_POSTED/service@1`), reverse.
- **Customer receipt** — draft create / edit / cancel with **proposed** allocations (PO
  2026-09-28), post (`CUSTOMER_PAYMENT_RECEIVED@1`), method `CASH` or `BANK`, allocated in full to
  open invoices of the same customer; reverse. Allocations take effect only at post.
- **Customer ledger** — the `AR_CONTROL` account ledger filtered to one customer
  ([ledger-and-trial-balance.md](../../posting-rules/ledger-and-trial-balance.md) §2).
- **Invariant 9, AR half** ([customer-receipt.md](../../posting-rules/customer-receipt.md) §8)
  in the FinancialInvariantSuite.

**Out**, and rejected by schema rather than ignored: sales tax, discounts, stock lines, cash
settlement of a sale, cheques, advances and on-account receipts, over-payment, withholding tax,
credit limits and holds, opening balances, credit notes / sales returns, multi-currency, customer
statements, ageing, printing and email. Each has a later wave; none is guessed at here.

## 2. Migrations — numbering confirmed

M2 owns **010** `accounts`, **011** `fiscal_periods`, **012** `journal_entries` /
`journal_lines`, **013** `document_sequences` ([IMPLEMENTATION](../../IMPLEMENTATION.md) §13). M3
takes the next three, in this merge order:

| # | File | Lane | Contents |
|---|---|---|---|
| **014** | `014_create_customers.sql` | M3-C | `customers`; RLS enabled + forced; composite `UNIQUE (tenant_id, id)` as the FK target; and **the party foreign key from `journal_lines`**, in whichever form ADR-0026 decides (§4) |
| **015** | `015_create_sales_invoices.sql` | M3-P | `sales_invoices`, `sales_invoice_lines`; status-transition and immutability triggers |
| **016** | `016_create_customer_receipts.sql` | M3-P | `customer_receipts` (with `DRAFT` and `CANCELLED` states and the cancel columns, M3-Q1), `customer_receipt_draft_allocations` (proposals), `customer_receipt_allocations`; transition triggers |

The column-level shape of each table is in [modules.md](modules.md) §7. The Database seat owns the
SQL, the constraint names and the triggers.

**Reservation rule.** 014–016 are reserved for M3 from the date of this pack. M2-A may not claim
them. If M2-A needs a fifth migration, that is a Product Owner renumbering decision taken
**before** M3-C opens its PR, on the precedent of the M1 numbering decision (2026-09-26). No lane
renumbers on its own, and a number is never changed after review, because `CHECKSUMS` pins it.

## 3. Lanes

```
                 ┌── M3-C  customers module + module platform ──┐ merges first (014)
M2-A merged ─────┤                                               ├──► M3 demo ──► M4 UI
ADR-0026 Accepted│                                               │
ADR-0027 Accepted└── M3-P  receivables: invoice + receipt ───────┘ merges second (015, 016)
                      posting, T3, ONE lane
                      M3-Q  invariant 9 + golden runner ── parallel with M3-P, tests only
```

| Lane | Worktree | Tier | Delivers | Seats |
|---|---|---|---|---|
| **M3-C Customers** | `m3-customers` | T3 by path (`modules/*/domain`, `application`), T2 for 014 | The module platform (§5 conditions) · migration 014 · `modules/customers` · customer endpoints · customer ledger endpoint · `GET /api/me/permissions` ([api-contract.md](api-contract.md) S1) | Architecture · Database/Security |
| **M3-P Posting** | `m3-posting` | **T3** | Migrations 015, 016 · kernel rules `SALE_POSTED/service@1` and `CUSTOMER_PAYMENT_RECEIVED@1` switched from `RULE_NOT_ENABLED` to implemented · `modules/receivables` · invoice and receipt endpoints · lock-registry entries | Accounting · Architecture · Database/Security |
| **M3-Q QA** | `m3-qa` | T3 (`tests/accounting/**`) | Invariant 9 AR half in the FinancialInvariantSuite · the `posting-scenario/v1` runner executing P04, P05, P06, P08 (invoice steps), P09, P10 · adversarial tenant-isolation and RBAC suites for 014–016 and every M3 route | Accounting · Database/Security |

**Why M3-P is one lane.** Invoice and receipt share the allocation table, the invoice row lock,
the reversal precondition that couples them (PO-Q1 Option A) and the two kernel rules. Splitting
them puts two agents on the same lock order and the same kernel files at once, which
[IMPLEMENTATION](../../IMPLEMENTATION.md) §3 forbids for the posting algorithm.

**Why M3-C and M3-P can run side by side.** M3-P depends on customers only through the published
`CustomerDirectory` interface, which [modules.md](modules.md) §3 fixes now. M3-P codes against it
from day one and wires the real implementation once M3-C merges. M3-P's PR does not merge before
M3-C's, because 015 references 014.

**Why M3-Q is separate.** It writes only under `tests/`, so it cannot collide with M3-P. It also
keeps the reconciliation independent of the code it reconciles: the author of the subledger does
not write the check that the subledger agrees with the GL.

## 4. Dependencies

### On M2-A — the kernel surface M3 consumes

M3 imports only `@finsoft/accounting-kernel`'s public index (`modules-do-not-reach-into-kernels`).
It needs these seven things. The names are the ones this pack uses; M2-A may name them differently,
and M3 adapts to M2-A's names. It may not work around an absent capability.

| # | Capability | Used for | If M2-A does not ship it |
|---|---|---|---|
| K1 | `postingEngine.post(command, tx)` with a rule registry to which a rule can be **added** without touching the engine | Invoice and receipt posting | Blocker. M3 does not start |
| K2 | Reversal of a document-sourced entry, called by the owning module: `reverseForSource({ referenceType, referenceId, reason, idempotencyKey, actor }, tx)`. The direct journal reversal rejects document-sourced entries with `REVERSAL_VIA_SOURCE_REQUIRED` ([reversal.md](../../posting-rules/reversal.md) §5). This is the call shape README §5 leaves to this seat, **decided here** | Invoice and receipt reversal | M3-P adds it, with Accounting seat review |
| K3 | Document numbering from `document_sequences` for a **document** series: `documentNumbers.next(tx, { series: 'INV' \| 'RCT', occurredAt })`, row-locked, same FY rule as the entry series | Invoice and receipt numbers | M3-P adds it |
| K7 | A **tenant-lifetime** series in `document_sequences`, with no fiscal-year scope: `documentNumbers.next(tx, { series: 'CUST' })` → `CUST-000001` ([modules.md](modules.md) §10). **Migration 013 must allow a series row with no fiscal year**, for example a nullable `fiscal_year` with its own partial unique index, or a `scope` column. The Database seat chooses the shape | Customer codes (M3-Q2) | **Requirement on M2-A's 013**, raised 2026-09-28. If 013 merges without it, the fix is a forward kernel migration, and M3-C cannot start until it lands |
| K4 | `command.referenceNumber` — the source document's number, stored on the entry and shown in every ledger's "source document number" column ([ledger-and-trial-balance.md](../../posting-rules/ledger-and-trial-balance.md) §2) | Customer ledger lines show `INV-…` / `RCT-…` | M3-P adds it |
| K5 | Ledger queries with a party filter: account ledger of a role for one party over `[from, to]`, and party balances as of a date | Customer ledger, customer balance | M3-C adds the party filter to M2's ledger query |
| K6 | The tenant clock (today, tenant timezone) and a typed `PostingError { code, details }` | Draft date defaults; HTTP error mapping | Blocker. M3 does not start |

K2–K5 are small, but they are kernel changes. The kernel is never parallelised, so each one lands
**after** M2-A merges, inside M3-P (or M3-C for K5), reviewed as T3. **K7 is the exception.** It
is a property of the `document_sequences` schema, so it belongs in M2-A's migration 013 itself,
and not in a later change to a released kernel table.

**Rules switched on in M3, not M2.** [service-sale.md](../../posting-rules/service-sale.md) and
[customer-receipt.md](../../posting-rules/customer-receipt.md) say "Implemented in: M3". M2-A
ships them as `RULE_NOT_ENABLED`, and M3-P implements them against P04, P05, P06 and P10.

### On ADR-0026 (pending) — the journal-line party dimension

The Database seat is deciding whether `journal_lines.party_id` points at a **kernel-owned parties
registry** or directly at the **module-owned `customers`** table. This pack works under either
outcome because of one design rule:

> **A customer's id is its party id.** Under the registry outcome, `customers.id` is also a
> foreign key to `parties(tenant_id, id)`, with the same uuid. Under the direct outcome,
> `journal_lines (tenant_id, party_id)` references `customers (tenant_id, id)`. Either way, the
> posting payload's `customerId` is the value the kernel writes as `party_id`.

**The one place the outcome matters is customer creation.** It changes two things, both inside
M3-C:

| | Parties registry (kernel-owned) | Direct FK (module-owned `customers`) |
|---|---|---|
| `CreateCustomer` application service | Calls the kernel's `parties.register(tx, { id, type: 'CUSTOMER' })` **before** inserting the customer, in the same transaction | Inserts the customer only |
| Migration 014 | Creates `customers` with `FOREIGN KEY (tenant_id, id) REFERENCES parties (tenant_id, id)`. `parties` itself is in 012 if ADR-0026 is Accepted before 012 merges, and at the head of 014 otherwise | Creates `customers`, then adds the composite FK `journal_lines (tenant_id, party_id) → customers (tenant_id, id)` |

Nothing else in this pack changes: not the receivables module, not the API, not the UI and not
the invariant test. If ADR-0026 lands a third shape, only this table is revisited.

### On M1-X — permission enforcement

On `develop` today `PermissionGuard` is **not** registered globally, so `@RequirePermission` is
documentation and enforces nothing (`apps/api/src/audit/audit.controller.ts:32–40`). M1-X
registers it as the second global guard and adds `@AuthenticatedOnly` with a startup check. **No
M3 route merges before that.** A money-moving endpoint whose permission is not enforced is a rule
18 violation, whatever its decorator says.

## 5. Module platform — conditions on M3-C's first PR

M3 is the first time `modules/` holds code, so four boundary rules that have never had anything to
check start running. They must be shown to fire before any module code depends on them:

1. **ADR-0027 Accepted** (§6).
2. **Workspaces and build:** `"modules/*"` added to root `workspaces`; `modules/.scaffold/`
   deleted ([its own README](../../../modules/.scaffold/README.md) says to); `modules/**` added to
   `tools/ci/risk-tiers.json` `images.api` (without it a module change does not rebuild the API
   image); `modules/*/infrastructure/**` added to **T3** (unmatched today, so it falls back to T1,
   and it is where allocations are written and invoices locked); the API Dockerfile copies
   `modules/`.
3. **Query construction outside infrastructure is a lint error.** The `appsQuerySyntax` selector
   (`selectFrom`, `insertInto`, `updateTable`, `deleteFrom`, …) extended to
   `modules/*/{api,application,domain}/**`, with a case in `tests/security/lint-boundaries.spec.ts`.
   Dependency-cruiser cannot see a `TenantTx` that arrives as a parameter, which is how the
   readiness probe once built queries in the HTTP layer (ADR-0013 "Receiving a handle…").
4. **Cross-module imports only through `published.ts`.** A new dependency-cruiser rule: from
   `modules/X/` to `modules/Y/` (Y ≠ X), only `modules/Y/application/published.ts` is reachable.
   Today's `no-cross-module-internals` forbids only `domain/` and `infrastructure/`, so
   `modules/receivables` could import `modules/customers/application/create-customer.ts`.
5. **Negative controls.** `tests/security/depcruise-negative-control.spec.ts` gains probes for
   `no-cross-module-internals`, `domain-is-pure`, `application-does-not-import-api`,
   `modules-do-not-reach-into-kernels` and the new rule in item 4. Four of these are among the
   eight rules ADR-0013 names as unproven. Before M3 they could not fire. After M3 they must be
   **proven** to fire.
6. **Strip-only safety** (`stripOnlySyntax`: no enums, no parameter properties, no namespaces)
   applied to `modules/**`, because modules run under Node's type stripping (§6).

## 6. Decisions that need a LEVEL 1 record before code

| Record | Decision | Why it cannot be LEVEL 3 |
|---|---|---|
| **ADR-0027 — module packaging and runtime** (Architecture seat, to be written; next free number after ADR-0026) | (a) each module is a workspace package run under Node type stripping, like `packages/*`; (b) **NestJS controllers for a module live in `apps/api/src/<module>/`** as thin adapters, and the module's `api/` layer holds the framework-free HTTP contract (zod request schemas, response mappers, error-code → status table); (c) modules have **no `ui/` layer**, and screens live in `apps/web/src/screens`; (d) application-layer ports are typed with `TenantTx` and implemented in `infrastructure/`, which may import `application/ports.ts` **type-only** | It amends [ARCHITECTURE](../../ARCHITECTURE.md) §2, which puts controllers and decorators in `modules/*/api/` and route segments in `modules/*/ui/`. Both are unworkable as written: decorators cannot run under type stripping, which is how every workspace package runs (`apps/api/tsconfig.json` header), and `web-is-ui-only` already forbids `apps/web → modules/**`, so a module `ui/` layer could never be imported. The reasoning is in [modules.md](modules.md) §1 |
| **ADR-0026** (Database seat, pending) | Party dimension (§4) | Kernel table referencing a module table, per posting-rules README §5 |

## 7. Definition of done — M3

Every item applies to both lanes unless marked. "The endpoint returns 200" is not done.

**Financial**

- [ ] Golden **P04, P05, P06, P08 (invoice steps), P09, P10** execute in the financial gate
      through the module application layer, not by calling the kernel directly, and match the
      hand-computed figures exactly. P01–P03 and P07 stay green.
- [ ] **Invariant 9, AR half**, in the FinancialInvariantSuite for every tenant, every customer
      and every as-of date that has a posting: `GL(C, D) = SUB(C, D)` exactly, where GL is read
      from `journal_lines` and SUB from `sales_invoices` and `customer_receipts`, computed
      independently of each other. Also `Σ over C of GL(C, D) = AR_CONTROL balance at D`, and
      `SUB(C, today) = Σ outstanding of C's POSTED invoices`. It is also run after **every step**
      of a randomised sequence of post / receive / reverse operations (property test, ≥ 200 runs).
- [ ] Invariants 1, 2, 4, 5, 6, 7, 8 stay green with M3 postings in the data.
- [ ] Three identical `POST /api/invoices/:id/post` requests produce one entry and one `INV`
      number; the same holds for receipts and both reversals. A reused key with a different body
      returns `IDEMPOTENCY_KEY_REUSED`.
- [ ] A rejected posting consumes no `INV`, `RCT`, `JE` or `RV` number (P05 steps 2–5, P06 step 3).
      A draft, saved or cancelled, consumes none either. A rolled-back customer create consumes
      no `CUST` number.
- [ ] A receipt draft's proposed allocations change no invoice's outstanding, and do not appear
      in Invariant 9's SUB. Posting a draft whose proposal went stale (the invoice was paid or
      reversed meanwhile) is refused with the specific allocation error, not partially applied.
- [ ] Concurrency, with two real connections: two receipts allocating the full outstanding of
      one invoice → exactly one succeeds and the other returns `ALLOCATION_EXCEEDS_OUTSTANDING`;
      a receipt racing an invoice reversal → one of the two orders, never both; a deactivation
      racing an invoice post → the post commits first, or the deactivation is refused because of
      the balance. No `40P01`.

**Platform**

- [ ] RLS enabled and forced on all six new tables. Composite tenant FKs everywhere. Adversarial
      tests: another tenant's customer id in an invoice body returns the same `CUSTOMER_NOT_FOUND`
      as an unknown id, and likewise for invoice ids in allocations and for every `:id` route.
- [ ] RBAC: every route returns 403 without its permission and 401 without a session. The Viewer
      role can read and cannot mutate.
- [ ] Audit: every transition in [modules.md](modules.md) §8 writes its record in the same
      transaction, and the test asserts the record, not just the row count.
- [ ] §5 conditions 1–6 met. `npm run check:full` green. OpenAPI documents every route and error
      code. No secrets. Each lane stayed inside its `ALLOWED` paths.

**Demoable** (each increment must be: [IMPLEMENTATION](../../IMPLEMENTATION.md) §13)

- [ ] **M3 demo, on staging, for `BHATTI1` and `BHATTI2`:** a scripted HTTP client (committed
      under `tests/e2e/`) runs the P09 journey through the real API: create a customer, draft and
      post a 10,000.0000 invoice, save a 6,000.0000 receipt as a draft and show the invoice still open, post it, show the customer ledger at 4,000.0000 Dr,
      show that invoice reversal is refused, reverse the receipt, reverse the invoice, and show the
      ledger at 0.0000 and the trial balance balanced, then the audit trail. The other tenant sees
      none of it. Shown through the API because the screens are M4. The Product Owner accepts the
      workflow, not the JSON.

## 8. What M3 enables in the M4 journey

| M4 journey step ([PRD](../../PRD.md) §6.1) | Enabled by |
|---|---|
| customer | `POST /api/customers`, `GET /api/customers[/:id]` |
| service invoice | `POST /api/invoices`, `PUT /api/invoices/:id`, `POST /api/invoices/calculate`, `POST /api/invoices/:id/post` |
| payment | `GET /api/invoices?customerId=…&open=true`, `POST /api/receipts/preview`, `POST /api/receipts` (draft), `PATCH /api/receipts/:id`, `POST /api/receipts/:id/post` |
| journal entry | `journalEntry { id, number }` on every posted document, resolved by M2's journal endpoint |
| customer ledger | `GET /api/customers/:id/ledger` |
| trial balance | M2 (unchanged; M3 postings appear in it) |
| reversal | `POST /api/receipts/:id/reverse`, then `POST /api/invoices/:id/reverse` |
| audit trail | M1 `GET /api/audit`, filtered by `entityType` / `entityId` from [modules.md](modules.md) §8 |

The Playwright journey in M4 asserts the same figures as P09, through the screens, for both
tenants.

## 9. Cost of the Product Owner's 2026-09-28 decisions

| Decision | Effect on the plan |
|---|---|
| M3-Q1 — receipt drafts | **+2 days on M3-P**: draft state, proposed-allocation revisions, draft edit / cancel, post-time re-validation of stale proposals, three more audit actions and their tests. **+1 day in M4**: Save draft, resume, and the stale-proposal state on `/payments` |
| M3-Q2 — system-generated customer codes | **+0.5 day**, split between M2-A (the non-fiscal-year series in 013, K7) and M3-C. M4 is slightly simpler, because the form loses a field. Wave 10 later needs a `legacy_code` (debt below) |

## 10. Debt this design accepts

To be entered in [TECH_DEBT.md](../../TECH_DEBT.md) by the lane that creates it, each with its
forcing condition:

| Debt | Accepted because | Forced by | Lane |
|---|---|---|---|
| Customer edits use `customer.create`, and AR reads use `customer.view` ([api-contract.md](api-contract.md) §2) | The MVP catalogue has no `customer.update` or `invoice.view`. Adding codes means seeding existing tenants' system roles, which is a catalogue task of its own | The first tenant that needs a role able to create customers but not edit them, or to read documents without seeing customers. At the latest, the full-catalogue task | M3-C |
| Superseded draft revisions (invoice lines and receipt proposed allocations) are kept and never read ([modules.md](modules.md) §7) | Keeps both tables insert-only, with no `DELETE` grant and no money in `jsonb` | Draft storage becoming measurable, well beyond MVP volumes | M3-P |
| Receipt drafts and receipt posting share `payment.receive` ([api-contract.md](api-contract.md) §2) | The MVP catalogue has one receipt code. Invoices already split `invoice.create` / `invoice.post`. The matching split for receipts is a proposed `payment.post`, which needs a catalogue change and seeding | The first tenant that wants a clerk to prepare receipts that someone else posts (maker–checker, after the MVP per PO-Q2 of M2) | M3-P |
| Customer codes are system-generated, so Bhatti's existing codes cannot be carried over as the code | Product Owner decision, 2026-09-28 | Wave 10 migration: add a searchable `legacy_code` on `customers` then | Wave 10 |
| The customer ledger is unpaginated, capped at 366 days ([api-contract.md](api-contract.md) §4.1) | MVP volumes; a correct running balance across pages needs an opening balance per page | A customer with more than about 2,000 lines in a year | M3-C |
