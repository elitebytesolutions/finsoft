# Sales voucher (invoice entry)

| | |
|---|---|
| **Route** | `/sales/voucher` |
| **Archetype** | B — Document entry |
| **Module / permission** | Sales & POS · `Sales & POS` · `sale:create` |
| **Prototype source** | `ui-prototype/src/sales-voucher.tsx` (`SalesVoucher`) |
| **Reference frame** | `ui-prototype/design/sales voucher page .png` |
| **Posts to the ledger** | **yes** — revenue, receivable/cash, tax, COGS and stock |

## 1. Purpose

Create and post a sales invoice: customer, items with batch and expiry, discounts, GST, and the
fulfilment team behind it. It is the highest-volume posting screen in the product and the reference
implementation of archetype B.

## 2. Anatomy

```
DocHeadBar     icon · "Sales Voucher" · "Create and record a sales invoice with customer, order and
               item details."          [Save Draft] [Save & Post] [Print] [Estimate] [More v]
DocNumberStrip Sale No (Auto) · Sale Date · Purchase Order No · PO Date · Invoice No · Bill Book No
FormSection    "Order & Customer Information"    | "Fulfillment & Sales Team"
                 customer/party * · customer name  booker · deliveryman · salesman
                 address (read-only from master)  doctor · supervisor · sale type
                 area · city                      place/warehouse · remarks
ItemEntry      "Item Entry" · [search product] [Find Product] [Add Product] [Product Change] [New Product]
LineItemGrid   # · Product Name * · Pack · Batch/Expiry · Qty · Bonus · Sale Rate · Gross Amount ·
               Disc % · GST % · Net Rate · Net Amount · ✕
               [+ Add Row] [Clear All Items]        hint: selecting a product auto-fills pack, batch,
                                                    rate and tax
TotalsBar      Total Items · Total Qty · Gross Amount · Discount · GST Amount · **Net Amount**
LedgerPreview  the journal this will post (revenue, tax, receivable/cash, COGS, stock)
```

## 3. Components

`FormSection` · `PartyPicker` · `ProductPicker` (FEFO batch in the option) · `LineItemGrid` (C7) ·
`QuantityInput` · `MoneyInput` · `TotalsBar` · `LedgerImpactCard` (preview) · `IdempotencyGuard` ·
`ConfirmDialog` · `FormErrorSummary` · `PrintDocument`.

## 4. Line grid rules

- Product selection auto-fills pack, **FEFO batch and expiry**, rate and GST; a manual batch change
  is allowed and is marked as an override on the line.
- Computed columns (Gross amount, Net rate, Net amount) are read-only and filled.
- Bonus quantity is its own column; it affects stock, not revenue.
- Quantity may not exceed available stock for the chosen batch; the cell shows available on focus
  and refuses the excess with the figure.
- Expired or near-expiry batches are flagged on the line; selling an expired batch is blocked.

## 5. Validation before post

Customer, at least one line, every line with product, batch, quantity and rate; quantity within
available stock; date in an open period; customer within credit limit and not on hold for a credit
sale; role holds `sale:create`. Each failure names itself in the post tooltip and the error summary.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save Draft | secondary | `sale:create` | no | Draft; **no stock movement, no ledger effect** |
| Save & Post | primary | `sale:create` | **yes — items, qty, net amount, period, and the fact that stock will move** | Posts revenue, tax, receivable/cash, COGS and the stock issue; routes to the invoice |
| Print / Estimate | secondary | `Sales & POS` | no | Invoice PDF / non-posting quotation |

## 7. Financial rules

- The module raises a sales event; it **never** writes journal lines and **never** writes
  `stock_movements` — the inventory kernel posts the movement in the same transaction.
- COGS uses weighted-average cost ([ADR-0007](../../../adr/ADR-0007-weighted-average-costing.md));
  the screen displays no cost figures to the salesman role.
- Money is decimal end to end; the UI sends strings, never JS numbers.
- Idempotent: three clicks on Save & Post produce one invoice.
- Closed period: post disabled, draft allowed.

## 8. States

Insufficient stock, expired batch, over credit limit, customer on hold, closed period, post failure,
no-confirmation-received — each has its own copy and none of them is a generic error.

## 9. Responsive · 10. Accessibility

`lg` the two form sections stack into one column, the grid scrolls with `#` and Product sticky ·
`md` the totals bar becomes sticky at the bottom · `sm` and below the screen is read-only with a
"create invoices on a desktop or the POS terminal" notice.

The grid is a real table; `Tab` traverses cells, `Enter` on the last cell adds a row; the totals bar
is `aria-live="polite"`; required cells carry `aria-required`; batch/expiry is announced with the
product name.

## 11. Deviations from the prototype

The prototype's totals bar is informational. Production makes it the posting summary and the confirm
dialog quotes it verbatim, so the figure the user saw is the figure they approved.

## 12. Open questions

1. Is a negative-stock sale ever permitted (backorder), and if so, for which roles?
2. Are the doctor/commission fields in MVP scope?
3. Does "Estimate" create a stored quotation document or only a print?
