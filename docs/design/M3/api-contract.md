# M3 API contract

Part of the [M3 design pack](README.md). This is what M3-C and M3-P implement and what M4's screens
consume. The response types go in `packages/shared-types` (the only place `apps/web` may import
them from). The request zod schemas go in each module's `api/` layer. OpenAPI is generated from
the controllers and must list every error code a route can return.

---

## 1. Conventions — every M3 route

| | |
|---|---|
| **Base** | `/api` (global prefix). JSON only |
| **Tenant** | From the session, always. No route accepts a tenant in the path, query, body or a header. Request schemas are **strict**: an unknown key, `tenantId` included, is `400 VALIDATION_FAILED`. This is the Architecture seat's recommendation on BOARD "Decisions needed" (ADR-0004 rule 2). If the Council closes it the other way, only the schema mode changes |
| **Money** | Decimal **strings**. Responses always carry exactly 4 dp (`"10000.0000"`). Requests accept up to 4 dp (`"6000"`, `"6000.5"`) and are normalised by `Money.from`. More than 4 dp is `AMOUNT_SCALE` and a JSON number is `AMOUNT_NOT_STRING`, both `400`. Never rounded on the way in ([ADR-0011](../../adr/ADR-0011-money-representation.md), [ADR-0014](../../adr/ADR-0014-decimal-js.md)) |
| **Quantity, unit price** | Strings, up to 6 dp in, exactly 6 dp out (`"3.000000"`, `"833.333333"`) |
| **Signed balances** | Debit-positive strings: `"-6000.0000"` is a 6,000 **credit** balance ([ledger-and-trial-balance.md](../../posting-rules/ledger-and-trial-balance.md) §2). The UI shows the absolute value with `Dr`/`Cr`, which is formatting, not arithmetic |
| **Dates** | Business dates are `YYYY-MM-DD` in the tenant timezone. Instants are ISO-8601 UTC with `Z` |
| **Ids** | uuid. A path id that is unknown **or belongs to another tenant** is the same `404` with the same body |
| **Idempotency** | Every `POST` that creates a document or changes its status requires the header `Idempotency-Key` (1–128 characters, `[A-Za-z0-9._:-]`). Missing → `400 IDEMPOTENCY_KEY_REQUIRED`. A replay returns the original status code, the document's current state and `Idempotent-Replayed: true`. See [modules.md](modules.md) §9 |
| **Optimistic concurrency** | Draft edits and draft cancel (invoices and receipts), invoice and receipt post, and customer edits carry the `version` the client last read. Stale → `409 VERSION_CONFLICT` with `details.currentVersion` |
| **Pagination** | Cursor. `?limit=` 1–200 (default 50), `?cursor=` opaque. Response `{ items, nextCursor }`, where `nextCursor` is null on the last page. No total count |
| **Errors** | The existing envelope (`apps/api/src/common/all-exceptions.filter.ts`): `{ statusCode, error, message, path, timestamp, details? }`. `error` is the **stable code** from §3. `message` is for logs, not for users; the UI owns the copy per code |
| **Authorisation** | Every M3 route is `@RequirePermission(…)` except **S1**, which is `@AuthenticatedOnly` (§2). None is `@Public`. Enforced by the global `PermissionGuard` that M1-X registers; M3 routes do not merge before it ([README](README.md) §4) |

## 2. Endpoints

Permissions come from the MVP catalogue (`packages/permissions/src/catalog.ts`). Two codes the
full catalogue will need do not exist yet: an edit permission for customers and a view permission
for AR documents. Until they do, **customer edits use `customer.create`, and every AR read uses
`customer.view`**. `customer.view` is what the Viewer role already holds, and it is the natural
permission for reading a customer's documents and ledger. Adding codes is a catalogue change with
seeding for existing tenants. It is recorded as debt ([README](README.md) §10), not slipped in
here. The Security seat confirms this mapping at M3-C's review.

**Receipt drafts and receipt posting both use `payment.receive`** (Product Owner, 2026-09-28).
Invoices already separate `invoice.create` from `invoice.post`. The matching split for receipts
would be a new `payment.post`, which is **proposed as debt** ([README](README.md) §10) rather than
added now. Until it exists, anyone who can prepare a receipt can post it.

