# Stock transfer

| | |
|---|---|
| **Route** | `/inventory/transfer` |
| **Archetype** | B — Document entry |
| **Module / permission** | Inventory · `Inventory` · `stock:post` |
| **Prototype source** | `ui-prototype/src/stock-transfer.tsx` (`StockTransferPage`), `src/inventory-pages.tsx` (transfer view) |
| **Reference frame** | `ui-prototype/design/stock transer page .png` |
| **Posts to the ledger** | **yes** — a movement between locations; value moves, total value does not change |

## 1. Purpose

Move stock between warehouses, branches or vans with a manifest that the receiving side confirms.
Transfers are where stock most often goes missing, so the document is two-sided by design.

## 2. Anatomy

```
DocHeadBar   "Stock transfer" · [Save draft] [Save & post] [Print slip]
FormSection  Transfer No. (Auto) · Date · **From location *** · **To location *** · Carrier ·
             Vehicle / rep · Expected arrival · Narration
LineGrid     # · Product * · Batch * · Expiry · Available at source · **Transfer qty *** · Unit ·
             Unit cost · Value · ✕
TotalsBar    Items · Total qty · Total value
Preview      "Transfer Slip Preview" — the printable manifest
History      "Recent Transfers": Transfer · Date · From → To · Items · Value · Status · Actions
```

## 3. Components

`FormSection` · `LocationPicker` · `LineItemGrid` · `ProductPicker` (scoped to the source location's
stock) · `QuantityInput` · `PrintDocument` (slip) · `ConfirmDialog` · `IdempotencyGuard` ·
`DataTable` (history) · `StatusBadge`.

## 4. Two-sided flow

```
Draft ──post──> In transit ──receive──> Received
                    │
                    └──> Partially received  (short/damaged lines recorded with a reason)
```

- Posting the transfer moves stock **out of the source into an in-transit location**, not directly
  into the destination. In-transit stock is visible, valued and attributable.
- The destination confirms receipt line by line. A shortfall is recorded with a reason and posts a
  loss — it is never absorbed silently.
- Source and destination must differ; the form refuses otherwise.
- Transfer quantity may not exceed available at source for that batch.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save draft | secondary | `stock:post` | no | Draft; no movement |
| Save & post | primary | `stock:post` | **yes — from, to, items, qty, value, period** | Moves stock to in-transit |
| Receive | primary (on an in-transit transfer) | `stock:post` at the destination | **yes — per-line received quantities and any shortfall** | Moves in-transit into the destination; posts shortfall losses |
| Print slip | secondary | `Inventory` | no | Manifest for the driver |

## 6. Financial rules

- A transfer does not change **total** inventory value; it changes where the value sits. The
  confirm dialog says exactly that, so nobody expects a P&L effect.
- Shortfalls on receipt post a loss to the configured account, with a reason.
- The inventory kernel writes both legs; the module raises the event.
- Closed period blocks posting on either leg.

## 7. States

In transit for longer than the expected arrival → `warn` chip and a KPI on the inventory overview.
Closed period, insufficient stock, same-location, post failure — each with specific copy.

## 8. Responsive · 9. Accessibility

`md` the slip preview moves below the grid · `sm` receiving is supported (it is a warehouse task);
creating a transfer is desktop-only. The from/to selectors are labelled unambiguously and the
direction is stated in text on the confirm dialog, not only by an arrow.

## 10. Deviations from the prototype

The prototype posts a transfer as a single instantaneous movement. Production requires the
in-transit leg — without it, stock in a van is invisible and shortfalls have nowhere to land.

## 11. Open questions

1. Are vans/reps modelled as locations? (They must be for in-transit to work.)
2. Who may confirm receipt — anyone at the destination, or a named role?
3. Is a transfer between tenants ever possible? (Assumed **never**.)
