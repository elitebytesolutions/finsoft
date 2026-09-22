# Product detail

| | |
|---|---|
| **Route** | `/products/:id` |
| **Archetype** | F — Master record |
| **Module / permission** | Products · `Products` |
| **Prototype source** | `ui-prototype/src/detail-pages.tsx` (`ProductDetail`) |
| **Posts to the ledger** | no |

## 1. Purpose

Everything about one medicine in one place: its master data, its batches with expiry, its movement
history, the documents it appears on, and its pricing.

## 2. Anatomy

```
Breadcrumbs  Products > Catalogue > Panadol 500mg Tablet
RecordHeader icon · name (h1) · code · flags · [Active] · [Edit] [Add stock] [More v]
KpiRow       On hand · Stock value · Avg. cost · Next expiry
Tabs         Overview · Batches · Movements · Documents · Pricing · Activity
  Overview   DefinitionGrid: generic, company, class, pack, UPC, shelf, GST, levels, flags
  Batches    Batch · Expiry · Stock · Cost · Value · Days remaining · Status
  Movements  the product-scoped movement ledger (see stock-movements)
  Documents  Reference · Date · Type · Party · Qty · Amount
  Pricing    price history with effective dates and who changed it
  Activity   audit timeline for the master record
```

## 3. Components

`RecordHeader` · `KpiRow` · `Tabs` · `DefinitionGrid` · `DataTable` · `LedgerTable` (movements) ·
`Timeline` · `StatusBadge` · `Modal` (edit).

## 4. Batch table rules

| Column | Format |
|---|---|
| Batch | tabular |
| Expiry | date; `danger` ≤ 30 days, `warn` ≤ 90 |
| Stock | right; `danger` if negative |
| Cost | right; hidden without `stock:view-cost` |
| Value | right |
| Status | Active `good` · Expiring `warn` · Expired `danger` · Quarantined `info` · Exhausted `neutral` |

Batches sort FEFO by default — the order stock will actually be issued in.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Edit | secondary | `master:edit` | price change: yes | Opens the product form |
| Add stock | primary | `stock:post` | **yes** | `/inventory/stock-in` pre-filled |
| Deactivate | overflow | `master:edit` | **yes** | Removed from pickers |
| Print label | overflow | `Products` | no | Shelf label with barcode |

## 6. Financial rules

- On hand, value and average cost are **server figures** from the movement ledger. Value is the carried
  `value_on_hand`, never `on hand × average cost` (ADR-0015 §7); average cost is a rate shown for
  information. This page never
  sums movements in the browser.
- The batch table's total stock must equal the header's on-hand figure; a mismatch is rendered as an
  integrity error, not silently reconciled.
- Expired batches remain visible with their value until written off — hiding them would understate
  inventory.

## 7. States

Not found / other tenant → shared Not found. Product with no movements → batches and movements tabs
show their own empty states, not a page-level empty.

## 8. Responsive · 9. Accessibility

`md` KPI 2×2, definition grid 4 → 2 · `sm` tabs become a select · `xs` card lists.
`h1` is the product name with the code in the accessible name; expiry warnings are text, not colour
alone.

## 10. Open questions

1. Does the pricing tab allow scheduling a future price change?
2. Should quarantined stock be a batch status or a separate location?
3. Do we show supplier-wise purchase history on this page?
