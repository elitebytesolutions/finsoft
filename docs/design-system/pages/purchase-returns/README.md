# Purchase returns (debit notes)

| | |
|---|---|
| **Route** | `/purchasing/returns` |
| **Archetype** | B — Document entry (against a source document) |
| **Module / permission** | Purchasing · `Purchasing` · `purchase:create` |
| **Prototype source** | `ui-prototype/src/purchase-returns.tsx` (`PurchaseReturns`) |
| **Reference frames** | `design/purchase return page 1.png`, `design/purchase return page 2 effect.png` |
| **Posts to the ledger** | **yes** — reduces stock, payable and GST input |

## 1. Purpose

Send goods back to a supplier — expiry, damage, over-supply, wrong item — against the original
purchase, and post the debit note.

## 2. Anatomy

```
PageHead     "Purchase Returns" · [Export] [+ New purchase return]
KpiRow       Returns this month · Value · Pending supplier credit · Expiry returns due
SourcePicker Purchase · Date · Supplier · Supplier bill # · Items · Amount · [Select]
ReturnForm   "New Purchase Return": Return # (Auto) · date · supplier (locked) · reference # ·
             supplier bill # · payment type · reason
LineGrid     # · Product Name · Pack · Batch No. · Expiry Date · Purchased qty · Already returned ·
             **Returned Qty** · L.S-Qty · Bonus · Rate · Disc % · Disc. · % GST · GST · Amount · ✕
TotalsBar    Items · Returned qty · Gross · Discount · GST · **Net debit**
EffectPanel  "Effect" — stock reduction by batch, payable reduction, GST input reversal
```

The prototype's second reference frame (`purchase return page 2 effect.png`) is the **effect panel**
— it is mandatory, not optional: the user sees the consequence before posting.

## 3. Components

`KpiRow` · `DataTable` (source picker) · `LineItemGrid` · `ReasonSelect` · `TotalsBar` ·
`LedgerImpactCard` (the effect panel) · `ConfirmDialog` · `IdempotencyGuard`.

## 4. Rules

- A return must reference a posted purchase and a specific batch.
- Returned quantity may not exceed received less already-returned **and** may not exceed the
  quantity still on hand in that batch. Both limits are shown in the cell, and the tighter one
  applies — you cannot return stock you have already sold.
- Rate defaults to the purchase rate and is read-only unless the tenant allows negotiated returns
  (then it is an override that is marked).
- Reason from a controlled list: Expiry · Damage · Wrong item · Over-supply · Quality · Recall.
- Expiry returns may need the supplier's expiry-return window; when a batch is outside it, the row
  warns with the window dates.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save draft | secondary | `purchase:create` | no | Draft; no stock, no ledger |
| Save & post | primary | `purchase:create` | **yes — items, qty, net debit, stock effect, period** | Posts the debit note, reduces stock and the payable, reverses GST input |
| Print debit note | secondary | `Purchasing` | no | `PrintDocument` |

## 6. Financial rules

- Cost of the returned stock is the **weighted-average cost at the time of the return**, not the
  original purchase rate, unless the tenant's policy is specific-cost — the effect panel states
  which is used and shows any difference as a cost variance line.
- The original purchase is never modified.
- Closed period blocks posting.

## 7. States

No returnable purchases; quantity exceeded (with both limits named); stock already sold; outside the
supplier's return window; closed period; post failure.

## 8. Responsive · 9. Accessibility

`lg` the grid scrolls with Product sticky · `md` the effect panel moves below the totals ·
`sm` read-only. Quantity cells are labelled with product and batch; the effect panel is a table, not
a graphic.

## 10. Open questions

1. Is the supplier credit note tracked as a receivable from the supplier, or netted against the next
   purchase?
2. Who approves a return above a value threshold?
3. Are expiry-return windows per supplier a master data field?
