# Sales invoice detail

| | |
|---|---|
| **Route** | `/sales/:id` |
| **Archetype** | C — Document detail |
| **Module / permission** | Sales & POS · `Sales & POS` |
| **Prototype source** | `ui-prototype/src/detail-pages.tsx` (`SaleDetail`) |
| **Posts to the ledger** | **yes** — reversal and return are initiated here |

## API note — M4-W2 (2026-10-01)

**Route is `/sales/:id`, real `Invoice`.** `SaleDetail` (`apps/web/src/screens/detail-pages.tsx`)
now fetches I3 (`GET /api/invoices/:id`) instead of rendering a mock sale record — self-contained,
no `<Guard>` (API-backed, same as `/customers/:id`; its own `can()` checks plus the server's 403
are the access control). The mock's batch/GST sale has no real counterpart: real status is
`DRAFT | POSTED | REVERSED | CANCELLED`, real settlement is `OPEN | PARTIALLY_PAID | PAID`, lines
are service lines (description/qty/unit price/net amount, no GST), and the real `INV-…` number
replaces the mock's own.

**Quantity and unit price are never parsed to a JS number for display.** `unitPrice` is a 6dp
`UnitCost` string (`numeric(19,6)`), not 4dp `Money` — the kit's `moneyFromString` throws on
anything past 4 decimal places (`Money.from`'s scale check); `unitPriceDisplay()` rounds through
`UnitCost.from`/`.serialize(2)` first. `quantity` ("1.000000") is formatted by
`quantityDisplay()`, which trims trailing zeros straight off the string (never `Number(x)`).

**Allocations and the linked journal entry are real.** The allocations table lists
`InvoiceAllocation[]` (receipt number/date/amount/LIVE-or-VOIDED status), linking to
`/receipts/:id`. The journal entry link shows "—" when `journalEntry` is `null` — this is a
known gap (TD-014: `GET /invoices/:id` does not yet return the posting entry), not eventual
consistency, and no workaround belongs here; the dash is the correct, honest state.

**Reverse is gated two ways.** `invoice.post` + `voucher.reverse` (privileged — matches the
controller's `@RequirePermission` on I8) AND `reversalBlockedBy`: when a posted invoice has live
receipt allocations, the Reverse button is **withheld entirely** (not shown-then-refused), and a
banner names the blocking receipt(s) — "This invoice cannot be reversed while it has live
receipt allocations. Reverse RCT-…-…… first." (the PO's wording). The reverse dialog follows
[voucher-detail](../voucher-detail/#6-reverse--the-one-mutating-action-here)'s own
reason-required/confirmation-checkbox pattern. Errors route through the same
`receivablesErrorMessage` mapper `/sales/voucher` and `/payments` use; `INVOICE_HAS_LIVE_
ALLOCATIONS` specifically renders the PO-mandated "reverse the receipt first" copy.

A draft invoice (`DRAFT`) shows no Reverse action at all — an "Edit draft" link into
`/sales/voucher?invoice=<id>` instead, since I4 (full replace) only applies to a draft.

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
