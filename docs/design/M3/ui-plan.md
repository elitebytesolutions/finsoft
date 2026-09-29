# M3 → M4 UI plan

Part of the [M3 design pack](README.md). M4 turns the journey screens from prototypes into
API-backed screens ([PRD](../../PRD.md) §6.1: "a screen counts as delivered only when it runs
against the real API on staging"). This document decides which screens, what changes in each page
document, and what stays prototype. It is written for the M4 lane and the `design-system` agent,
and it builds nothing.

**Order of work, per screen** (the `finsoft-screen` skill): amend the page document first, then
build. A page document that still describes stock, GST and batches while the screen posts a
service invoice is the drift the skill exists to prevent.

---

## 1. Rules for every API-backed screen

1. **No mock data on an API-backed screen.** A panel, tab, KPI or column with no M3 endpoint
   behind it is **removed** from that screen in M4. It is not left on mock data under a banner.
   A page that mixes posted figures with `apps/web/src/mocks` figures invites the user to read a
   demo number as a posted one, which the skill forbids outright.
2. **The browser computes no money.** Totals, line nets, allocated and unallocated amounts,
   outstanding figures, balances and settlement status all come from the API (I6, R2 and the read
   endpoints). The ESLint ban on decimal libraries in `apps/web` already blocks the tempting
   shortcut.
3. **Dr/Cr from the sign is formatting.** Signed balances arrive debit-positive. The screen shows
   the absolute value with `Dr`/`Cr` and the `--money-debit` / `--money-credit` tokens, and zero as
   an em dash in ledger columns.
4. **One idempotency key per form instance** (`IdempotencyGuard`), reused for every retry of that
   submission and replaced only when the user starts a new document.
5. **Actions follow capabilities** from `GET /api/me/permissions`
   ([api-contract.md](api-contract.md) S1). A hidden button is a courtesy. The server decides.
6. **Data access** goes through the M1-W API client (`apps/web/src/lib/api/`). Types come from
   `packages/shared-types`. No screen imports a module or a kernel (`web-is-ui-only`).

## 2. Screens that become API-backed in M4

| Route | Page document | Endpoints | Journey step |
|---|---|---|---|
| `/customers` | [customers](../../design-system/pages/customers/README.md) | C1, C2 | customer |
| `/customers/:id` | [customer-detail](../../design-system/pages/customer-detail/README.md) | C3–C7, I1, R1, `GET /api/audit` | customer ledger |
| `/sales` | [sales-register](../../design-system/pages/sales-register/README.md) | I1 | (drafts' home) |
| `/sales/voucher` and `/sales/voucher/:id` | [sales-voucher](../../design-system/pages/sales-voucher/README.md) | C1 (picker), I2, I4, I5, I6, I7 | service invoice |
| `/sales/:id` | [sales-invoice-detail](../../design-system/pages/sales-invoice-detail/README.md) | I3, I8 | reversal |
| `/payments` | [payments-centre](../../design-system/pages/payments-centre/README.md) | C1 (picker), I1 `open=true`, R1–R5 | payment, reversal |

The trial balance, the account ledger, the journal entry view and the audit trail are M2 and M1
screens. M3 postings appear in them without any change to those screens.

**Why `/sales` is included.** A saved draft needs somewhere to be found again, and the customer
detail's Invoices tab only lists by customer. The register is the list the voucher's "Save draft"
returns to.

## 3. What changes in each page document

### customers (`/customers`)

- **Permission:** `master:create` → `customer.create`; `master:edit` → `customer.create`
  (MVP mapping, [api-contract.md](api-contract.md) §2); module guard `Masters` unchanged.
- **Columns (M4):** Code · Name · City · Phone · **Balance (Rs)** (server `balance`, Dr/Cr) ·
  Status · Actions. **Removed:** Type, Dealing Person, NTN # column (NTN stays on the record),
  Area, Salesman.
- **KpiRow removed.** "Total outstanding" and "Over limit" are sums and credit-limit figures that
  have no endpoint.
- **Create:** the four-step wizard becomes **one form**: code, name, phone, email, address, city,
  NTN, credit days. **Removed:** type, filer status, STRN, route, area, salesman, price list,
  credit limit, **opening balance** (`OPENING_BALANCE_LOADED` has no posting rule, so it cannot be
  offered), Import and Export.
- **Actions:** View · Ledger (→ detail, Ledger tab) · New invoice (→ `/sales/voucher?customer=:id`)
  · Record receipt (→ `/payments?customer=:id`) · Edit · Deactivate / Reactivate. Deactivate
  confirms, and on `CUSTOMER_HAS_BALANCE` quotes the balance. Delete is still never offered.
- **Status tones:** Active `good` · Inactive `neutral`. "On hold" is removed; holds are not in
  the MVP.
- **Answers its open question 1:** code is user-entered, upper-cased and immutable (Q2 in
  [open-questions.md](open-questions.md), default). Answers **3:** a single `AR_CONTROL` account
  with a party dimension (ADR-0026), and no GL account per customer.

### customer-detail (`/customers/:code` → **`/customers/:id`**)

- **Route changes to the id.** API ids are uuids, and a code-keyed route needs a lookup that
  returns nothing an id route does not. Codes are immutable, so a code-to-id redirect can be added
  later if bookmarks demand it.
- **RecordHeader:** name · code · status · [New invoice] [Record receipt] [Edit] [More ▾:
  Deactivate/Reactivate]. **KpiRow:** **Outstanding** only (`balance` with `balanceAsOf`, and
  equal to the Ledger tab's closing balance **by construction**, since both come from K5).
  Credit limit, Available credit and Last payment are removed.
- **Tabs (M4):** Overview (the C3 fields) · **Ledger** (C7) · **Invoices** (I1 `customerId`,
  including drafts, with Number · Date · Due · Net · Outstanding · Settlement · Status) ·
  **Receipts** (R1 `customerId`: Number · Date · Method · Amount · Status) · **Activity**
  (`GET /api/audit?entityType=customer&entityId=:id`). **Removed:** Returns, Credit.
- **Ledger tab** follows [account-ledger](../../design-system/pages/account-ledger/README.md):
  Date · Entry · Source (INV-/RCT-, linked) · Narration · Debit · Credit · Balance, opening row
  labelled, reversal markers ("reversed by RV-…", "reverses JE-… — reason"). "Hide reversed"
  hides both lines of a pair and states that it did. `from`/`to` pickers; a range over 366 days
  shows the `LEDGER_RANGE_TOO_LARGE` copy.
- **Ageing `Days` column removed** (ageing is not in the MVP).

### sales-register (`/sales`)

- **Permission:** create needs `invoice.create`; guard `Sales & POS` unchanged.
- **Columns (M4):** Invoice (number, or "Draft") · Date · Customer · Net · Outstanding ·
  Settlement (`OPEN` `neutral` · `PARTIALLY_PAID` `warn` · `PAID` `good`) · Status (`DRAFT` `warn`
  · `POSTED` `good` · `REVERSED` `danger` · `DISCARDED` `neutral`). **Removed:** Mode,
  Product/lines, Quantity, KpiRow, salesman and branch filters, Export, Print.

### sales-voucher (`/sales/voucher`) — **service line mode**

- **Posts to the ledger:** "yes — revenue, receivable/cash, tax, COGS and stock" → "**yes —
  Service Revenue and Accounts Receivable (customer) only**". The module raises `SALE_POSTED`
  with service lines ([service-sale.md](../../posting-rules/service-sale.md)).
- **Permission:** `sale:create` → Save draft `invoice.create`; Save & Post `invoice.post`.
- **Routes:** `/sales/voucher` (new; `?customer=:id` pre-selects) and **`/sales/voucher/:id`**
  (edit a draft; a non-draft id redirects to `/sales/:id`).
- **DocNumberStrip:** Invoice No shows "Assigned on posting" until posted, then the server
  number. Invoice date (default today from the server) and due date (default from credit days,
  editable). **Removed:** Sale No (Auto), PO No/Date, Bill Book No.
- **FormSection:** customer (picker over C1, active only) and narration. **Removed:** the whole
  "Fulfillment & Sales Team" section, and area/city/address echo.
- **LineItemGrid, service mode:** `#` · **Description** * · **Qty** · **Rate** · **Net amount**
  (read-only, from I6) · ✕. **Removed:** product, pack, batch/expiry, bonus, gross, disc %, GST %,
  net rate, ItemEntry and every product button. §4 "Line grid rules" is replaced by: *lines are
  free-text services; quantity and rate > 0; net amount is computed by the server and refreshed
  after each edit (debounced I6 call); at most 200 lines.*
- **TotalsBar:** Lines · **Net amount** (from I6), and nothing else.
- **LedgerPreview removed.** Knowing which accounts a sale posts to is the kernel's knowledge, and
  a browser-built preview would be the browser constructing journal lines. After posting, the
  detail page shows the real entry.
- **Validation before post (§5)** becomes: customer, ≥ 1 line, every line with description, qty
  and rate > 0, date not in the future, date in an open period (from M2's period endpoint). Each
  failure names itself. The server re-checks all of them.
- **Actions:** Save Draft (I2/I4) · **Save & Post** (I4 then I7, one idempotency key for the post;
  the confirm dialog quotes the server's net amount, customer, date and period verbatim) ·
  Discard draft (I5, confirm). **Removed:** Print, Estimate.
- **States (§8)** become the service set in §4 below. Stock, expiry and credit-limit states are
  removed.

### sales-invoice-detail (`/sales/:id`)

- **PostingStrip:** Draft → Posted → Reversed, with **settlement** shown beside Posted
  (`Open` / `Partially paid` / `Paid`, from the server). Settlement is not a posting status and the
  strip must not present it as one.
- **DefinitionGrid:** Invoice date · Due date · Customer · Narration · Created by · Posted by / on
  · Journal entry (JE-…, linked to M2's entry view).
- **LineTable:** Description · Qty · Rate · Net amount. **TotalsCard:** Net (and amount in words,
  rendered from the server string).
- **PaymentPanel:** the invoice's allocations: Receipt · Date · Amount · Status (`LIVE` /
  `VOIDED`, voided rows struck through but shown) · then **Outstanding** from the server.
- **LedgerImpact:** the **actual** journal entry lines, from M2's entry endpoint by
  `journalEntry.id`, and after a reversal the reversal entry beside it. It is never derived.
- **Removed:** StockPanel, Create return, Print, Export, Attachments.
- **Actions by status:** Draft → Edit (→ `/sales/voucher/:id`), Post, Discard. Posted → Record
  receipt (→ `/payments?customer=…&invoice=…`), **Reverse**. Reversed → banner linking RV-….
  Discarded → no actions.
- **Reverse dialog:** requires a reason (1–500), and needs `invoice.post` + `voucher.reverse`. If
  `reversalBlockedBy` is non-empty, the button is disabled and says so: "Receipts RCT-… are
  allocated to this invoice. Reverse them first." Each receipt number links to it (PO-Q1 Option A).
- **Correct the date rule (§6).** "Closed period → reversal is offered into the first open
  period" contradicts [reversal.md](../../posting-rules/reversal.md) §4. It becomes: *the reversal
  is dated the invoice's own date while its period is open, and today otherwise. If today's
  period is closed, reversal is refused.* The dialog states the rule in those words. It does not
  compute the date itself.
- Its open question 1 (partial return) and 3 (dispatch status) remain open; neither is M4.

### payments-centre (`/payments`) — **receipt mode only**

- **Permission:** `payment:create` → `payment.receive`. Reverse → `payment.receive` +
  `voucher.reverse`.
- **ModeSwitch removed.** Supplier payments are Wave 6. The page is titled "Receipts" in M4, and
  the Payment mode returns with AP.
- **FormSection:** customer (picker) · receipt date · **method: Cash / Bank** (segmented; Cheque
  is Wave 3) · reference · narration. **Removed:** paid-to account (the method decides it, and the
  kernel resolves the role), instrument no.
- **MoneyPanel:** Amount received only. **Removed:** withholding tax and other deductions.
- **AllocTable:** rows from I1 `open=true`. Ref · Date · Due · Net · Outstanding · **Allocate** ·
  Balance after. **Balance after** and every total come from R2, which is called on each change
  (debounced). "Auto-allocate oldest first" calls R2 **without** allocations and loads its
  suggestion into the cells for the user to review. "Clear allocations" empties them.
- **§4 Allocation rules, replaced:** *the receipt must be allocated in full: Unallocated must be
  exactly zero to post (advances are not in the MVP); allocating more than an invoice's
  outstanding is refused at the cell with the outstanding shown; an invoice dated after the
  receipt date cannot be allocated.* The **on-account remainder, and the "no open invoices → post
  as on-account credit" state, are removed.** With no open invoices the page says "This customer
  has nothing outstanding. Receipts are recorded against invoices." and disables posting.
- **Actions:** **Save & post** (R3; the confirm dialog quotes customer, amount, method, date,
  period and each allocation from R2 verbatim). **Save draft removed**: receipts have no draft
  state (Q1 in [open-questions.md](open-questions.md), default). Print removed.
- **Register** below: R1 with Number · Date · Customer · Method · Amount · Status, and a row
  action **Reverse** (confirm with reason). The confirm notes that the receipt's allocations will
  be voided and the invoices' outstanding restored.

## 4. Required states

Every data surface has the four standard states ([04-states.md](../../design-system/04-states.md)):
skeleton loading, explained empty, error with a next step, denied. On top of those, each error code
the screen's endpoints can return gets **its own copy**. None falls through to a generic "something
went wrong" (sales-voucher §8 already demands this).

| State | Screens | Behaviour |
|---|---|---|
| **Not found** (404, including another tenant's id) | detail pages | The shared Not found state. It never says "belongs to another tenant" |
| **Denied** (403) | all | The shared Denied state. Actions hidden by S1 in the first place |
| `VERSION_CONFLICT` | voucher (draft), customer edit | "Changed by someone else since you opened it" · [Reload], keeping the user's unsaved input visible for copying |
| `CUSTOMER_INACTIVE` | voucher, receipts | Names the customer; links to reactivate for holders of `customer.create` |
| `PERIOD_CLOSED` / `PERIOD_LOCKED` / `PERIOD_NOT_FOUND` / `DATE_IN_FUTURE` | voucher, receipts, both reversals | Names the date and period. Post is disabled up front when M2's period endpoint says the period is not open; drafts stay allowed |
| `SALE_*` | voucher | Per line, on the offending line; `SALE_AMOUNT_MISMATCH` from the kernel is shown as an internal error, because it is a bug |
| `ALLOCATION_EXCEEDS_OUTSTANDING` | receipts | On the cell, with the server's current outstanding. Another receipt got there first, so the table reloads |
| `INVOICE_NOT_OPEN` / `ALLOCATION_*` / `RECEIPT_UNALLOCATED_AMOUNT` | receipts | On the row or in the totals bar |
| `INVOICE_HAS_LIVE_ALLOCATIONS` | invoice detail | Pre-empted by `reversalBlockedBy`. If raised anyway (race), the same copy with the receipt links |
| `ALREADY_REVERSED` / `SOURCE_ALREADY_POSTED` | detail pages, voucher | "Already done", then reload into the current state. Not an error tone |
| Replay (`Idempotent-Replayed: true`) | every submit | Identical to success. The user never sees that it was a retry |
| `AUDIT_BUSY` (503) | every submit | Automatic retry once after `Retry-After` **with the same key**, then "Busy, try again" |
| `ACCOUNT_ROLE_*` | voucher, receipts | "Accounting setup incomplete — contact your administrator". Not retryable |
| Network failure mid-submit | every submit | The form stays intact. Retry resubmits **with the same key**, so a request that did land is replayed, not duplicated |

## 5. What stays prototype in M4

Still on mock data, still behind the M1-W prototype banner, and **not** part of the acceptance
demo:

| Screen / part | Why | Becomes real in |
|---|---|---|
| `/receivables` (ageing, customer balances, credit invoices) | Ageing is not in the MVP. The screen's product/qty columns are stock concepts | Wave 4 |
| `/cash-transactions`, `/cash-book` | Cash receipts from customers are recorded on `/payments` with method Cash. A general cash voucher is Wave 3 | Wave 3 |
| `/credit-limits` | Credit limits and holds are not in the MVP | Wave 4 |
| `/sales-returns` | `SALE_RETURNED` has no posting rule | Wave 7 |
| Payment (supplier) mode of `/payments`; `/payables` | AP | Wave 6 |
| Printing of invoices and receipts; customer statements | Outbox + PDF, not in the MVP | Wave 4 / 7 |
| Customer import / export | Not in the MVP | Wave 10 (import) |

These parts are **removed** from the API-backed screens rather than kept as mock panels on them
(rule 1 in §1).

## 6. The M4 journey test

Playwright, on staging, run once for `BHATTI1` and once for `BHATTI2`, asserting P09's figures
through the screens:

1. Log in (tenant code, email, password) as an Accountant.
2. `/customers` → create `CUST-A`.
3. `/sales/voucher?customer=…` → two service lines (1 × 7,500.000000; 3 × 833.333333). The server
   shows 7,500.0000 and 2,500.0000, net 10,000.0000 → Save & Post → `/sales/:id` shows
   `INV-2027-000001`, Posted, Open, JE-2027-00000n.
4. `/payments?customer=…` → 6,000.0000 by Bank, allocated to the invoice → post → `RCT-…`.
   The invoice shows Partially paid, outstanding 4,000.0000.
5. `/customers/:id` Ledger tab → closing 4,000.0000 Dr, equal to the KPI.
6. Trial balance (M2) balances. 1200 shows 4,000.0000 Dr.
7. `/sales/:id` → Reverse is disabled, naming the receipt.
8. Reverse the receipt on `/payments`, then the invoice on `/sales/:id`, each with a reason.
9. Ledger closes at 0.0000. The trial balance shows the reversed pairs netting to zero.
10. Audit trail shows every step. Logging into the other tenant shows none of it.
11. As a Viewer: every screen above is readable, and no mutating action is offered. A forced
    request returns 403.
