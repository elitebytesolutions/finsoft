# M3 modules — `modules/customers` and `modules/receivables`

Part of the [M3 design pack](README.md). Everything below is binding on M3-C and M3-P unless a
[posting rule](../../posting-rules/) or an ADR says otherwise, in which case that document wins.

---

## 1. Two modules, and their names

| Module | Package | Owns |
|---|---|---|
| `modules/customers` | `@finsoft/customers` | The customer master and the customer ledger view |
| `modules/receivables` | `@finsoft/receivables` | Sales invoices, customer receipts, allocations: the AR subledger |

**Why `receivables` and not `sales`.** Allocation is one table joining receipts to invoices.
Recording a receipt must lock invoice rows and read their outstanding. Reversing an invoice must
read the receipts allocated to it. If invoices and receipts sat in different modules, one of them
would lock and read the other's table, which is a cross-module table access
([ARCHITECTURE](../../ARCHITECTURE.md) §5). Both documents therefore belong to the module that owns
the open-item state. That is the AR subledger, and Invariant 9's subledger side is exactly this
module's data. "Sales" names the upstream commercial flow of Wave 7 (quotation, order, delivery).
When that flow arrives it calls `receivables` through a published interface to raise the invoice.
Whether stock lines are then posted by the invoice or by the delivery is a Wave 7 decision, and
this naming decides nothing about it.

**Why customers is a separate module.** The customer master is referenced by receivables now, and
later by sales, credit control, cheques and statements. None of them may reach into another's
tables. It is also the first real use of the published-interface pattern, which is better proved
on a small interface in M3 than on a large one in Wave 7.

### Packaging — ADR-0028, required before code ([README](README.md) §6)

```
modules/receivables/
├── package.json          "@finsoft/receivables", "type": "module", exports:
│                           "."           → ./index.ts            (for apps/api, apps/worker)
│                           "./published" → ./application/published.ts  (for other modules)
├── index.ts              use-case factories + the api/ contract. Nothing from infrastructure
│                         is re-exported except the factory that builds repositories
├── domain/               pure TypeScript — entities, value objects, rules, errors
├── application/          use cases, ports.ts (repository interfaces), published.ts
├── infrastructure/       Kysely repositories implementing application/ports.ts
└── api/                  framework-free HTTP contract: zod request schemas, DTO mappers,
                          error-code → HTTP status table
```

The controllers are `apps/api/src/receivables/*.controller.ts` and
`apps/api/src/customers/*.controller.ts`. Each is thin: it parses input with the module's zod
schema, calls one use case, and maps the result with the module's mapper. There is no logic in a
controller that a test of the module would miss.

**Why controllers are not in `modules/*/api`, contrary to ARCHITECTURE §2.** Every workspace
package runs under Node's type stripping. That is how `apps/api` loads `@finsoft/database`
today (`apps/api/tsconfig.json` header). NestJS needs legacy decorators with emitted metadata, and
type stripping cannot run those. So a controller in a module package is not loadable unless the
module stops being a normal package and becomes a second SWC build root of `apps/api`. That would
make the worker, which has no build at all, unable to import any module. Putting the adapters in
`apps/api` costs one thin file per controller and keeps every module importable by the API, the
worker and the tests alike. The same ADR removes the per-module `ui/` layer: `web-is-ui-only`
already makes it unimportable.

**Ports and the `infrastructure → domain` arrow.** A repository method takes a `TenantTx`, and
`domain/` may not see `@finsoft/database`, not even as a type
(`eslint.config.mjs` module-domain block). So repository interfaces live in
`application/ports.ts`, and `infrastructure/` implements them with a **type-only** import of that
one file. Dependencies still point inward; ADR-0028 records it so the arrow in §2 is not read as
forbidding it. A depcruise rule confines the edge to `application/ports.ts` and to type-only.

## 2. What each module owns

| | `customers` | `receivables` |
|---|---|---|
| **Tables** (write) | `customers` | `sales_invoices`, `sales_invoice_lines`, `customer_receipts`, `customer_receipt_draft_allocations`, `customer_receipt_allocations` |
| **Tables** (read) | its own | its own. **Never `customers`**: through `CustomerDirectory` only |
| **Kernel calls** | `documentNumbers.next` for the `CUST` series (K7); ledger queries (K5); `parties.register` if ADR-0026 chooses a registry | `postingEngine.post`, `reverseForSource`, `documentNumbers.next`, tenant clock |
| **Use cases** | `CreateCustomer`, `UpdateCustomer`, `DeactivateCustomer`, `ReactivateCustomer`, `ListCustomers`, `GetCustomer`, `GetCustomerLedger` | `CreateInvoiceDraft`, `UpdateInvoiceDraft`, `CancelInvoiceDraft`, `CalculateInvoice`, `PostInvoice`, `ReverseInvoice`, `ListInvoices`, `GetInvoice`, `PreviewReceipt`, `CreateReceiptDraft`, `UpdateReceiptDraft`, `CancelReceiptDraft`, `PostReceipt`, `ReverseReceipt`, `ListReceipts`, `GetReceipt` |
| **Publishes** | `CustomerDirectory` (§3) | nothing in M3 |
| **Consumes** | kernel only | `CustomerDirectory`, kernel |