Reversal needs **two** permissions: the document's own permission **and** `voucher.reverse`
([reversal.md](../../posting-rules/reversal.md) §3 row 6). `voucher.reverse` is privileged
(`PRIVILEGED_PERMISSIONS`).

### Session capabilities — `apps/api` + `packages/permissions`, lane M3-C

| # | Method · path | Decorator | Success |
|---|---|---|---|
| S1 | `GET /api/me/permissions` | **`@AuthenticatedOnly`** | `200 { permissionVersion: number, permissions: string[] }` — the caller's effective codes, resolved server-side through the same path `PermissionGuard` uses |

M4 needs this. Today the web client has no way to learn which actions to show: `/api/auth/me`
returns `permissionVersion` only, and `web-is-ui-only` forbids `apps/web` from importing
`packages/permissions` (whose own `ui.ts` header records the gap). It is `@AuthenticatedOnly`
because asking for a permission in order to read your own permissions is circular. It is a UI
affordance only, and every route re-checks server-side (rule 18). It is T2 and is reviewed by the
Security seat. It lands in M3-C, rather than in M4, so that the M3 demo can show the Viewer role
being refused.

### Customers — `modules/customers`, lane M3-C

| # | Method · path | Permission | Idem. key | Success |
|---|---|---|---|---|
| C1 | `GET /api/customers` | `customer.view` | — | `200` page of `CustomerListItem` |
| C2 | `POST /api/customers` | `customer.create` | required | `201` `Customer` |
| C3 | `GET /api/customers/:id` | `customer.view` | — | `200` `Customer` |
| C4 | `PATCH /api/customers/:id` | `customer.create` (see above) | — | `200` `Customer` |
| C5 | `POST /api/customers/:id/deactivate` | `customer.create` | — | `200` `Customer` |
| C6 | `POST /api/customers/:id/reactivate` | `customer.create` | — | `200` `Customer` |
| C7 | `GET /api/customers/:id/ledger` | `customer.view` | — | `200` `CustomerLedger` |

### Invoices — `modules/receivables`, lane M3-P

| # | Method · path | Permission | Idem. key | Success |
|---|---|---|---|---|
| I1 | `GET /api/invoices` | `customer.view` | — | `200` page of `InvoiceListItem` |
| I2 | `POST /api/invoices` | `invoice.create` | required | `201` `Invoice` (DRAFT) |
| I3 | `GET /api/invoices/:id` | `customer.view` | — | `200` `Invoice` |
| I4 | `PUT /api/invoices/:id` | `invoice.create` | — (`version`) | `200` `Invoice` (DRAFT) |
| I5 | `POST /api/invoices/:id/cancel` | `invoice.create` | — (`version`) | `200` `Invoice` (CANCELLED) |
| I6 | `POST /api/invoices/calculate` | `invoice.create` | — | `200` `InvoiceCalculation`. Stateless, writes nothing |
| I7 | `POST /api/invoices/:id/post` | `invoice.post` | required | `200` `Invoice` (POSTED) |
| I8 | `POST /api/invoices/:id/reverse` | `invoice.post` **+** `voucher.reverse` | required | `200` `Invoice` (REVERSED) |

### Receipts — `modules/receivables`, lane M3-P

| # | Method · path | Permission | Idem. key | Success |
|---|---|---|---|---|
| R1 | `GET /api/receipts` | `customer.view` | — | `200` page of `ReceiptListItem` (drafts included) |
| R2 | `POST /api/receipts/preview` | `payment.receive` | — | `200` `ReceiptPreview`. Stateless, writes nothing, takes no lock |
| R3 | `POST /api/receipts` | `payment.receive` | required | `201` `Receipt` (**DRAFT**). Posts nothing, no number |
| R4 | `GET /api/receipts/:id` | `customer.view` | — | `200` `Receipt`: proposals for a draft, allocations once posted |
| R5 | `PATCH /api/receipts/:id` | `payment.receive` | — (`version`) | `200` `Receipt` (DRAFT). Draft only |
| R6 | `POST /api/receipts/:id/post` | `payment.receive` | required | `200` `Receipt` (POSTED): number assigned, allocations applied |
| R7 | `POST /api/receipts/:id/cancel` | `payment.receive` | — (`version`) | `200` `Receipt` (CANCELLED). Draft only |
| R8 | `POST /api/receipts/:id/reverse` | `payment.receive` **+** `voucher.reverse` | required | `200` `Receipt` (REVERSED) |

