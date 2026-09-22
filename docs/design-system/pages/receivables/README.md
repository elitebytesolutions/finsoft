# Accounts receivable

| | |
|---|---|
| **Route** | `/receivables` |
| **Archetype** | A — Register (balances + ageing + invoices) |
| **Module / permission** | Accounting · `Cash, Bank & GL` |
| **Prototype source** | `ui-prototype/src/finance-pages.tsx` (`AccountsReceivable`) |
| **Posts to the ledger** | no — receipts are posted from `/payments` |

## 1. Purpose

Know what customers owe, how old it is, and who to chase first. The recovery team works this screen
every morning.

## 2. Anatomy

```
PageHead   "Accounts receivable" · "Credit sales, customer balances and ageing — chase what is owed."
            [as-at date v] [Export] [Send statements]
KpiRow     Outstanding · 0–30 days · 31–60 days · Over 90 days
Grid       [ Customer balances ]            [ Ageing summary ]
             Customer · Type · Open invoices   bucket bars + figures + share
             · Outstanding · [Open]
Table      "Credit invoices"
           Invoice · Date · Customer · Product · Qty · Total · Days · Status · Actions
```

## 3. Components

`KpiRow` · `DataTable` (two) · `AgeingChart` (stacked bar, tokens only) · `StatusBadge` ·
`ExportMenu` · `PartyLink`.

## 4. Columns & formatting

| Column | Align | Format |
|---|---|---|
| Customer | left | name (700) + 9.5px city; links to the customer record |
| Open invoices | right | count |
| Outstanding | right | money; `--money-negative` if the customer is in credit (i.e. overpaid) |
| Days | right | age in days from the due date; `danger` above the customer's terms |
| Status | left | Open `neutral` · Partially paid `warn` · Overdue `danger` · Paid `good` |

Ageing buckets are **fixed product-wide**: 0–30, 31–60, 61–90, over 90, measured from the **due
date**, not the invoice date. The as-at date is stated on every card and every export.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Record receipt | primary (row) | `payment:create` | — | Routes to `/payments` with the customer and invoice pre-selected |
| Send statement | secondary | `Reports` | yes (count) | Generates a customer statement PDF per selected customer |
| Open customer | link | `Masters` | no | `/customers/:code` |
| Export | secondary | `Reports` | no | Filtered set with as-at date |

Nothing on this page posts. Every path to money received goes through the payments screen, where
allocation and withholding tax are handled properly.

## 6. Financial rules

- Outstanding is **server-computed** from posted invoices less posted allocated receipts. The client
  never subtracts.
- A customer in credit shows a negative outstanding in brackets, not a zero.
- Figures exclude drafts; the page says "posted documents only".
- The ageing total must equal the outstanding KPI; if a filter breaks that, the page says so.

## 7. States

Empty: "No outstanding receivables." Filtered empty, error — standard.
A customer over their credit limit carries a `danger` chip linking to `/credit-limits`.

## 8. Responsive · 9. Accessibility

`md` the two panels stack, ageing becomes a list of buckets with figures · `xs` card list.
The ageing chart has a table equivalent; bucket colours are never the only signal.

## 10. Open questions

1. Are ageing buckets configurable per tenant? (Assumed **no** for MVP — fixed 30/60/90.)
2. Do we age by invoice date or due date when a customer has no terms recorded?
3. Is a dunning/reminder workflow in scope, or only statement generation?