**The customer ledger is in `customers`, and it does not read receivables.** It is the
`AR_CONTROL` account ledger filtered to one party, read from the journal
([ledger-and-trial-balance.md](../../posting-rules/ledger-and-trial-balance.md) §2). The
journal is the only source of balances (rule 11), and modules may call the kernel. So neither
module depends on the other for balances, and there is no cycle. The customer balance on the list
and the detail page comes from the same kernel query. Invariant 9 then checks that this GL figure
agrees with the receivables subledger, which is computed separately. Two independent computations
is what the invariant exists to compare.

## 3. The published interface — the only way receivables talks to customers

```ts
// modules/customers/application/published.ts — the ONLY cross-module import target
import type { TenantTx } from '@finsoft/database'

export interface CustomerRef {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly status: 'ACTIVE' | 'INACTIVE'
}

export interface CustomerForPosting extends CustomerRef {
  readonly creditDays: number
}

export type CustomerDirectoryErrorCode = 'CUSTOMER_NOT_FOUND' | 'CUSTOMER_INACTIVE'

export class CustomerDirectoryError extends Error {
  readonly code: CustomerDirectoryErrorCode
  // constructor assigns code; no parameter properties (strip-only)
}

export interface CustomerDirectory {
  /**
   * INVOICING only (I2/I4/I7). Takes FOR SHARE on the customer row, then checks the
   * customer exists in the tenant and is ACTIVE. Throws CUSTOMER_NOT_FOUND (unknown id
   * and another tenant's id are the same error) or CUSTOMER_INACTIVE. Called inside the
   * caller's posting transaction; the lock holds until it commits, so a concurrent
   * deactivation waits (§10).
   */
  requireActiveForPosting(tx: TenantTx, customerId: string): Promise<CustomerForPosting>

  /**
   * PAYMENT only (R3/R5/R6, `PostReceipt`). Accounting seat ruling R-2 (Council review,
   * 2026-09-29): an inactive customer can still be paid, only not invoiced — this
   * resolves the service-sale.md §11 / customer-receipt.md §3 row 8 contradiction §12
   * records as referred. Same lock and the same CUSTOMER_NOT_FOUND behaviour as
   * `requireActiveForPosting`, but deliberately status-agnostic: never throws
   * CUSTOMER_INACTIVE.
   */
  requireForPayment(tx: TenantTx, customerId: string): Promise<CustomerRef>

  /** No lock, no status filter. For display. Ids not found are absent from the map. */
  getRefs(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, CustomerRef>>
}
```

- `published.ts` imports nothing from its own module except types that it re-declares. The DTOs
  above are plain shapes, not domain entities, so a change inside `customers/domain` can never
  break `receivables`.
- The implementation is `customers/application/customer-directory.ts`, which calls the
  customers repository. `apps/api` builds it and passes it into the receivables use-case
  factories. `receivables` imports the **type** and the error class only.
- `sales_invoices.customer_id` and `customer_receipts.customer_id` are composite foreign keys to
  `customers (tenant_id, id)`. A foreign key is a reference, not a write: its implicit
  `KEY SHARE` lock is PostgreSQL's, not a query of another module's table. Rule 17 and Invariant 7
  require the key. Nothing in receivables selects from, joins to, or updates `customers`.
- **Adding a method is an Architecture seat review.** The interface is a public surface, and it
  is kept small on purpose.

## 4. How posting is invoked — one transaction per command

Each state-changing use case is **one** `withTenant` unit of work, opened by the application
layer. Every use case follows the same shape, and the reason is §10:

```
locks (in §10 order)  →  domain checks  →  document number  →  ALL module writes
                      →  kernel call (entry number, entry, kernel audit)  →  module audit
```

Nothing is written or locked by the module after the kernel call except the audit record.
Position 6 (audit) is terminal, and the kernel's audit is inside its call.

### 4.1 `PostInvoice(invoiceId, { version }, idempotencyKey, actor)`

```
withTenant(tx =>
  0  customerId ← repo.customerIdOf(tx, id)                     plain read, no lock
  1  customer ← customerDirectory.requireActiveForPosting(tx, customerId)   FOR SHARE  (1a)
  2  invoice  ← repo.lockInvoice(tx, id)                        FOR UPDATE          (1c)
     └ POSTED/REVERSED, post_idempotency_key = key, fingerprint matches → REPLAY (return it)
     └ POSTED/REVERSED otherwise → SOURCE_ALREADY_POSTED;  CANCELLED → INVOICE_NOT_DRAFT
     └ invoice.version ≠ version, or customer_id ≠ customerId       → VERSION_CONFLICT
  3  domain: invoice.assertPostable(today)  — 1..200 lines, qty > 0, price > 0,
            lineNet = round_half_up(qty × price, 4), net = Σ lineNet            (Money)
  4  number   ← documentNumbers.next(tx, { series: 'INV', occurredAt: invoice.invoiceDate })  (5a)
  5  repo.markPosted(tx, id, { number, postedBy, postIdempotencyKey, fingerprint })
  6  entry    ← postingEngine.post({ event: SALE_POSTED, referenceType: 'sales_invoice',
                  referenceId: id, referenceNumber: number, occurredAt: invoiceDate,
                  idempotencyKey: key, actor, payload: invoice.toSalePostedPayload() }, tx)  (5b, 6)
  7  recordAudit(tx, 'sales_invoice.posted', …)                                               (6)
)
```

