# Payments & receipts

| | |
|---|---|
| **Route** | `/payments` |
| **Archetype** | B — Document entry (with allocation) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · `payment:create` |
| **Prototype source** | `ui-prototype/src/transactions-pages.tsx` (`PaymentsCentre`) |
| **Posts to the ledger** | **yes** — receipts, with invoice allocation (Payments/vendor side out of scope — no payables API exists yet) |

## API note — M4-W2 (2026-10-01)

**Receipt-only, real API.** `PaymentsCentre` (`apps/web/src/screens/transactions-pages.tsx`) is
rewired against `modules/receivables` (R1–R8). The mode switch, paid-to-account field and
withholding-tax field from this doc's §2 are gone: no payables/vendor-payment API exists yet (out
of this task's scope), and `CreateReceiptRequest` has no counterpart for a specific GL account id
or a withholding figure (`method` is `CASH | BANK` only). The "Reports & Filters" card's controls
were already decorative in the mock (none of `cashTab`/`cashTypeFilter`/`cashDateFilter`/
`cashNumberFilter` ever filtered anything) and are kept as inert UI rather than wired to a
reporting endpoint that doesn't exist; the KPI tiles' hardcoded cash-balance figures read "Not
tracked yet" (no cash/bank ledger-balance endpoint in scope) instead of an invented number.

**The allocation table is server-only, end to end.** `openInvoices`, the oldest-first suggestion,
`allocatedTotal` and `unallocated` all come from R2 (`POST /api/receipts/preview`) — nothing here
is summed from the rows client-side. R2's own rule
(`modules/receivables/application/preview-receipt.ts`): it only computes the oldest-first
suggestion when `allocations` is **omitted** from the request entirely (`null`/`undefined`); an
explicit `[]` means "the caller has a plan, and it is empty," and turns the suggestion off. The
dialog tracks whether the user has touched a row (a ref) and omits `allocations` from the request
until they have. The preview effect's dependency is a derived `activeAllocationsKey` (a JSON
string of the active invoiceId+amount pairs), not the `rows` array itself — depending on `rows`
directly would make the effect re-trigger on its own response (a new array reference every
`setRows` call), looping.

**The receipt customer picker includes INACTIVE customers, marked "— Inactive".** Unlike the
invoice picker on `/sales/voucher` (ACTIVE-only — a new invoice isn't raised against an inactive
customer), a receipt *settles* a debt an inactive customer can still owe (ruling R-2); excluding
INACTIVE here would make that balance uncollectable through this screen.

**Post confirms first**, quoting the server's own allocated/unallocated figures and warning
before the server would refuse a nonzero unallocated amount (R6's own validation; this screen
mirrors it for a fast rejection, never decides it). Errors route through the shared
`receivablesErrorMessage` mapper. Recent Receipts is R1, cursor-paginated ("Load more" — no
total count, per the contract).

See [receipt-detail](../receipt-detail/) for the detail page this list's rows (and a posted
receipt) link to.

## 1. Purpose

Record money in from customers and money out to suppliers, **allocated against the specific open
documents it settles**. Allocation is the whole point: an unallocated receipt is an unexplained
credit that surfaces later as a reconciliation problem.

## 2. Anatomy

```
DocHeadBar    "Payments & receipts" · [Save draft] [Save & post] [Print]
ModeSwitch    [ Receipt (from customer) ] [ Payment (to supplier) ]
FormSection   "Payment details": party · date · mode (Cash / Cheque / Bank transfer) ·
              paid from/to account · instrument no · reference · narration
MoneyPanel    Amount received/paid  ·  Withholding tax (u/s 153(1)(b))  ·  Other deductions
AllocTable    "Allocate against open documents"
              ☐ · Ref · Date · Party doc · Total · Already paid · Outstanding · **Allocate** · Balance
              [Auto-allocate oldest first]  [Clear allocations]
TotalsBar     Amount · Allocated · **Unallocated** · Tax withheld · Net to account
Register      "Recent payments & receipts" table below
```

## 3. Components

`SegmentedControl` (mode) · `FormSection` · `PartyPicker` · `AccountPicker` · `MoneyInput` ·
`AllocationTable` (page-local, promotion candidate) · `IdempotencyGuard` · `ConfirmDialog` ·
`DataTable` (register) · `StatusBadge`.

## 4. Allocation rules

- Allocated total may not exceed the amount entered; the `Unallocated` figure is shown at all times
  and turns `--money-negative` if over-allocated.
- An unallocated remainder is permitted but must be **explicitly acknowledged** in the confirm
  dialog ("Rs 5,000 will be posted as an on-account credit"), and it posts to the party's account as
  an on-account balance, never to a suspense account.
- Auto-allocate fills oldest-first and is always reviewable before posting.
- Allocating more than an invoice's outstanding is refused at the cell, with the outstanding shown.
- Withholding tax is entered as its own field, posts to its own account, and is **never** deducted
  from the allocation figures silently — the allocation columns show the gross settled amount.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save draft | secondary | `payment:create` | no | Draft, no ledger effect |
| Save & post | primary | `payment:create` | **yes — party, amount, allocations by document, tax, unallocated remainder, period** | Posts; toast names the voucher; invoices update to Partially paid / Paid |
| Auto-allocate | ghost | — | no | Fills the allocate column |
| Print receipt | secondary | `Cash, Bank & GL` | no | `PrintDocument` |

## 6. Financial rules

- The module raises a payment/receipt event; the posting engine writes the journal.
- Allocation is part of the same transaction as the posting — a posted receipt with lost allocations
  is not a state that can exist.
- Cheque mode creates a **cheque instrument**, not a bank posting; it flows through
  [cheque clearing](../cheque-clearing/).
- Posting into a closed period is refused; drafts remain allowed.
- Idempotent: one key per form instance.

## 7. States

- No open documents for the party: the allocation table shows "No open invoices — this will post as
  an on-account credit" rather than an empty table.
- Over-allocation, unallocated remainder, closed period, missing account — each blocks or warns with
  specific copy.
- Post failure leaves the form intact with allocations preserved.

## 8. Responsive · 9. Accessibility

`md` the form and money panel stack; the allocation table scrolls with Ref sticky ·
`sm` and below: read-only, with "record payments on a desktop".
The Allocate cells are labelled with the document reference; the unallocated figure is `aria-live`.

## 10. Deviations from the prototype

The prototype titles this page "Cash Transactions", colliding with `/cash-transactions`. Production
names it **Payments & Receipts** and keeps the register below the entry form rather than on a
separate screen.

## 11. Open questions

1. Which WHT sections must MVP support beyond 153(1)(b), and are rates configurable?
2. Can one receipt settle invoices across two branches?
3. Is partial allocation against a purchase return / credit note supported here or only in a
   dedicated adjustment screen?
