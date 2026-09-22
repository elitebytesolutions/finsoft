# Purchase orders

| | |
|---|---|
| **Route** | `/po` |
| **Archetype** | A — Register + B — entry modal |
| **Module / permission** | Purchasing · `Demand & PO` · create needs `po:create` |
| **Prototype source** | `ui-prototype/src/purchase-orders.tsx` (`PurchaseOrders`) |
| **Reference frame** | `ui-prototype/design/purchase order.png` |
| **Posts to the ledger** | **no** — a PO is a commitment, not a transaction |

## 1. Purpose

Raise supplier orders from demand, track them to receipt, and convert a received order into a
purchase voucher without retyping.

## 2. Anatomy

```
PageHead   "Purchase Orders" · [Export] [+ New purchase order]
KpiRow     Open POs · Value committed · Overdue deliveries · Converted this month
Board      Status lanes: Draft · Sent · Partially received · Received · Cancelled   (optional view)
Table      "Search & Listing" — PO No. · Date · Supplier · Lines · Amount · Expected · Status · Actions
Modal      "New Purchase Order": supplier · date · expected date · branch · notes
           line grid: product · pack · qty · rate · amount · ✕
           totals: lines · qty · value
```

Two view modes: **Table** (default) and **Board** by status.

## 3. Components

`KpiRow` · `DataTable` · `SegmentedControl` (table/board) · `Modal` (wide) · `LineItemGrid` ·
`ProductPicker` · `PartyPicker` · `StatusBadge` · `ConfirmDialog`.

## 4. Columns

| Column | Align | Format |
|---|---|---|
| PO No. | left | server number, links to the PO |
| Date / Expected | left | dates; expected in `danger` when past and not received |
| Supplier | left | name, links to the vendor |
| Lines | right | count |
| Amount | right | money — labelled **Committed value**, not an expense |
| Status | left | Draft `warn` · Sent `info` · Partially received `warn` · Received `good` · Cancelled `danger` |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New PO | primary | `po:create` | no | Creates a draft |
| Send to supplier | primary (row) | `po:create` | yes | Status → Sent; generates the PDF/email |
| **Convert to purchase** | primary (row) | `purchase:create` | **yes — carries lines into a purchase voucher draft** | Opens `/purchasing/voucher` pre-filled; **it does not post** |
| Cancel PO | danger | `po:create` | yes, reason | Status → Cancelled; the commitment is released |
| Print / Export | secondary | `Purchasing` / `Reports` | no | PO PDF / filtered set |

## 6. Financial rules

- A purchase order **posts nothing**. Its value is a commitment shown for cash planning, and it is
  never included in payables, expenses or stock.
- Conversion creates a **draft purchase**, which a human reviews and posts. There is no
  PO → posted-purchase path in one click, because quantities and prices change between order and
  delivery.
- Partial receipt leaves the PO open with the outstanding quantity per line.

## 7. States

Empty, filtered empty, error. An overdue expected date carries a `danger` chip. A PO whose supplier
has been deactivated shows an inline warning and blocks sending.

## 8. Responsive · 9. Accessibility

`md` board becomes a stacked list per status; the modal becomes a full-screen sheet ·
`xs` read-only card list. Board lanes are labelled regions with counts in the accessible name.

## 10. Open questions

1. Do POs need approval above a threshold before they can be sent?
2. Is partial receipt tracked per line or per PO?
3. Does the demand engine auto-create draft POs, and if so, marked how?