Step 0 reads the customer id without a lock so that the customer can be locked **before** the
invoice, in registry order. Step 2 then re-checks the customer id under the invoice lock. A draft
whose customer was changed in between fails with `VERSION_CONFLICT`, and the user reloads it.
A replay (step 2) takes the customer lock unnecessarily. That costs a shared lock, and it keeps
the lock order a single rule.

The payload is built by the **domain** (`toSalePostedPayload`), from the same `Money` arithmetic
the kernel re-runs. The kernel verifies the figures and never substitutes its own
([service-sale.md](../../posting-rules/service-sale.md) §4 rows 5–6).

### 4.2 Receipt drafts, then `PostReceipt(receiptId, { version }, idempotencyKey, actor)`

**Receipts have drafts** (Product Owner, 2026-09-28, M3-Q1). A draft is a normal row with status
`DRAFT`. It posts nothing to the GL, has no number, and holds **proposed** allocations. A
proposal reserves nothing: it takes no lock, changes no invoice's outstanding, and is not in
Invariant 9's SUB. Proposals become allocations only inside `PostReceipt`, under the invoice
locks, after being re-validated there.

| Use case | Transaction | Notes |
|---|---|---|
| `CreateReceiptDraft(command, key)` | insert the receipt (`DRAFT`) + proposal revision 1 | Only `customerId` and `receiptDate` are required. `method`, `amount` and the proposals may be empty. Advisory checks (R2's `problems`) come back with the response; nothing is refused for being incomplete |
| `UpdateReceiptDraft(id, patch, version)` | receipt `FOR UPDATE` (1b), check `DRAFT` and `version`, update the header, and insert a new proposal revision when `allocations` is in the patch | Optimistic lock. No invoice lock, because proposals do not touch invoices |
| `CancelReceiptDraft(id, version)` | receipt `FOR UPDATE`, `DRAFT → CANCELLED` | Terminal. No number is ever assigned |

```
PostReceipt:
withTenant(tx =>
  0  customerId ← repo.customerIdOfReceipt(tx, id)              plain read, no lock
  1  customer ← customerDirectory.requireForPayment(tx, customerId)        FOR SHARE  (1a, R-2: status-agnostic)
  2  receipt  ← repo.lockReceipt(tx, id)                        FOR UPDATE          (1b)
     └ POSTED/REVERSED, post_idempotency_key = key, fingerprint matches → REPLAY
     └ POSTED/REVERSED otherwise → SOURCE_ALREADY_POSTED;  CANCELLED → RECEIPT_NOT_DRAFT
     └ receipt.version ≠ version, or customer_id ≠ customerId        → VERSION_CONFLICT
  3  domain: receipt.assertComplete() — method set, amount > 0, ≥ 1 proposal, each > 0,
            no invoice twice, Σ proposals = amount exactly           (Money)
  4  invoices ← repo.lockInvoicesForAllocation(tx, proposedInvoiceIds)   FOR UPDATE, ascending id,
                                                                          ONE AT A TIME       (1c)
  5  outstanding ← repo.outstandingOf(tx, proposedInvoiceIds)     net − Σ LIVE allocations, under the locks
  6  domain: receipt.assertAllocatable(invoices, outstanding)     — same customer, invoice POSTED,
            invoiceDate ≤ receiptDate, proposal ≤ outstanding. A stale proposal fails HERE with
            its specific error, naming the invoice; nothing is partially applied
  7  number ← documentNumbers.next(tx, { series: 'RCT', occurredAt: receiptDate })    (5a)
  8  repo.markPosted(tx, id, { number, postedBy, postIdempotencyKey, fingerprint })
     repo.insertAllocations(tx, id, proposals → LIVE)
  9  entry  ← postingEngine.post({ event: CUSTOMER_PAYMENT_RECEIVED, referenceType: 'customer_receipt',
                referenceId: id, referenceNumber: number, occurredAt: receiptDate,
                idempotencyKey: key, actor, payload: { customerId, method, amount, allocations } }, tx)
                                                                                     (5b, 6)
 10  recordAudit(tx, 'customer_receipt.posted', …)                                  (6)
)
```

- **This matches the numbering rule.** The number is assigned in the posting transaction, after
  validation, and a failure rolls it back ([posting-rules README](../../posting-rules/README.md) §4
  "Numbering"; [customer-receipt.md](../../posting-rules/customer-receipt.md) §1, which already
  describes a `DRAFT → POSTED` trigger that assigns `RCT-…`). Nothing needs flagging. The
  Accounting seat is adding the draft wording to customer-receipt.md on
  `feature/M3-000c-posting-rules`. This pack does not edit posting rules.
- **The concurrent twin** (the same post sent twice) is serialised by the receipt's own row lock
  at step 2. The second request sees `POSTED` with its own key and returns the replay. No
  re-check is needed, which is simpler than the one-step design this replaces.
- **Why proposals are a separate table.** `customer_receipt_allocations` keeps one meaning,
  "this money settled this invoice" (`LIVE`), or "it did until the receipt was reversed"
  (`VOIDED`). If proposals shared the table with a `PROPOSED` status, every outstanding query and
  the Invariant 9 test would need to exclude them, and forgetting that once would under-state
  receivables. See §7.
- **Save and post from a fresh form** is two requests: create the draft, then post it. The UI
  does this for its "Post" button on an unsaved form ([ui-plan.md](ui-plan.md) §3). There is no
  one-shot create-and-post route, so there is exactly one posting path.

### 4.3 `ReverseInvoice(invoiceId, { reason }, key, actor)`

```
withTenant(tx =>
  1  invoice ← repo.lockInvoice(tx, id)                        FOR UPDATE
     └ REVERSED with reverse_idempotency_key = key (same fingerprint) → REPLAY
     └ REVERSED otherwise → ALREADY_REVERSED;  DRAFT/CANCELLED → INVOICE_NOT_POSTED
  2  live ← repo.liveAllocationsTo(tx, id)                      under the invoice lock
     └ any → INVOICE_HAS_LIVE_ALLOCATIONS { receipts: [RCT-…] }  (PO-Q1 Option A)
  3  domain: assertReason(reason)                               non-empty after trim, ≤ 500
  4  repo.markReversed(tx, id, { reversedBy, reason, reverseIdempotencyKey, fingerprint })
  5  rev ← reversalEngine.reverseForSource({ referenceType: 'sales_invoice', referenceId: id,
            reason, idempotencyKey: key, actor }, tx)            RV number, date rule, kernel audit
  6  recordAudit(tx, 'sales_invoice.reversed', …)
)
```

The document is marked `REVERSED` before the kernel is called, following the shape above. If the
kernel refuses (for example `PERIOD_CLOSED` for today's period,
[reversal.md](../../posting-rules/reversal.md) §4), the whole unit rolls back and the invoice is
`POSTED` again, as if nothing happened.

Step 2 is safe without locking the allocation rows. Every writer of a LIVE allocation to this
invoice (`PostReceipt` step 4) must hold this invoice's row lock first, so while this
transaction holds the lock, no LIVE allocation can appear. `ReverseReceipt` only ever turns
allocations `VOIDED`. At worst, then, step 2 refuses a reversal that a moment later would have
been allowed, and that is safe.

### 4.4 `ReverseReceipt(receiptId, { reason }, key, actor)`

```
withTenant(tx =>
  1  receipt ← repo.lockReceipt(tx, id)                        FOR UPDATE          (1b)
     └ replay / ALREADY_REVERSED as in 4.3;  DRAFT/CANCELLED → RECEIPT_NOT_POSTED
  2  repo.lockInvoicesForAllocation(tx, receipt.allocatedInvoiceIds)   ascending id, one at a time (1c)
  3  domain: assertReason(reason)
  4  repo.voidAllocations(tx, id)                               LIVE → VOIDED, never deleted
     repo.markReversed(tx, id, { reversedBy, reason, reverseIdempotencyKey, fingerprint })
  5  rev ← reversalEngine.reverseForSource({ referenceType: 'customer_receipt', referenceId: id, … }, tx)
  6  recordAudit(tx, 'customer_receipt.reversed', …)
)
```

Step 2 is not needed for correctness, because voiding only ever increases outstanding. It is
there so that every writer of allocations holds the invoice locks. That keeps the §10 order a
single rule ("allocations change only under their invoices' locks") rather than a rule with an
exception that the next change forgets.

The allocation `UPDATE`s in step 4 take row locks on the allocation rows. They are taken before
the kernel call, so they come before positions 5 and 6. No other transaction locks an allocation
row without first holding the receipt's lock (1b), so these locks cannot wait.

## 5. Status machines

```
sales_invoices.status

    ┌─────── CancelInvoiceDraft ───────► CANCELLED    (terminal; never numbered)
    │
  DRAFT ──── PostInvoice ────► POSTED ──── ReverseInvoice ────► REVERSED   (terminal)
    ▲  │
    └──┘ UpdateInvoiceDraft (version + 1)

customer_receipts.status   (drafts: Product Owner, 2026-09-28)

    ┌─────── CancelReceiptDraft ───────► CANCELLED    (terminal; never numbered)
    │
  DRAFT ──── PostReceipt ────► POSTED ──── ReverseReceipt ────► REVERSED   (terminal)
    ▲  │
    └──┘ UpdateReceiptDraft (version + 1; a new proposal revision when allocations change)

customer_receipt_allocations.status

  LIVE ──── (only inside ReverseReceipt) ────► VOIDED   (terminal)
```

- **No other transition exists.** A trigger in 015 and 016 rejects any other `status` change, any
  change to a non-`DRAFT` invoice or receipt other than the one `POSTED → REVERSED` update of its
  reversal columns, and any change to a posted invoice's lines or a posted receipt's proposals ([ADR-0006](../../adr/ADR-0006-immutable-posted-transactions.md)).
- **Cancel, not delete.** ADR-0006 allows an audited deletion of a draft. M3 uses the stricter
  form, a terminal `CANCELLED` status, for invoices and receipts alike (the Product Owner's word
  for receipts, and used for invoices too so that one concept has one name), because the base repository has no delete and no role is
  granted `DELETE` (FND-005). Nothing is gained by being the first code in the repository that
  needs one.
- **Settlement is derived, never stored.** For display, a `POSTED` invoice is `OPEN`
  (outstanding = net), `PARTIALLY_PAID` (0 < outstanding < net) or `PAID` (outstanding = 0),
  computed server-side in the query. It is not a status and it has no column, because a stored
  copy of a derivable figure is a second source of truth (rule 11).

## 6. Allocation model

- **Subledger only.** An allocation is a row `(tenant_id, receipt_id, invoice_id, amount, status)`.
  It produces **no journal line**. A receipt against three invoices is still one debit and one
  credit ([customer-receipt.md](../../posting-rules/customer-receipt.md) §4).
- **Full or partial.** An allocation may be less than the invoice's outstanding (partial) or equal
  to it (full). It may never be more. The receipt must be allocated **in full**: Σ allocations =
  amount, exactly. An unallocated remainder is an advance, and advances are deferred.
- **Outstanding** = `invoice.net_amount − Σ amount of LIVE allocations to it`. It is computed in
  SQL, never stored and never computed in the browser. For a `REVERSED` invoice it is reported as
  `0.0000`, and a reversed invoice cannot have LIVE allocations (§4.3 step 2).
- **Proposed on the draft, applied at post.** A draft receipt carries **proposals** in
  `customer_receipt_draft_allocations`, which reserve nothing and are re-validated under the
  invoice locks at post (§4.2). Only posting creates rows in `customer_receipt_allocations`.
- **Manual.** The server applies exactly the proposals on the draft being posted. Oldest-first is a
  **suggestion** returned by `POST /api/receipts/preview`, computed server-side, so the browser
  never subtracts money (rule 19). It is never applied implicitly.
- **No other mutation.** There is no endpoint to add, change or remove an allocation. Allocations
  are created by `PostReceipt` and voided by `ReverseReceipt`, and by nothing else.
- `UNIQUE (tenant_id, receipt_id, invoice_id)`. Index `(tenant_id, invoice_id) WHERE status = 'LIVE'`
  for the outstanding computation.

## 7. Tables — the shape the Database seat writes

Every table: `id uuid pk`, `tenant_id uuid not null` (leading in every index),
`created_at/created_by/updated_at/updated_by`, `version int`, RLS enabled and forced with the
standard `tenant_isolation` policy, composite FKs on `(tenant_id, …)`, no `ON DELETE CASCADE`, no
`DELETE` grant. Money `numeric(19,4)`, quantity and unit price `numeric(19,6)`. Constraint names,
triggers and grants belong to the Database seat.

**014 `customers`**

| Column | Type / rule |
|---|---|
| `code` | text not null, **system-generated** at create from the tenant's `CUST` series (§10, Product Owner 2026-09-28), `^CUST-[0-9]{6,}$`, `UNIQUE (tenant_id, code)`, immutable (trigger). The API never accepts it |
| `name` | text, 1–200 after trim |
| `phone`, `email`, `address`, `city` | text, nullable; length-capped; `email` format-checked by the API schema, not the database |
| `ntn` | text, nullable, `^[0-9]{7}-?[0-9]?$`. Stored only: no tax logic in the MVP |
| `credit_days` | int, 0–365, default 0. Default due date = invoice date + credit days. No GL effect |
| `status` | `ACTIVE` \| `INACTIVE` |
| `create_idempotency_key`, `create_fingerprint` | `UNIQUE (tenant_id, create_idempotency_key)` |

**015 `sales_invoices`**

| Column | Type / rule |
|---|---|
| `customer_id` | FK `(tenant_id, customer_id) → customers` |
| `status` | `DRAFT` \| `POSTED` \| `REVERSED` \| `CANCELLED` |
| `number` | text, null while `DRAFT`/`CANCELLED`; `UNIQUE (tenant_id, number)`; `CHECK (status in ('POSTED','REVERSED')) = (number is not null)` |
| `invoice_date`, `due_date` | date (business date, tenant timezone). `due_date ≥ invoice_date` |
| `narration` | text, nullable, ≤ 500 |
| `net_amount` | numeric(19,4) ≥ 0, recomputed server-side on every draft save; > 0 enforced at post |
| `lines_revision` | int — which revision of `sales_invoice_lines` is current (below) |
| `posted_at`, `posted_by` | set exactly once, at post |
| `reversed_at`, `reversed_by`, `reversal_reason` | set exactly once, at reversal |
| `cancelled_at`, `cancelled_by` | set exactly once, at cancel |
| `create_idempotency_key`, `post_idempotency_key`, `reverse_idempotency_key` (+ `_fingerprint` each) | each `UNIQUE (tenant_id, …)` where not null |

**015 `sales_invoice_lines`** — **insert-only**. `(tenant_id, invoice_id, revision, line_no)`
unique; `kind` `CHECK = 'SERVICE'`; `description` 1–500; `quantity`, `unit_price` > 0;
`line_net` numeric(19,4). A draft save inserts a complete new revision and bumps
`sales_invoices.lines_revision`, and the current lines are those with `revision = lines_revision`.
Old revisions are left in place and never read. This keeps lines insert-only without a `DELETE`
grant, and without money in `jsonb`, which rule 6 forbids. A trigger allows an insert only while
the parent is `DRAFT` and only at `lines_revision + 1`. Posting freezes the revision.

**016 `customer_receipts`**

| Column | Type / rule |
|---|---|
| `customer_id` | FK → customers, not null (a draft needs a customer) |
| `status` | `DRAFT` \| `POSTED` \| `REVERSED` \| `CANCELLED` |
| `number` | text, null while `DRAFT`/`CANCELLED`; `UNIQUE (tenant_id, number)`; `CHECK (status in ('POSTED','REVERSED')) = (number is not null)` |
| `receipt_date` | date, not null (defaults to today on create) |
| `method` | `CASH` \| `BANK`, **nullable while `DRAFT`**, not null once posted (CHECK) |
| `amount` | numeric(19,4) > 0, **nullable while `DRAFT`**, not null once posted (CHECK) |
| `reference` | text, nullable, ≤ 100 — bank reference or slip number |
| `narration` | text, nullable, ≤ 500 |
| `proposals_revision` | int — the current revision of `customer_receipt_draft_allocations` |
| `posted_at/by`, `reversed_at/by`, `reversal_reason` | as invoices |
| `cancelled_at`, `cancelled_by` | set exactly once, at cancel |
| `create_idempotency_key`, `post_idempotency_key`, `reverse_idempotency_key` (+ `_fingerprint` each) | each `UNIQUE (tenant_id, …)` where not null |

**016 `customer_receipt_draft_allocations`** — **insert-only**, the proposals.
`(tenant_id, receipt_id, revision, invoice_id)` unique; `invoice_id` FK → invoices (composite);
`amount` numeric(19,4) > 0. Same revision scheme as invoice lines: an insert is allowed only while
the parent is `DRAFT` and only at `proposals_revision + 1`, and the current proposals are those
at `revision = proposals_revision`. Never read by any outstanding or reconciliation query.

**016 `customer_receipt_allocations`** — `receipt_id` FK → receipts, `invoice_id` FK → invoices
(both composite), `amount` numeric(19,4) > 0, `status` `LIVE` | `VOIDED`, `voided_at`,
`voided_by`. Rows are inserted only by `PostReceipt`, while the parent goes `DRAFT → POSTED` in
the same transaction. A trigger allows `LIVE → VOIDED` only while the parent receipt is
transitioning to `REVERSED` in the same transaction. **A deferred constraint trigger asserts
Σ allocations = receipt.amount at commit.** This is the one subledger rule the database can check
for itself, so it does.

The journal entry of a document is **not** stored on the document. It is found through the
kernel's `UNIQUE (tenant_id, source_type, source_id)`. A second pointer would be a copy that can
disagree, and writing it would add an `UPDATE` after the posting call.

## 8. Audit records — same transaction, every transition

Written with `recordAudit(tx, …)` ([ADR-0020](../../adr/ADR-0020-audit-hash-chain-canonicalisation.md)).
Money is serialised as strings at scale, so every leaf is JCS-safe. The kernel writes its own
record for each entry and each reversal. The records below are the module's document records, in
addition to the kernel's ([reversal.md](../../posting-rules/reversal.md) §8).

| `action` | `entityType` | before → after |
|---|---|---|
| `customer.created` | `customer` | null → full record, including the generated `code` |
| `customer.updated` | `customer` | changed fields only → changed fields only |
| `customer.deactivated` / `customer.reactivated` | `customer` | `{status}` → `{status}` |
| `sales_invoice.draft_created` / `draft_updated` | `sales_invoice` | header + lines of the previous / new revision |
| `sales_invoice.draft_cancelled` | `sales_invoice` | `{status: DRAFT}` → `{status: CANCELLED}` |
| `sales_invoice.posted` | `sales_invoice` | `{status: DRAFT}` → `{status, number, netAmount, journalEntryId}` |
| `sales_invoice.reversed` | `sales_invoice` | `{status: POSTED}` → `{status, reason, reversalEntryId}` |
| `customer_receipt.draft_created` / `draft_updated` | `customer_receipt` | header + proposals of the previous / new revision |
| `customer_receipt.draft_cancelled` | `customer_receipt` | `{status: DRAFT}` → `{status: CANCELLED}` |
| `customer_receipt.posted` | `customer_receipt` | `{status: DRAFT}` → `{status, number, customerId, method, amount, allocations[], journalEntryId}` |
| `customer_receipt.reversed` | `customer_receipt` | `{status: POSTED}` → `{status, reason, reversalEntryId, voidedAllocations[]}` |

The audit call is the **last** statement of every unit of work, as position 6 requires.

## 9. Idempotency

| Operation | Key | Stored on | Replay (same key, same fingerprint) | Same key, different request |
|---|---|---|---|---|
| Create customer | `Idempotency-Key` header | `customers.create_idempotency_key` | the created customer, `201` | `409 IDEMPOTENCY_KEY_REUSED` |
| Create invoice draft | header | `sales_invoices.create_idempotency_key` | the draft, `201` | `409 IDEMPOTENCY_KEY_REUSED` |
| Post invoice | header | `sales_invoices.post_idempotency_key` **and** the kernel's key table | the posted invoice, `200` | `409 IDEMPOTENCY_KEY_REUSED` |
| Create receipt draft | header | `customer_receipts.create_idempotency_key` | the draft, `201` | `409 IDEMPOTENCY_KEY_REUSED` |
| Post receipt | header | `customer_receipts.post_idempotency_key` **and** the kernel | the posted receipt, `200` | `409 IDEMPOTENCY_KEY_REUSED` |
| Reverse invoice / receipt | header | `*.reverse_idempotency_key` **and** the kernel | the reversed document, `200` | `409 IDEMPOTENCY_KEY_REUSED` |
| Update / cancel draft, update customer | none; optimistic `version` | — | — | `409 VERSION_CONFLICT` on a stale version |

- **Customer create depends on its key.** With system-generated codes, the key is the only thing
  that stops a double-click from creating `CUST-000007` and `CUST-000008` for the same business.
  There is no natural key left to collide on.
- The **module** answers a replay before it reaches the kernel (§4, at the step that locks the document). The kernel's
  own idempotency (step 2 of ADR-0005) is the second line of defence. Both use the same client
  key, so a module bug that let a retry through would get the kernel's `REPLAYED`, never a second
  entry.
- **Fingerprint** = SHA-256 of the JCS serialisation of the parsed, normalised command, plus the
  route and the target id. The serialiser is the one the audit chain uses (`jcsSerialize`); M3-P
  exports it from `@finsoft/database`'s index if it is not already exported.
- The key format is the kernel's: 1–128 characters, `[A-Za-z0-9._:-]`. The UI generates one UUID
  per form instance (the `IdempotencyGuard` component).
- A replay responds with the header `Idempotent-Replayed: true` and the **current** state of the
  document. A retried post of an invoice that has since been reversed therefore shows it as
  reversed, which is the truth.

## 10. Numbering and locks

**Numbers.** `INV-{FY}-{NNNNNN}` and `RCT-{FY}-{NNNNNN}` come from `document_sequences` through the
kernel (K3), in the posting transaction, after the module's own validation. A rejection anywhere
later, including inside the kernel, rolls the transaction back, so no number is consumed and the
series is gapless on the success path (rule 12; [posting-rules README](../../posting-rules/README.md)
§4 "Numbering"). Drafts and cancelled drafts, invoice and receipt alike, are never numbered.

**Customer codes — decided.** The Product Owner decided on 2026-09-28 (M3-Q2) that codes are
system-generated. `CreateCustomer` takes the next number of the tenant's **`CUST`** series from
`document_sequences` through the kernel's facility (K7) in the create transaction:
`CUST-000001`, `CUST-000002`, …. A rolled-back create consumes no number. The code is immutable
and unique per tenant.

- **One series per tenant, not per fiscal year.** A customer code is the permanent identity of a
  master record. It is not a document dated inside a period. With a per-year series, `CUST-000001`
  would recur every July, and the code would need the year in it to stay unique (`CUST-2027-…`).
  A customer created in 2026 would then still read "2027" a decade later, a date that means
  nothing about the customer. Creating a customer is also not a posting, so it has no period to
  resolve and nothing to gain from the FY facility. This is why K7 needs a series with no
  fiscal-year scope in migration 013.
- **Six digits, like every other series.** The PO's example was `CUST-0001`. Six digits match
  the `NNNNNN` width of every document series ([posting-rules README](../../posting-rules/README.md)
  §4), give 999,999 codes before the width grows, and keep lexical order equal to creation order.
  Past `CUST-999999` the number simply gets longer. It is never truncated and never wraps.
- Using the kernel's numbering facility from `customers` is a module calling a kernel, which is
  allowed. It is the same row-locked counter, so it is at lock position 5a (below).

**Lock order — to be entered in [LOCK_REGISTRY.md](../../LOCK_REGISTRY.md) by M3-P's PR** (this
seat owns the register; the Database seat reviews the SQL):

