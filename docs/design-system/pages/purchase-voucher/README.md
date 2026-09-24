# Purchase voucher (goods receipt & supplier invoice)

| | |
|---|---|
| **Route** | `/purchasing/voucher` |
| **Archetype** | B — Document entry (stepped) |
| **Module / permission** | Purchasing · `Purchasing` · `purchase:create` |
| **Prototype source** | `ui-prototype/src/purchase-voucher.tsx` (`PurchaseVoucher`) |
| **Reference frame** | `ui-prototype/design/purchase voucher detail page.png` |
| **Posts to the ledger** | **yes** — inventory, GST input, payable |

## 1. Purpose

Receive goods and record the supplier's invoice in one controlled workflow: batches, expiry dates,
bonus quantities, discounts, GST, and the resulting stock and payable.

## 2. Anatomy

```
DocHeadBar     "Create Purchase Voucher"  [Save draft] [Save & post] [Print] [More v]
Stepper        1 Voucher Details · 2 Purchase Items · 3 More Information & Actions
FormSection    "Voucher Information": voucher no (Auto) · date · supplier * · supplier bill # * ·
               bill date · payment type (Cash / Credit) · due date · branch · location/warehouse
LineItemGrid   "Purchase Items"
               # · Product * · UPC · Pack · Batch · Expiry · T-Qty · Ps-Qty · LS · Bns · Brk. ·
               Cost · %Disc. · %Gst · Pur. Price · Sale Price · Amount · Shelf · Available ·
               Stock Qty · ✕
TotalsBar      Items · Total qty · Gross · Discount · GST · **Net payable**
FormSection    "More Information & Actions": narration, attachments, freight/landed cost
LedgerPreview  Inventory · GST input · Payable (or Cash)
```

The grid is wide by design — this is a desktop-only screen. Column groups (identity, quantities,
pricing, stock context) are separated by a 2px rule and the group can be collapsed.

## 3. Components

`Stepper` (C10) · `FormSection` · `PartyPicker` (suppliers) · `ProductPicker` · `LineItemGrid` ·
`DateField` (expiry, with an expiry-window warning) · `MoneyInput` · `TotalsBar` ·
`LedgerImpactCard` · `IdempotencyGuard` · `ConfirmDialog`.

## 4. Line rules

- Product selection fills pack, last purchase cost, sale price, GST and shelf.
- **Batch and expiry are required** for every batch-tracked product; expiry must be in the future,
  and an expiry inside the tenant's minimum-shelf-life window warns before it blocks.
- Bonus (`Bns`) increases stock at zero cost and therefore **lowers the weighted-average cost** —
  the grid shows the resulting average cost per line so the effect is visible before posting.
  This is a preview of the **rate** the kernel will store, computed by the server from the carried
  value per ADR-0015 §4. It is not a valuation, and the page must not derive stock value from it.
  Bonus quantity cannot make the rate negative: it enters only the denominator (ADR-0017).
- Breakage (`Brk.`) is recorded on receipt and posts a loss, not stock.
- Stock context columns (Available, Stock qty, Shelf) are read-only and exist to stop
  duplicate or wrong-product receipts. **`Available` is informational only** and is a snapshot, not
  a hold: there are no reservations in this release (ADR-0017 §7), so a figure shown here may be
  consumed by a competing transaction before this document posts.
- **A `Reserved` column was specified here and is removed.** Nothing reserves stock in this release,
  so the column could only ever show zero — and a permanently-zero "Reserved" figure reads as a
  guarantee that no code makes. It returns with the separate reservations design, not before.
- Duplicate supplier bill number for the same supplier blocks the save with the existing document
  linked. **This spec assumes one supplier bill maps to exactly one GRN**, which is the open
  question in ADR-0017 §4(c) — a bill covering goods delivered across several days is common in
  distribution and would be wrongly blocked. Confirm with the business before the constraint ships;
  if multiple receipts per bill are legitimate, this becomes a warning with the existing document
  linked, not a block. The comparison uses the normalised bill number (ADR-0017 §4(b)), and a
  blocked save is not the only control — posting is idempotent (§4(d)).

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save draft | secondary | `purchase:create` | no | Draft; **no stock, no payable** |
| Save & post | primary | `purchase:create` | **yes — line count, total qty, net payable, period, and that stock will increase** | Posts inventory, GST input and the payable; routes to the purchase detail |
| Print GRN | secondary | `Purchasing` | no | `PrintDocument` |

## 6. Financial rules

- The module raises a purchase event; the posting engine writes the journal and the inventory kernel
  writes the movement — neither is written by this module.
- Weighted-average cost is recomputed by the kernel on receipt
  ([ADR-0007](../../../adr/ADR-0007-weighted-average-costing.md)); the grid's displayed average is a
  server-calculated preview, not a client computation.
- Money is decimal end to end.
- Closed period: post disabled, draft allowed.
- Idempotent.

## 7. States

Duplicate bill, expiry too near, missing batch, negative cost, closed period, post failure,
no-confirmation-received — each with its own copy.

## 8. Responsive · 9. Accessibility

Desktop-only below `lg` the grid scrolls with `#` and Product sticky; below `md` the page is
read-only with a notice. Column groups have header cells with `colspan` and accessible group names;
the average-cost preview is `aria-live`.

## 10. Deviations from the prototype

The prototype exposes 20+ columns at once at 9px. Production keeps the same data but ships default
visible columns (identity, batch, expiry, qty, bonus, cost, disc, GST, amount) with the rest behind
the `Columns` menu, and raises the text to 12px.

## 11. Open questions

1. Is landed cost apportioned by value or by quantity, and is it captured here or in a separate
   document?
2. Does a purchase always create a GRN, or can invoice and receipt be separated?
3. Which role may change the sale price during a purchase?
