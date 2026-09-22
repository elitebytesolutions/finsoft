# Receive & Issue Cheques (cheque voucher)

| | |
|---|---|
| **Route** | `/cheque-voucher` |
| **Archetype** | B — Document entry (single + bulk modes) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · `voucher:create` |
| **Prototype source** | `ui-prototype/src/cheque-voucher.tsx` (`ChequeVoucher`) |
| **Reference frames** | `design/receive issue checks .png`, `issuereceivecheque.png`, `receivebulksignle page check.png` |
| **Posts to the ledger** | **yes** — receiving and issuing cheques raise financial events |

## 1. Purpose

Record cheques coming in from customers and going out to suppliers — one at a time, or a sheet of
them at once when a salesman returns from a collection run.

## 2. Anatomy

```
DocHeadBar     "Cheque Voucher" · [Save draft] [Save & post] [Print] [More v]
VoucherType    segmented: Received (CRV) | Issued (CPV)      — chosen first, drives every label
FormSection    "Voucher Information"    : voucher no (Auto) · date · branch · salesman · reference
               "Cheque Details"         : party/account · cheque no · cheque date · due date · bank · branch
               "Bank & Posting Information": our bank account · posting account · narration
               "Additional Notes"
Mode           [ Single ] [ Bulk sheet ]
BulkSetup      "Bulk Voucher Setup"  : common date, bank, type, salesman
BulkGrid       # · Party/account code * · Party name * · Cheque no * · Cheque date * · Due date ·
               Old no. · Amount * · Remarks · ✕
SheetPopulate  "Sheet Population (Optional)" — start number + count to pre-fill a cheque series
TotalsBar      Cheques · Total amount · Earliest due · Latest due
```

## 3. Components

`SegmentedControl` (type, mode) · `FormSection` · `LineItemGrid` (bulk) · `PartyPicker` ·
`AccountPicker` · `DateField` · `MoneyInput` · `IdempotencyGuard` · `ConfirmDialog` ·
`FormErrorSummary`.

## 4. Validation

- Party/account, cheque number, cheque date and amount are required on every row.
- Cheque number must be unique per bank for the tenant; a duplicate is flagged inline on the row,
  not at submit.
- Due date cannot precede the cheque date.
- A post-dated cheque is allowed and is marked `PDC`; it posts to the cheques-in-hand /
  cheques-issued control account, **not** to bank, until it clears.
- Voucher date must be in an open period.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save draft | secondary | `voucher:create` | no | Draft cheque voucher |
| Save & post | primary | `voucher:create` | **yes — row count, total, period, control account** | Posts; toast names the voucher; routes to the detail |
| Populate sheet | ghost | — | no | Pre-fills a cheque number series into empty rows |
| Print | secondary | `Cash, Bank & GL` | no | Cheque deposit slip / issue register |

## 6. Financial rules

- Receiving a cheque **does not** debit bank. It debits cheques-in-hand and credits the customer.
  Bank is affected when the cheque clears, from `/cheque-posting`.
- Issuing a cheque credits cheques-issued and debits the supplier; bank is affected on presentment.
  This two-step model is what makes dishonour and void reversible without touching bank history.
- The module raises the event; it never writes journal lines.
- Bulk posting produces **one voucher with many lines**, not many vouchers, unless the tenant
  configures per-cheque vouchers — and that setting is shown on the confirm dialog.

## 7. States

Closed period → post disabled, draft allowed. Duplicate cheque number → row error, post blocked.
Bulk grid over 200 rows → virtualised with a persistent totals bar.

## 8. Responsive · 9. Accessibility

`md` the form sections stack and the bulk grid scrolls with the row number sticky ·
`sm` and below: single mode only, bulk is desktop-only with a notice.
Every grid column has a header; required cells carry `aria-required`; the totals bar is `aria-live`.

## 10. Deviations from the prototype

The prototype's `chq-*` styles ship four near-identical layouts for received/issued × single/bulk.
Production uses **one** screen with a type switch and a mode switch — the labels change, the
structure does not.

## 11. Open questions

1. Are cheques-in-hand and cheques-issued fixed control accounts per tenant, or per bank account?
2. Does a received cheque need the customer's bank, or only ours?
3. Cheque image capture — in scope?
