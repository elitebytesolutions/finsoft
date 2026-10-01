# Sales voucher (invoice entry)

| | |
|---|---|
| **Route** | `/sales/voucher` |
| **Archetype** | B — Document entry |
| **Module / permission** | Sales & POS · `Sales & POS` · `sale:create` |
| **Prototype source** | `ui-prototype/src/sales-voucher.tsx` (`SalesVoucher`) |
| **Reference frame** | `ui-prototype/design/sales voucher page .png` |
| **Posts to the ledger** | **yes** — revenue, receivable/cash, tax, COGS and stock (Service mode); **no** (Product mode — prototype only) |

## API note — M4-W2 (2026-10-01)

**PO decision, 2026-10-01: this screen has two modes behind a Service/Product switch**, a
segmented control (`.mode-picker.lg`, `packages/ui/src/styles/kit.css`) in the page header.
Service is the default.

**Service mode is live.** `apps/web/src/screens/sales-voucher.tsx`'s `ServiceSalesVoucher`
posts real service-line invoices against `modules/receivables` (I1–I8,
`docs/design/M3/api-contract.md` §4.2). The product/batch/GST sale this doc otherwise describes
has no counterpart in the real invoice contract (a line is `{description, quantity, unitPrice}`
only — `packages/shared-types/src/receivables.ts`), so Service mode's actual anatomy is a
service-line grid (#, Description, Qty, Rate, Net amount) in place of §2's item table, and drops
the Fulfillment & Sales Team card and the Sale No/PO No/PO Date/Bill Book No doc-number strip
entries (no schema field for any of them). Due date and Narration, real fields the mock never
had, were added to the customer card.

Money discipline: every line net amount and the invoice total come from I6
(`POST /api/invoices/calculate`), debounced on every edit, **sent over complete lines only** —
an incomplete line used to be padded with `'0'` defaults and included anyway, which could total
differently from what Post actually sends (`validLines`). Save & Post stays disabled while a
calculation is still in flight. The post-confirm dialog quotes the **saved draft's own
server-computed `netAmount`** (I2/I4's response), never a parallel `/calculate` figure — `openPost`
saves (or re-saves) the draft first, then opens the dialog with that draft's id/version/netAmount,
so the dialog can never show a number different from what gets posted.

The customer picker is a debounced search (C1, capped at 8 results) resolving on an exact
"Name (CODE)" match — **ACTIVE customers only**, unlike the receipt picker on `/payments`, which
also includes INACTIVE ones (a receipt settles a debt an inactive customer can still owe; a new
invoice does not get raised against one).

Permissions: `invoice.create` gates the page (and Save Draft/Cancel/line edits); `invoice.post`
gates Save & Post — UI affordance only, the controllers' own `@RequirePermission` is the real
gate. Errors route through `apps/web/src/lib/adapters/receivables-errors.ts`'s shared mapper.

**Product mode is the original prototype, unchanged, and permanently disconnected.** Restored
verbatim from before this branch (`git show 65efbba:apps/web/src/screens/sales-voucher.tsx`) as
`ProductSalesVoucher` — every field, panel, button and calculation display this doc's §2–§8
describe. It shows the "Prototype — not connected to the ledger" banner unconditionally (the
route is API-backed now via Service mode, so the shell's own automatic per-route banner no
longer fires for it) and never posts: Save Draft and Save & Post are permanently `disabled` with
`title="Coming with inventory and tax (Waves 5–9)"`. The fabricated `INV-…` number this doc's
mock once showed is gone — "Assigned on posting" in its place, since this mode has never created
a real invoice and must not claim one.

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
