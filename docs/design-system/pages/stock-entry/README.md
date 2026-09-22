# Manual stock in / stock out

| | |
|---|---|
| **Route** | `/inventory/stock-in` (and `/inventory/movements` in the prototype) |
| **Archetype** | B — Document entry |
| **Module / permission** | Inventory · `Inventory` · `stock:post` |
| **Prototype source** | `ui-prototype/src/manual-stock.tsx` (`ManualStockEntry`) |
| **Reference frame** | `ui-prototype/design/manual stock in and out page .png` |
| **Posts to the ledger** | **yes** — via the inventory kernel and the posting engine |

## 1. Purpose

Record stock movements that no sales or purchase document explains: opening stock, found stock,
write-offs, samples, internal consumption. Every such movement has an accounting consequence, so it
is a posted document with a reason, not a quantity edit.

## 2. Anatomy

```
DocHeadBar   "Manual Stock In / Stock Out" · [Save draft] [Save & post] [Print]
TypeSwitch   [ Stock In ] [ Stock Out ]
FormSection  Entry No. (Auto) · Date · Warehouse · Reason * · Reference No. · Narration ·
             Offset account * (expense / income / opening equity)
LineGrid     # · Product * · UPC / Barcode · Batch · Expiry · Quantity * · Unit · Unit Cost (Rs) ·
             Total Value (Rs) · Remarks · ✕
TotalsBar    Items · Total qty · **Total value**
History      "Recent entries": Entry No. · Date · Type · Items · Total Value · Reason · Entered By · Status · Actions
```

## 3. Components

`SegmentedControl` (in/out) · `FormSection` · `LineItemGrid` · `ProductPicker` (barcode-capable) ·
`QuantityInput` · `MoneyInput` · `AccountPicker` (offset) · `ReasonSelect` · `ConfirmDialog` ·
`IdempotencyGuard` · `DataTable` (history).

## 4. Rules

- **Reason and offset account are required.** A stock movement with no accounting counterpart is
  not permitted — that is how stock and the ledger drift apart.
- Stock In: unit cost is required and affects the weighted average. Stock Out: unit cost is
  **read-only**, taken from the current weighted average, and shown so the value effect is visible.
- Batch and expiry required for batch-tracked products; Stock Out picks FEFO by default with an
  overridable batch.
- Stock Out may not exceed available quantity in the chosen batch.
- Barcode scanning fills the product and focuses the quantity cell.

## 5. Reason to account mapping

| Reason | Direction | Typical offset |
|---|---|---|
| Opening stock | In | Opening balance equity |
| Found on count | In | Inventory gain |
| Free sample received | In | Other income |
| Damage / breakage | Out | Breakage expense |
| Expiry write-off | Out | Expiry loss |
| Sample issued | Out | Marketing expense |
| Internal consumption | Out | Administrative expense |

The mapping is tenant configuration; the screen shows the resolved account and lets a permitted role
override it, with the override marked.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save draft | secondary | `stock:post` | no | Draft; **no movement** |
| Save & post | primary | `stock:post` | **yes — direction, items, total qty, total value, offset account, period** | Kernel posts the movement; the engine posts the journal |
| Print | secondary | `Inventory` | no | Stock entry slip |

## 7. Financial rules

- The module calls `inventoryKernel.postMovement` inside the transaction; it never writes
  `stock_movements` and never constructs journal lines.
- Posting is idempotent.
- Closed period blocks posting; drafts allowed.
- A posted entry is immutable — correction is a reversing entry of the opposite direction, linked.

## 8. States

Insufficient stock; missing batch; missing reason or offset; negative cost; closed period; post
failure; no confirmation received.

## 9. Responsive · 10. Accessibility

`md` the grid scrolls with Product sticky · `sm` read-only.
Barcode input is a labelled field with a scanner hint; the totals bar is `aria-live`.

## 11. Open questions

1. Does a manual Stock In need approval above a value threshold?
2. Should opening stock be a separate, once-only migration screen rather than a reason here?
3. Is the offset account override allowed at all, or fixed by configuration?