| New position (before today's #2) | Lock | Mode | Taken by |
|---|---|---|---|
| **1a** | `customers` row | `FOR SHARE` (posting) · `FOR UPDATE` (deactivate, reactivate, update) | `requireActiveForPosting`, customer mutations |
| **1b** | `customer_receipts` row | `FOR UPDATE` | `PostReceipt`, `ReverseReceipt`, receipt draft update and cancel |
| **1c** | `sales_invoices` rows | `FOR UPDATE`, **ascending `id`, one statement per row** (the migration-008 lesson: `ORDER BY … FOR UPDATE` does not fix acquisition order) | `PostInvoice`, `PostReceipt`, `ReverseInvoice`, `ReverseReceipt`, draft update and cancel |
| **1d** | `customer_receipt_allocations` rows of one receipt | row locks of the `LIVE → VOIDED` `UPDATE` (a single statement) | `ReverseReceipt` only, and only while holding 1b |
| 2–4 | stock (future) | | Wave 5+. Document rows come first, so a Wave 7 stock sale keeps this order |
| **5a** | `document_sequences` row of a **document** series (`INV`, `RCT`) or of the master series `CUST` | `FOR UPDATE` | `documentNumbers.next` (`CUST` only in `CreateCustomer`, which takes no other 5a row) |
| **5b** | `document_sequences` row of an **entry** series (`JE`, `RV`, `JV`) | `FOR UPDATE` | inside `post` / `reverseForSource` |
| 6 | audit, terminal | | `recordAudit` |

A transaction takes at most one 5a row and one 5b row, 5a first. No transaction in §4 takes any
lock out of this order. Two reads are not locks and so are not ordered: §4.1 step 0 and the
unlocked outstanding sum in §4.2 step 5, which runs under the 1c locks. Note that
`FOR SHARE` on `customers` (1a) conflicts with the `FOR UPDATE` of a deactivation. That is the
point: a deactivation waits for in-flight postings, then reads the balance they produced. The concurrency tests in [README](README.md) §7 prove it with two
connections.

**Isolation.** `READ COMMITTED` with the explicit locks above ([ARCHITECTURE](../../ARCHITECTURE.md)
§7). The outstanding computation (§4.2 step 5) runs **after** the invoice locks, so it sees every
committed allocation to those invoices.

## 11. Where the query code lives — ruling

**Module tables are queried in `modules/<module>/infrastructure/`, and nowhere else.**

- [ADR-0013](../../adr/ADR-0013-kysely-and-sql-migrations.md) allowlists query construction in
  `modules/*/infrastructure/**`, and `kysely-is-allowlisted` in `.dependency-cruiser.cjs` already
  encodes it.
- [ADR-0023](../../adr/ADR-0023-pre-tenant-authentication-reads.md) A1 (as widened) put the auth
  and RBAC query bodies in `packages/database` for one reason: `packages/auth` and
  `packages/permissions` are **not** on the allowlist, and their tables are platform tables. It
  also rejected, in A4, "growing `packages/database` into a domain package". Neither reason applies
  to a module. Its infrastructure layer **is** on the allowlist, and its tables are business
  tables. So nothing M3 writes goes into `packages/database`, except the one export of
  `jcsSerialize` (§9).
- Repositories extend `BaseRepository` from `@finsoft/database` (tenant predicate from context,
  `TenantTx` only, no delete), map rows to domain objects by hand (ADR-0013, no `CamelCasePlugin`),
  and turn `numeric` strings into `Money` / `Quantity` / `UnitCost` at the mapper.
- `application/`, `api/` and `domain/` construct no queries. This is enforced by the lint
  extension in [README](README.md) §5 item 3, because a `TenantTx` passed as a parameter is
  invisible to dependency-cruiser.
- **Kernel ledger queries** (K5) run in the kernel or in `packages/reporting`, whichever M2-A
  chooses. The customers module calls them; it does not write its own `journal_lines` query.
  Invariant 9's SQL lives in `tests/accounting/`, where reading any table is allowed.

## 12. Errors

The domain throws typed errors carrying a stable `code` and a `details` object. The kernel's
`PostingError` has the same shape. The module's `api/` error table maps each code to an HTTP status
([api-contract.md](api-contract.md) §3). A domain error never carries a message meant for users.
The UI owns the copy, keyed by code ([ui-plan.md](ui-plan.md) §4).

## 13. What M3 does not introduce

- **No outbox rows.** M3 has no external side effect: no email, no PDF, no push. So it has no
  outbox topic, and nothing leaves the transaction ([ADR-0019](../../adr/ADR-0019-transactional-outbox.md)).
- **No domain events between modules.** The only cross-module traffic is the synchronous
  `CustomerDirectory`, inside the caller's transaction.
- **No cached balances**, no stored outstanding, no stored settlement status.
- **No feature flags.** The `STOCK` line kind and `CASH` settlement are refused by the kernel rule
  (`SALE_LINE_KIND_NOT_ENABLED`, `SALE_SETTLEMENT_NOT_ENABLED`), and the module's request schema
  does not even accept them. When Wave 7 enables them, the schema changes; no flag is toggled.
