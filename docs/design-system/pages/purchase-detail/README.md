# Purchase invoice detail

| | |
|---|---|
| **Route** | `/purchases/:id` |
| **Archetype** | C — Document detail |
| **Module / permission** | Purchasing · `Purchasing` |
| **Prototype source** | `ui-prototype/src/detail-pages.tsx` (`PurchaseDetail`) |
| **Posts to the ledger** | **yes** — post a draft, reverse a posted purchase |

## 1. Purpose

The permanent record of one supplier invoice / goods receipt: what arrived, in which batches, at
what cost, what it posted, and what has been paid.

## 2. Anatomy

```
Breadcrumbs   Purchasing > Purchases > PI-2026-000412
DocHeader     PI-2026-000412 (h1) · [Posted] · supplier · Rs 1,256,000 · [Record payment] [Print] [More v]
PostingStrip  Draft > Posted > (Partially paid) > Paid / Reversed
DefinitionGrid Purchase date · Supplier · Supplier bill # · Bill date · Payment type · Due date ·
               Warehouse · Branch · Narration · Created by · Posted on
LineTable     Product · Batch · Expiry · Qty · Bonus · Unit cost · Disc · GST · Amount
TotalsCard    Gross · Discount · GST input · **Net payable** · amount in words
PaymentPanel  Payments allocated: date · voucher · amount · balance due · WHT deducted
LedgerImpact  Inventory · GST input · Payable
StockPanel    Movements created: product, batch, qty in, unit cost, resulting average cost
AuditStamp + Timeline + Attachments (supplier bill scan)
```

## 3. Components

`DocHeader` · `PostingStatusStrip` · `DefinitionGrid` · `DataTable` · `TotalsCard` ·
`LedgerImpactCard` · `AuditStamp` · `Timeline` · `AttachmentList` · `PrintDocument` ·
`ConfirmDialog`.

## 4. Actions by status

| Status | Available |
|---|---|
| Draft | Edit · Post (confirm, shows stock impact) · Cancel (confirm) · Print |
| **Posted** | Record payment · Create return · Reverse (confirm, `voucher:reverse`) · Print — **no edit** |
| Partially paid / Paid | Record payment (until settled) · Create return · Print |
| Reversed | Print · banner linking to the reversing document |

## 5. Financial rules

- Reversal reverses **stock and the payable together**. A reversal is refused when the received
  stock has already been sold and reversing would drive that batch negative — the dialog names the
  batch, the quantity and the documents that consumed it, and offers a purchase return instead.
- The stock panel shows the movements the inventory kernel wrote, including the resulting weighted
  average cost.
- The supplier bill attachment is part of the audit record for FBR purposes and cannot be removed
  after posting.
- Closed period: reversal is offered into the first open period.

## 6. States

Not found / other tenant → shared Not found. Reversal blocked by consumed stock → the explanatory
dialog above. Missing supplier bill scan → an advisory chip, not an error.

## 7. Responsive · 8. Accessibility

`md` definition grid 4 → 2, panels stack · `sm` line table scrolls with Product sticky.
`h1` is the purchase number; the cost columns are labelled so a screen reader distinguishes unit
cost from amount.

## 9. Open questions

1. Does a reversal require a reason?
2. Should the resulting average cost be visible to the purchase officer, or finance roles only?
3. Retention period for supplier bill scans.
