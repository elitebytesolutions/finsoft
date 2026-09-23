# Stock vouchers (gift, breakage & adjustments)

| | |
|---|---|
| **Route** | `/inventory/breakage` |
| **Archetype** | B — Document entry (tabbed by voucher type) |
| **Module / permission** | Inventory · `Inventory` · `stock:post` |
| **Prototype source** | `ui-prototype/src/stock-vouchers.tsx` (`StockVouchers`) |
| **Reference frames** | `design/breakage voucher tab.png`, `design/gift voucher tab.png` |
| **Posts to the ledger** | **yes** — each type posts a different expense |

## 1. Purpose

The named stock write-offs a distribution business does daily: goods given away (gift/sample),
goods destroyed (breakage/expiry), and other adjustments. Each type has its own expense account and
its own approval expectations, so they are separate tabs of one document rather than one generic
"adjustment".

## 2. Anatomy

```
PageHead   "Stock Vouchers" · [Export] [+ New voucher]
TypeTabs   [ Gift ] [ Breakage ] [ Expiry ] [ Sample ] [ Other adjustment ]
Grid       [ Voucher Details ]            [ Items ]
             Voucher No (Auto) · Date ·     # · Product Code · Product Name · Batch/Lot ·
             Type (locked to tab) ·         Expiry Date · Qty * · UOM · Rate · Amount · Remark · ✕
             Employee / Guest (gift) ·      [+ Add row]
             Reason * · Reference ·
             Offset account (resolved)      TotalsBar: Total Items · Total Qty · **Total Amount**
History    "Previous Vouchers": Voucher No · Date · Type · Total Items · Total Qty · Total Amount ·
           Created By · Status · Actions
```

## 3. Components

`Tabs` (type) · `FormSection` · `LineItemGrid` · `ProductPicker` · `QuantityInput` ·
`ReasonSelect` · `AccountPicker` (resolved, usually read-only) · `ConfirmDialog` ·
`IdempotencyGuard` · `DataTable` (history) · `StatusBadge`.

## 4. Type behaviour

| Type | Recipient field | Posts to | Notes |
|---|---|---|---|
| Gift | Employee / guest / customer, required | Marketing or staff-welfare expense | Named recipient is mandatory — an unnamed gift is a control weakness |
| Breakage | — | Breakage expense | Physical evidence / photo may be required by tenant policy |
| Expiry | — | Expiry loss | Only batches at or past expiry are selectable |
| Sample | Doctor / customer, required | Sample expense | Relevant for pharma compliance reporting |
| Other adjustment | — | Chosen by the user from a permitted set | Reason mandatory; the widest permissions requirement |

Rate is the current weighted-average cost, read-only, so the value of what is being written off is
visible before posting.

**This multiplication is legitimate and must not be "corrected".** A write-off is an outward
movement, and its value is `round(quantity x unit_cost, 4)` -- rounding boundary 2 in ADR-0015 §3.
What ADR-0015 §7 forbids is valuing the stock that *remains* as `quantity_on_hand x average_cost`.
Costing an outward movement at the average is the rule; recomputing the balance from it is the
defect.

**When a write-off removes the LAST units, the sell-out residual rule applies** (ADR-0015 §5): the
carried value is flushed to zero and any difference between it and the computed outward value is
posted as the residual leg, in the same entry. Quantity and value reach zero together. The debit is
the expense account this voucher names, not Cost of Goods Sold, but the flush itself is identical
to a sale's. A write-off that zeroes the quantity while leaving a few paise of value behind is the
bug this rule exists to prevent, and the confirmation dialog's total must reflect the flushed
figure, not the pre-flush product.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save draft | secondary | `stock:post` | no | Draft; no movement |
| Save & post | primary | `stock:post` | **yes — type, recipient, items, qty, total value, expense account, period** | Kernel posts the stock out; engine posts the expense |
| Print | secondary | `Inventory` | no | Voucher slip for signature |

Tenants may require approval above a value threshold; when configured, `Save & post` becomes
`Submit for approval` and the voucher appears in `/approvals`.

## 6. Financial rules

- Every type reduces stock **and** posts an expense in one transaction, through the kernel.
- The expense account is resolved from the type and reason; overriding it requires a permission and
  is marked on the document.
- Expired batches cannot be gifted or sampled — only written off under Expiry.
- Posted vouchers are immutable; correction is a reversing stock-in with the same reason, linked.
- Closed period blocks posting.

## 7. States

Empty history; no selectable batches for the type (e.g. no expired batches); over-threshold needing
approval; closed period; post failure.

## 8. Responsive · 9. Accessibility

`md` details and items stack · `sm` read-only.
Tabs announce the type; the recipient field's required state changes with the tab and is announced.

## 10. Open questions

1. What value thresholds require approval, per type?
2. Is photographic evidence required for breakage, and where is it stored?
3. Do sample vouchers feed a regulatory report?
