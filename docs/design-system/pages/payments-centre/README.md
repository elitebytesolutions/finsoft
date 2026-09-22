# Payments & receipts

| | |
|---|---|
| **Route** | `/payments` |
| **Archetype** | B — Document entry (with allocation) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · `payment:create` |
| **Prototype source** | `ui-prototype/src/transactions-pages.tsx` (`PaymentsCentre`) |
| **Posts to the ledger** | **yes** — receipts and payments with invoice allocation |

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
