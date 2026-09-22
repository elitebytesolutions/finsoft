# Sales returns (credit notes)

| | |
|---|---|
| **Route** | `/sales-returns` |
| **Archetype** | B — Document entry (against a source document) |
| **Module / permission** | Sales & POS · `Sales & POS` · `sale:create` |
| **Prototype source** | `ui-prototype/src/sales-return.tsx` (`SalesReturn`) |
| **Reference frame** | `ui-prototype/design/sales return page .png` |
| **Posts to the ledger** | **yes** — reverses revenue, tax, receivable, COGS and returns stock |

## 1. Purpose

Take goods back from a customer against the original invoice, with the correct batches, and post the
credit note. In pharmacy distribution this is routine — expiry returns, damaged strips, wrong item —
so it is a first-class document, not an edit of the sale.

## 2. Anatomy

```
PageHead     "Sales returns" · "Process customer returns against original sales invoices."
             [Export] [+ New return]
KpiRow       Open invoices · Potential return value · Return items · Returns this month
SourcePicker "Sales register for returns" — Invoice · Date · Customer · Product · Qty · Total ·
             Status · [Select]
ReturnForm   Return # (Auto) · Return date · Reason · Reference to invoice (locked once chosen)
LineGrid     Product · Batch · Expiry · Sold qty · Already returned · **Return qty** · Rate ·
             Disc % · GST % · Amount · Disposition (Saleable / Quarantine / Destroy)
TotalsBar    Items · Return qty · Gross · GST · **Credit amount**
LedgerPreview the reversing journal + stock receipt
```

## 3. Components

`KpiRow` · `DataTable` (source picker) · `LineItemGrid` · `ReasonSelect` · `QuantityInput` ·
`TotalsBar` · `LedgerImpactCard` · `ConfirmDialog` · `IdempotencyGuard`.

## 4. Rules

- A return **must** reference a posted invoice. Returns without a source are not supported in MVP;
  if a tenant needs one, it is a journal voucher with an explicit reason.
- Return quantity may not exceed sold quantity less already-returned quantity, per batch. The cell
  shows both figures and refuses the excess.
- The batch returned is the batch sold. Changing it requires a supervisor reason and is marked.
- Disposition drives where stock goes: **Saleable** returns to sellable stock at the original cost;
  **Quarantine** goes to a quarantine location; **Destroy** posts a write-off instead of a stock
  receipt. The ledger preview changes accordingly and the user sees it before posting.
- Reason is from a controlled list: Expiry · Damage · Wrong item · Over-supply · Customer refusal ·
  Recall.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save draft | secondary | `sale:create` | no | Draft; no stock, no ledger |
| Save & post | primary | `sale:create` | **yes — items, qty, credit amount, disposition, period** | Posts the credit note, returns or writes off stock, updates the invoice balance |
| Print credit note | secondary | `Sales & POS` | no | `PrintDocument` |

## 6. Financial rules

- The credit note is a **new document**; the original invoice is never modified.
- COGS reversal uses the cost the original issue used, not today's average.
- Destroy disposition posts a loss, not a stock receipt — a different journal, shown in the preview.
- Closed period blocks posting; the original invoice being in a closed period does **not** block a
  return in an open one.

## 7. States

No open invoices for the customer; return quantity exceeded; batch expired on return (allowed, but
disposition is forced to Quarantine or Destroy); closed period; post failure.

## 8. Responsive · 9. Accessibility

`md` source picker collapses to a search field with a result list · `sm` read-only.
Return-quantity cells are labelled with product and batch; the disposition select states its
consequence in its option text ("Destroy — posts a write-off").

## 10. Open questions

1. Does a return against a **cash** sale pay the customer, or create an on-account credit?
2. Are expiry returns to the supplier linked to the customer return (three-way)?
3. Who may choose the Destroy disposition?