**There is no allocation endpoint.** A draft's **proposals** are part of the draft and are edited
with R5 (`allocations` in the patch replaces the whole proposal set). **Allocations** are embedded
in `Receipt` (as allocated from) and `Invoice` (as allocated to), including voided ones. They are
created only by R6 and voided only by R8 ([customer-receipt.md](../../posting-rules/customer-receipt.md)
§5: no re-allocation and no un-allocation other than reversal). A separate `/allocations`
resource would advertise a mutation that does not exist. An invoice never shows proposals, only
allocations: a proposal has not paid anything.

**Why I6 and R2 exist.** The voucher screen must show line nets and a total while the user types,
and the receipt screen must show "allocated" and "unallocated", plus an oldest-first suggestion.
All of these are money arithmetic, and rule 19 keeps it out of the browser. These two endpoints
run the same domain functions that posting runs, so the figure the user sees is the figure that
posts. Neither is authoritative: posting re-validates everything under locks.

## 3. Error codes

| Code | HTTP | Raised by | `details` |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | any schema failure, unknown key | `{ issues: [{ path, code }] }` |
| `AMOUNT_NOT_STRING` · `AMOUNT_SCALE` | 400 | money, quantity or price in the wrong form | `{ path }` |
| `IDEMPOTENCY_KEY_REQUIRED` · `IDEMPOTENCY_KEY_INVALID` | 400 | header missing or malformed | — |
| *(guard body, unchanged)* | 401 | no or invalid session: `TenantGuard`'s existing response | — |
| *(guard body, unchanged)* | 403 | missing permission: `PermissionGuard`'s existing `{ statusCode: 403, error: 'forbidden', … }` | — |
| `CUSTOMER_NOT_FOUND` | 404 on C3–C7 · **422** when the id is in a request body | customers, directory | `{ customerId }` on 422 |
| `INVOICE_NOT_FOUND` | 404 on I3–I8 · **422** when in `allocations[]` | receivables | `{ invoiceId }` on 422 |
| `RECEIPT_NOT_FOUND` | 404 | R4–R8 | — |
| `VERSION_CONFLICT` | 409 | stale `version`; invoice's customer changed under post | `{ currentVersion }` |
| `IDEMPOTENCY_KEY_REUSED` | 409 | same key, different request | — |
| `CUSTOMER_HAS_BALANCE` | 409 | C5 — deactivation refused while the ledger balance ≠ 0.0000 (customers page doc §6) | `{ balance }` |
| `INVOICE_NOT_DRAFT` | 409 | I4, I5, I7 on a non-draft | `{ status }` |
| `INVOICE_NOT_POSTED` | 409 | I8 on a draft or cancelled invoice | `{ status }` |
| `RECEIPT_NOT_DRAFT` | 409 | R5, R6, R7 on a cancelled receipt; R5 and R7 on a posted one | `{ status }` |
| `RECEIPT_NOT_POSTED` | 409 | R8 on a draft or cancelled receipt | `{ status }` |
| `SOURCE_ALREADY_POSTED` | 409 | I7 / R6 on a document already posted under another key | `{ documentNumber, entryNumber }` |
| `ALREADY_REVERSED` | 409 | I8, R8 under a new key | `{ reversalEntryNumber }` |
| `INVOICE_HAS_LIVE_ALLOCATIONS` | 409 | I8 (PO-Q1 Option A) | `{ receipts: [{ id, number }] }` |
| `CUSTOMER_INACTIVE` | 422 | I2, I4, I7, R3, R5, R6 | `{ customerId }` |
| `SALE_NO_LINES` · `SALE_TOO_MANY_LINES` · `SALE_LINE_NON_POSITIVE` · `SALE_AMOUNT_MISMATCH` | 422 | I7 (domain first, kernel re-checks). `SALE_AMOUNT_MISMATCH` from the kernel is a **500**, because the module computed the figure with the same function | `{ lineNo }` / `{ lineNo, submitted, expected }` |
| `RECEIPT_INCOMPLETE` | 422 | R6 on a draft with no method or no amount | `{ missing: string[] }` |
| `AMOUNT_NON_POSITIVE` · `RECEIPT_NO_ALLOCATION` · `ALLOCATION_DUPLICATE_INVOICE` · `RECEIPT_UNALLOCATED_AMOUNT` | 422 | R6. `AMOUNT_NON_POSITIVE` and `ALLOCATION_DUPLICATE_INVOICE` also on R3 and R5, where the value itself is invalid | `{ amount, allocatedTotal }` for the last |
| `ALLOCATION_PARTY_MISMATCH` · `INVOICE_NOT_OPEN` · `ALLOCATION_INVOICE_AFTER_RECEIPT` | 422 | R6. This is how a **stale draft proposal** surfaces | `{ invoiceId, invoiceNumber }` |
| `ALLOCATION_EXCEEDS_OUTSTANDING` | 422 | R6, read under the row lock. Likewise for a stale proposal | `{ invoiceId, invoiceNumber, outstanding, requested }` |
| `DATE_IN_FUTURE` · `PERIOD_NOT_FOUND` · `PERIOD_CLOSED` · `PERIOD_LOCKED` | 422 | kernel, on I7, R6, I8, R8 | `{ date, period }` |
| `REVERSAL_REASON_REQUIRED` | 422 | I8, R8 | — |
| `LEDGER_RANGE_TOO_LARGE` | 422 | C7, more than 366 days | `{ maxDays: 366 }` |
| `ACCOUNT_ROLE_UNMAPPED` · `ACCOUNT_ROLE_MISCONFIGURED` | 422 **and** an `error`-level log line with an alert | kernel. A tenant configuration fault, never retried | `{ role }` |
| `AUDIT_BUSY` | 503 + `Retry-After: 1` | `AuditLockTimeoutError` (2 s audit lock timeout). Safe to retry **with the same key** | — |
| `INTERNAL` | 500 | anything else, including a kernel `RULE_NOT_ENABLED`, `SALE_SETTLEMENT_NOT_ENABLED`, `SALE_LINE_KIND_NOT_ENABLED`, `REVERSAL_VIA_SOURCE_REQUIRED` or `REVERSAL_OF_REVERSAL` reaching a module path. The module never sends those, so receiving one is a bug, not a user error | — |

