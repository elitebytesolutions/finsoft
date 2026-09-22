# Cash Transactions

| | |
|---|---|
| **Route** | `/cash-transactions` |
| **Archetype** | A — Register (+ inline create panel) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · create needs `voucher:create` |
| **Prototype source** | `ui-prototype/src/cash-transactions.tsx`, `src/transactions-pages.tsx` |
| **Reference frame** | `ui-prototype/design/cash trasaction page.png` |
| **Posts to the ledger** | **yes** — each posted transaction raises a cash event |

## 1. Purpose

Every cash movement across all cash accounts and branches, searchable and filterable, with a create
panel for one-off entries that do not belong to a sales or purchase document.

Difference from [Cash Book](../cash-book/): the cash book is **one account, one day, in order**;
this is **all cash accounts, any range, as a register**.

## 2. Anatomy

```
PageHead      "Cash Transactions" · description · [Export] [+ Create transaction]
KpiRow        Total in · Total out · Net movement · Transactions
Panels        [ Create Transaction ]  |  [ Reports & Filters ]
Table         "Recent Cash Transactions"
              # · Voucher No. · Type · Date · Account name · Counterparty · Amount · Status · Remarks · Actions
Footer        showing · totals · pager
```

## 3. Components

`KpiRow` · `DataTable` · `FormSection` (create) · `AccountPicker` · `PartyPicker` · `MoneyInput` ·
`SegmentedControl` (In / Out) · `StatusBadge` · `ExportMenu` · `ConfirmDialog`.

## 4. Columns

| Column | Align | Format | Priority |
|---|---|---|---|
| # | right | ordinal | 5 |
| Voucher No. | left | link, tabular | 1 |
| Type | left | chip: Receipt `good` · Payment `warn` · Contra `info` | 2 |
| Date | left | `01 Aug 2026` | 1 |
| Account name | left | `code — name`, links to the ledger | 2 |
| Counterparty | left | party or free text | 3 |
| Amount | right | money; direction carried by Type, never by sign | 1 |
| Status | left | Posted `good` · Draft `warn` · Reversed `danger` | 2 |
| Remarks | left | truncated to one line, full text on hover/expand | 5 |
| Actions | right | View voucher · Reverse (posted) · Post (draft) | 1 |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Create transaction | primary | `voucher:create` | **yes on post** | Draft or posted cash voucher |
| Post (row) | inline | `voucher:create` | **yes** | Posts one draft; never bulk |
| Reverse (row) | overflow | `voucher:reverse` | **yes** | Creates a reversing voucher; this row stays |
| Export | secondary | `Reports` | no | Filtered set with company and period |

## 6. States

Standard set. A draft row is visually lighter with a `Draft` badge and an explicit **Post** action;
it contributes to no KPI except "Transactions", and the KPI row says "posted only".

## 7. Financial rules on this page

- Amount is a single column because Type carries direction — permitted here because this is a
  **register**, not an accounting surface. On the ledger, the same movements appear as separate
  Dr/Cr columns.
- No edit of a posted transaction, in any role. Reverse and re-enter.
- The create panel refuses a date in a closed period before the request is sent, and the server
  refuses it again.

## 8. Responsive · 9. Accessibility

`lg` the create panel collapses to a button that opens a drawer · `md` KPI 2×2 · `xs` card list.
Type chips carry text, not colour alone; the create panel is a labelled `form` with an error
summary.

## 10. Deviations from the prototype

`transactions-pages.tsx` renders a second "Cash Transactions" heading for the Payments centre — a
prototype naming collision. In production, `/payments` is **Payments & Receipts** and only this
route is called Cash Transactions.

## 11. Open questions

1. Does this page create only cash vouchers, or also contra (cash↔bank) entries?
2. Is the remarks field free text, or drawn from a configurable reason list for reporting?
