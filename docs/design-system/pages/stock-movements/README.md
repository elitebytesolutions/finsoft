# Stock movements ledger

| | |
|---|---|
| **Route** | `/inventory/movements/history` |
| **Archetype** | D — Ledger / Statement |
| **Module / permission** | Inventory · `Inventory` |
| **Prototype source** | `ui-prototype/src/stock-movements.tsx` (`StockMovements`) |
| **Posts to the ledger** | no — it is the **read** surface for the movement ledger |

## 1. Purpose

Every quantity change, in order, with its document and its running balance. This is the inventory
equivalent of the account ledger, and it is the screen that settles arguments about where stock went.

## 2. Anatomy

```
PageHead      "Stock Movements" · [product picker] [warehouse v] [date range v] [Export]
ProductHeader product · pack · class · company · current on-hand · avg cost · value
KpiRow        Opening qty · Received · Issued · Closing qty · Movements
FilterBar     type · batch · reference · user · reason
LedgerTable   Date · Type · Reference · Batch · Route / warehouse · Qty in · Qty out ·
              Running qty · Unit cost · Value · Posted by
Footer        page totals · closing quantity · pager
```

## 3. Components

`ProductHeader` · `KpiRow` · `LedgerTable` · `FilterBar` · `StatusBadge` · `DocumentLink` ·
`ExportMenu`.

## 4. Columns

| Column | Align | Format |
|---|---|---|
| Date | left | `01 Aug 2026` + 9.5px time |
| Type | left | chip: Purchase `good` · Sale `info` · Stock In `good` · Issue `danger` · Transfer `warn` · Breakage `danger` · Gift `info` · Count `info` · Adjustment `warn` |
| Reference | left | the document, linked |
| Batch | left | batch + 9.5px expiry |
| Route / warehouse | left | from → to for transfers |
| Qty in / Qty out | right | separate columns, never one signed column |
| Running qty | right | `--money-balance` treatment |
| Unit cost / Value | right | money; hidden without `stock:view-cost` |
| Posted by | left | user, 9.5px |

## 5. Financial rules

- In and out are **separate columns**, mirroring Dr/Cr — the same reasoning applies.
- The running quantity must reconcile to the product's current on-hand; if filters make that untrue,
  the page says so in an `InlineWarning`.
- Movements are append-only. There is no edit and no delete, in any role. A wrong movement is
  corrected by an opposite movement, which appears as its own row and links to the original.
- Every row has a document. A movement with no document is a data integrity defect and is rendered
  with a `danger` chip so it is found rather than hidden.

## 6. States

Empty for the product/period; filtered empty; error. A product with no movements but non-zero stock
is an integrity error and says so explicitly.

## 7. Responsive · 8. Accessibility

`xl` hides Posted by and Route · `md` the product header stacks · `sm`+ horizontal scroll with Date
sticky; Qty in, Qty out and Running qty are never dropped.
`<caption>` names the product, warehouse and period; quantity cells state direction in their
accessible label.

## 9. Open questions

1. Does this page work per product only, or also per batch and per warehouse without a product?
2. Retention and archiving for tenants with years of movements.
3. Should cost columns be role-gated or period-gated (visible after close)?