Every code a posting rule lists for its event appears above, either as itself or as `INTERNAL`
with the reason stated. M3-Q checks this table against the rule documents' §Errors lists.

## 4. Shapes

TypeScript notation. `Money` = 4 dp string, `Qty` / `Price` = 6 dp string, `LocalDate` =
`YYYY-MM-DD`, `Instant` = ISO UTC. Every field is present in every response. Absent values are
`null`, never omitted.

### 4.1 Customers

```ts
// C2 request                           // C4 request — every field optional except version
{                                       {
  // NO code: it is system-generated (CUST-000001, PO 2026-09-28); sending one is 400
  name: string        // 1–200               version: number
  phone: string | null                  name?, phone?, email?, address?, city?, ntn?, creditDays?
  email: string | null                  // code and status are NOT editable here
  address: string | null              }
  city: string | null
  ntn: string | null
  creditDays: number  // 0–365, default 0    // C5 / C6 request: { version: number }
}

interface Customer {
  id: string
  code: string              // CUST-000001 …, from the tenant's CUST series at create; immutable
  name: string
  phone: string | null; email: string | null; address: string | null; city: string | null
  ntn: string | null; creditDays: number
  status: 'ACTIVE' | 'INACTIVE'
  balance: Money            // signed, debit-positive: GL of AR_CONTROL for this party (K5)
  balanceAsOf: LocalDate    // today, tenant timezone
  version: number
  createdAt: Instant; createdBy: string; updatedAt: Instant; updatedBy: string
}

type CustomerListItem = Pick<Customer,
  'id' | 'code' | 'name' | 'phone' | 'city' | 'status' | 'balance' | 'balanceAsOf'>
```

**C1 query:** `q` (prefix of code, substring of name or phone, case-insensitive), `status`
(`ACTIVE` | `INACTIVE`, default both), `limit`, `cursor`. Order: `code` ascending.

**C7 query and response:**

