# Sales invoices register

| | |
|---|---|
| **Route** | `/sales` |
| **Archetype** | A — Register |
| **Module / permission** | Sales & POS · `Sales & POS` · create needs `sale:create` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Sales`) |
| **Reference frame** | `ui-prototype/design/invoice summary page .png` |
| **Posts to the ledger** | indirectly — posting happens on the sales voucher |

## 1. Purpose

Every sales invoice, findable by customer, date, mode and status. The counter staff and the
accountant both live here: one to re-print and follow up, the other to check what posted.

## 2. Anatomy

```
PageHead   "Sales & point of sale" · "Process retail, wholesale, hospital and clinic sales with
            FEFO allocation." · [Export] [+ New sale]
KpiRow     Net sales today · Credit sales · Cash received · Draft invoices
FilterBar  search · date range · customer · mode · salesman · status · branch
DataTable  Invoice · Date · Customer · Mode · Product/lines · Quantity · Total · Status · Actions
Footer     showing · period totals · pager
```

## 3. Components

`KpiRow` · `FilterBar` · `DataTable` · `StatusBadge` · `ExportMenu` · `ConfirmDialog` ·
`PartyLink` · `PrintMenu`.

## 4. Columns

| Column | Align | Format | Priority |
|---|---|---|---|
| Invoice | left | server number, links to `/sales/:id` | 1 |
| Date | left | `13 Sep 2026` | 1 |
| Customer | left | name + 9.5px city, links to the customer | 1 |
| Mode | left | chip: Retail · Wholesale · Hospital · Clinic · Credit · Cash | 2 |
| Product / lines | left | first product + `+3 more` | 4 |
| Quantity | right | total units | 3 |
| Total | right | money, 700 | 1 |
| Status | left | Draft `warn` · Posted `good` · Partially paid `warn` · Paid `good` · Returned `info` · Cancelled `danger` | 2 |
| Actions | right | View · Print · Record receipt · Create return · Reverse (posted, `voucher:reverse`) | 1 |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New sale | primary | `sale:create` | — | `/sales/voucher` |
| Record receipt | row | `payment:create` | — | `/payments` pre-filled |
| Create return | row | `sale:create` | — | `/sales-returns` linked to this invoice |
| Reverse | overflow | `voucher:reverse` | **yes** | Posts a reversal; stock and revenue both reverse |
| Export / Print | secondary | `Reports` | no | Filtered set / invoice PDF |

## 6. Financial rules

- A posted invoice cannot be edited from this register. Correction is a credit note (return) or a
  reversal.
- Totals in the KPI row are **posted** invoices only and say so; drafts are counted separately.
- Every row's total is the server's figure; the client never re-computes tax or line totals.

## 7. States

Empty ("No sales in this period"), filtered empty, error, permission — standard.
A customer on credit hold appears with a `danger` chip on their rows, linking to `/credit-limits`.

## 8. Responsive · 9. Accessibility

`xl` hides Quantity and lines · `md` filter sheet · `xs` card list: invoice + customer + total +
status. `<caption>` states the period and branch filter.

## 10. Open questions

1. Is POS a separate screen with a till workflow, or is the sales voucher used at the counter?
2. Do we need a shift/session concept for cash sales?
3. Delivery challan and quotation: separate document types or statuses of the invoice? (The
   prototype's sidebar routes them all here — this must be resolved before build.)
