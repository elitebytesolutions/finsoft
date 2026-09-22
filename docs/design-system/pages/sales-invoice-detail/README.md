# Sales invoice detail

| | |
|---|---|
| **Route** | `/sales/:id` |
| **Archetype** | C — Document detail |
| **Module / permission** | Sales & POS · `Sales & POS` |
| **Prototype source** | `ui-prototype/src/detail-pages.tsx` (`SaleDetail`) |
| **Posts to the ledger** | **yes** — reversal and return are initiated here |

## 1. Purpose

The permanent record of one sale: what was sold, from which batches, at what price, what it posted,
and what has been paid against it.

## 2. Anatomy

```
Breadcrumbs   Sales > Invoices > SV-2026-000123
DocHeader     SV-2026-000123 (h1) · [Posted] · customer · Rs 891.55 · [Record receipt] [Print] [More v]
PostingStrip  Draft > Posted > (Partially paid) > Paid / Reversed
DefinitionGrid Invoice date · Customer · Mode · Salesman · Booker · Deliveryman · Warehouse ·
               PO ref · Bill book · Narration · Created by · Posted on
LineTable     Product · Batch · Expiry · Qty · Bonus · Rate · Disc · GST · Net amount
TotalsCard    Gross · Discount · GST · **Net** · amount in words
PaymentPanel  Receipts allocated to this invoice: date · voucher · amount · balance due
LedgerImpact  Revenue · GST payable · Receivable/Cash · COGS · Inventory
StockPanel    Movements this invoice created (batch, qty out, cost)
AuditStamp + Timeline + Attachments
```

## 3. Components

`DocHeader` · `PostingStatusStrip` · `DefinitionGrid` · `DataTable` (lines, payments, movements) ·
`TotalsCard` · `LedgerImpactCard` · `AuditStamp` · `Timeline` · `PrintDocument` · `ConfirmDialog`.

## 4. Actions by status

| Status | Available |
|---|---|
| Draft | Edit · Post (confirm) · Cancel (confirm) · Print |
| **Posted** | Record receipt · Create return · Reverse (confirm, `voucher:reverse`) · Print · Export — **no edit** |
| Partially paid / Paid | Record receipt (until settled) · Create return · Print |
| Reversed | Print · banner linking to the reversing document |
| Cancelled | Print · Copy to new |

## 5. Financial rules

- A posted invoice shows no inputs. Corrections are a **credit note (sales return)** for commercial
  changes, or a **reversal** for an erroneous posting — the difference is explained in the dialog so
  the user picks the right one.
- Reversal reverses revenue, tax, receivable and the stock issue together, in one transaction.
- The stock panel shows the actual movements the inventory kernel wrote; this page never derives
  them.
- Balance due is server-computed from allocated receipts.

## 6. States

Not found / other tenant → shared Not found state. Closed period → reversal is offered into the
first open period and says so. A return already raised against the invoice shows a banner with the
return's number.

## 7. Responsive · 8. Accessibility

`md` definition grid 4 → 2, panels stack · `sm` line table scrolls · `xs` lines become cards.
`h1` is the invoice number; the status is part of the document region's accessible name; the amount
in words is readable text, not an image.

## 9. Open questions

1. Does a partial return change the invoice status, or only the balance?
2. Should the stock panel show cost to every role, or only to finance roles?
3. Do we need a delivery/dispatch status separate from the posting status?