```ts
// GET /api/customers/:id/ledger?from=YYYY-MM-DD&to=YYYY-MM-DD
// defaults: from = first day of the current fiscal year, to = today (tenant timezone)
interface CustomerLedger {
  customer: { id: string; code: string; name: string }
  from: LocalDate; to: LocalDate
  openingBalance: Money                     // signed; Σ(debit − credit) of lines before `from`
  lines: Array<{
    occurredAt: LocalDate
    entryId: string; entryNumber: string    // JE-… or RV-…
    sourceType: 'sales_invoice' | 'customer_receipt' | 'journal_voucher' | null
    sourceId: string | null
    sourceNumber: string | null             // INV-… / RCT-… (K4)
    narration: string
    debit: Money; credit: Money             // exactly one non-zero
    runningBalance: Money                   // signed, in the order below
    reversedBy: { entryId: string; entryNumber: string } | null    // on the original
    reverses: { entryId: string; entryNumber: string; reason: string } | null  // on the reversal
  }>
  totals: { debit: Money; credit: Money }
  closingBalance: Money                     // = openingBalance + Σ(debit − credit)
}
```

Order: `occurredAt`, then the entry's `created_at`, then entry number. That is the M2 ledger
rule, with its stated intra-day consequence (P09). Every entry is included, `POSTED` and
`REVERSED` alike ([ledger-and-trial-balance.md](../../posting-rules/ledger-and-trial-balance.md)
§1). There is no "hide reversed" parameter in the API. Hiding is a presentation choice, and when
the UI hides it removes both lines of a pair. Not paginated. The range is capped instead. A
journal-voucher line on `AR_CONTROL` cannot exist in the MVP, because `AR_CONTROL` is not
manual-JV eligible ([coa-standard.md](../../posting-rules/coa-standard.md)). The type allows it
for Wave 10.

### 4.2 Invoices

```ts
// I2 request (draft)                        // I4 request: same fields + version, full replacement
{
  customerId: string
  invoiceDate?: LocalDate                    // default today
  dueDate?: LocalDate | null                 // default invoiceDate + customer.creditDays
  narration?: string | null                  // ≤ 500
  lines: Array<{                             // 0–200 on a draft; ≥ 1 to post
    description: string                      // 1–500
    quantity: Qty                            // > 0
    unitPrice: Price                         // > 0
  }>
}
// No kind, no tax, no discount, no settlement field: the schema rejects them (§1 strict).
// Every line is SERVICE and settlement is CREDIT — the module sets both.

// I6 request: { lines: same as above }  →  InvoiceCalculation
interface InvoiceCalculation {
  lines: Array<{ lineNo: number; quantity: Qty; unitPrice: Price; lineNet: Money }>
  netAmount: Money
  problems: Array<{ code: 'SALE_LINE_NON_POSITIVE' | 'SALE_TOO_MANY_LINES'; lineNo: number | null }>
}

// I7 request: { version: number }        I8 request: { reason: string }   // 1–500 after trim

interface Invoice {
  id: string
  number: string | null                          // null while DRAFT / CANCELLED
  status: 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'
  settlement: 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | null   // derived; POSTED only
  customer: { id: string; code: string; name: string }
  invoiceDate: LocalDate; dueDate: LocalDate | null
  narration: string | null
  lines: Array<{ lineNo: number; kind: 'SERVICE'; description: string
                 quantity: Qty; unitPrice: Price; lineNet: Money }>
  netAmount: Money
  outstanding: Money | null                      // null for DRAFT/CANCELLED; "0.0000" when REVERSED
  allocations: Array<{ receiptId: string; receiptNumber: string; receiptDate: LocalDate
                       amount: Money; status: 'LIVE' | 'VOIDED' }>
  journalEntry: { id: string; number: string } | null          // POSTED / REVERSED
  reversal: { entryId: string; entryNumber: string; occurredAt: LocalDate
              reason: string; reversedAt: Instant; reversedBy: string } | null
  reversalBlockedBy: Array<{ id: string; number: string }>     // receipts with LIVE allocations; [] if none
  posted: { at: Instant; by: string } | null
  version: number
  createdAt: Instant; createdBy: string; updatedAt: Instant; updatedBy: string
}

type InvoiceListItem = Pick<Invoice, 'id' | 'number' | 'status' | 'settlement' | 'customer'
  | 'invoiceDate' | 'dueDate' | 'netAmount' | 'outstanding'>
```

`reversalBlockedBy` lets the screen disable "Reverse" with the reason already known. I8 still
enforces it under the lock, so the field is advisory.

