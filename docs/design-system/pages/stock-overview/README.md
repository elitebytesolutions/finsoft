# Stock & valuation

| | |
|---|---|
| **Route** | `/inventory` · views `/inventory/issue`, `/inventory/count`, `/inventory/as-of`, `/inventory/batches` |
| **Archetype** | A — Register (multi-view) |
| **Module / permission** | Inventory · `Inventory` · posting needs `stock:post` |
| **Prototype source** | `ui-prototype/src/inventory-pages.tsx` (`InventoryWorkspace`) |
| **Reference frames** | `design/whole stock page .png`, `design/stocks page stock in .png` |
| **Posts to the ledger** | **yes** on the count and issue views — via the inventory kernel |

## 1. Purpose

What we hold, where, in which batches, worth how much — and the operations that change it. One
screen with five views rather than five screens, because the stock figure must be the same in all of
them.

## 2. Anatomy

```
PageHead   "Inventory / Stock operations" · title per view · [Export] [view actions]
KpiRow     Inventory value · Units on hand · Below reorder · Expiry watch
ViewTabs   Overview · Batches & expiry · Issue & adjustment · Stock count · Stock as-of
Body       per view (below)
```

| View | Body |
|---|---|
| **Overview** | "Current stock by product": Product · Category · Batches · Next expiry · On hand · Reorder at · Value · Health · Actions |
| **Batches & expiry** | Product · Batch · Expiry · Days remaining · Qty · Value · Disposition |
| **Issue & adjustment** | Issue form (product, batch, qty, reason, account) + recent issues |
| **Stock count** | Product · Batch · Expiry · System qty · **Physical qty** · Variance · Status + post action |
| **Stock as-of** | Product · Category · Quantity · Avg. cost · Stock value · Reorder status, at a chosen date |

## 3. Components

`Tabs` · `KpiRow` · `DataTable` · `FormSection` (issue) · `QuantityInput` · `ProductPicker` ·
`ReasonSelect` · `ConfirmDialog` · `StatusBadge` · `ExportMenu`.

## 4. Formatting

| Figure | Rule |
|---|---|
| On hand | right, unit in the header; `danger` when negative, `warn` below reorder |
| Value | right, money; the **carried inventory value** — `value_on_hand` from the costing scope, server-computed. **Never `avg cost × qty`** (ADR-0015 §7) |
| Days remaining | right; `danger` ≤ 30, `warn` ≤ 90 |
| Health | Healthy `good` · Low `warn` · Out `danger` · Expiring `warn` · Excess `info` |
| Variance (count) | right, signed, in brackets when negative, `--money-negative` |

Cost and value columns are hidden from roles without `stock:view-cost`.

## 5. Actions

| Action | View | Permission | Confirm | Result |
|---|---|---|---|---|
| Post issue / adjustment | Issue | `stock:post` | **yes — product, batch, qty, reason, account, the loss or expense it posts** | Inventory kernel writes the movement; the posting engine writes the journal |
| Post count variance | Count | `stock:post` | **yes — variance per line and the total value effect** | Posts an adjustment; the count sheet becomes immutable |
| Export | any | `Reports` | no | Filtered set with as-at date |

## 6. Financial rules

- **The module never writes `stock_movements`** — it calls the inventory kernel, which posts the
  movement and raises the accounting event in the same transaction.
- Stock quantity is truth ([NON_NEGOTIABLES](../../../NON_NEGOTIABLES.md)); no screen may edit a
  quantity directly. Every change is a movement with a reason and a document.
- A stock count posts a **variance adjustment**, never an overwrite of the system quantity.
- The "as-of" view is a point-in-time reconstruction from movements, and it states the timestamp it
  was computed at.
- Closed period blocks issue and count posting; viewing is unaffected.

## 7. States

Negative stock is shown, never hidden, with a `danger` badge and a link to the movements that caused
it. Empty, filtered empty, error, permission — standard. A count sheet in progress is shown as a
resumable draft.

## 8. Responsive · 9. Accessibility

`xl` hides Category and Reorder at · `md` the issue form becomes a drawer · `xs` card list,
read-only. The physical-quantity cell in a count is labelled with product and batch; the variance is
`aria-live`.

## 10. Deviations from the prototype

The prototype renders several of these views from static rows. Production requires every view to
read from the same server stock projection so the four figures cannot disagree.

## 11. Open questions

1. Is a blind count (system quantity hidden during entry) required?
2. Which reasons post to which expense accounts, and who maintains that mapping?
3. Multi-warehouse: a filter, a column, or a scope selector in the top bar?