**I1 query:** `customerId`, `status` (repeatable), `open=true` (POSTED with outstanding > 0;
**requires `customerId`**; this is the allocation picker's source), `from` / `to` on
`invoiceDate`, `q` (number prefix), `limit`, `cursor`. Order: `open=true` gives **oldest first**
(`invoiceDate`, then `id`), the same order as the preview's suggestion. Otherwise
`invoiceDate` descending, then `number` descending, with drafts by `createdAt` descending.

### 4.3 Receipts

```ts
// R3 request (create draft)               // R5 request: { version } + any field below;
{                                            //   `allocations`, if present, replaces all proposals
  customerId: string                         // R2 request: customerId, receiptDate, amount and
  receiptDate?: LocalDate                    //   optional allocations — or { receiptId } for a draft
  method?: 'CASH' | 'BANK' | null            // null allowed on a draft; required to post
  amount?: Money | null                      // > 0 when present; required to post
  reference?: string | null                  // ≤ 100
  narration?: string | null                  // ≤ 500
  allocations?: Array<{ invoiceId: string; amount: Money }>   // proposals; may be empty on a draft
}
// R6 request: { version: number }           R7 request: { version: number }
// R8 request: { reason: string }            // 1–500 after trim

interface ReceiptPreview {
  openInvoices: Array<{ invoiceId: string; number: string; invoiceDate: LocalDate
                        dueDate: LocalDate | null; netAmount: Money; outstanding: Money }>
  allocations: Array<{ invoiceId: string; amount: Money }>   // as submitted, or suggested
  suggested: boolean                               // true when the request had no allocations
  allocatedTotal: Money
  unallocated: Money                               // amount − allocatedTotal; must be 0.0000 to post
  problems: Array<{ code: string; invoiceId: string | null; details: object | null }>
}

interface Receipt {
  id: string
  number: string | null                            // null while DRAFT / CANCELLED
  status: 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED'
  customer: { id: string; code: string; name: string }
  receiptDate: LocalDate
  method: 'CASH' | 'BANK' | null                   // non-null once POSTED
  amount: Money | null                             // non-null once POSTED
  reference: string | null; narration: string | null
  proposals: Array<{ invoiceId: string; invoiceNumber: string; amount: Money }>   // DRAFT only
  proposalProblems: ReceiptPreview['problems']     // DRAFT only: advisory, computed at read, no lock
  allocations: Array<{ invoiceId: string; invoiceNumber: string; invoiceDate: LocalDate
                       amount: Money; status: 'LIVE' | 'VOIDED' }>   // [] until POSTED
  journalEntry: { id: string; number: string } | null
  reversal: { entryId: string; entryNumber: string; occurredAt: LocalDate
              reason: string; reversedAt: Instant; reversedBy: string } | null
  posted: { at: Instant; by: string } | null
  version: number
  createdAt: Instant; createdBy: string; updatedAt: Instant; updatedBy: string
}

type ReceiptListItem = Pick<Receipt, 'id' | 'number' | 'status' | 'customer' | 'receiptDate'
  | 'method' | 'amount'>
```

The **suggestion** (R2 without allocations) fills the customer's open invoices oldest first, each
up to its outstanding, until `amount` is used up. If the amount exceeds the total outstanding, the
remainder shows in `unallocated` with the problem `RECEIPT_UNALLOCATED_AMOUNT`. The server never
posts a suggestion it was not sent back.

A draft's `proposalProblems` is how the screen warns, **before** the user presses Post, that
another receipt has paid, or a reversal has closed, an invoice the draft proposes to settle. It is
advisory. R6 decides under the locks.

**R1 query:** `customerId`, `status` (repeatable; drafts included unless filtered), `method`, `from` / `to` on `receiptDate`, `q` (number
prefix), `limit`, `cursor`. Order: `receiptDate` descending, then `number` descending.

## 5. OpenAPI and contract tests

- Each controller declares its permission, request schema, success schema and the error codes
  from §3 it can return. M3-C adds a snapshot test of the generated OpenAPI document, which does
  not exist today, so that a contract change shows up as a diff in review.
- M3-Q adds one contract test per route: the happy path, 401, 403, a cross-tenant id (404 or 422
  exactly as §3 says), and every 409/422 the route lists.
