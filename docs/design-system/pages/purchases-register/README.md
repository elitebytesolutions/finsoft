# Purchases register

| | |
|---|---|
| **Route** | `/purchasing` |
| **Archetype** | A — Register |
| **Module / permission** | Purchasing · `Purchasing` · create needs `purchase:create` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Purchasing`) |
| **Reference frame** | `ui-prototype/design/purchases register page .png` |
| **Posts to the ledger** | indirectly — posting happens on the purchase voucher |

## 1. Purpose

Every supplier invoice and goods receipt, with its posting status and its payable position. The
purchase officer works the drafts; the accountant checks what posted.

## 2. Anatomy

```
PageHead   "Purchases" · "Receive supplier invoices and post stock in one controlled workflow."
           [Export] [Print documents] [+ New purchase]
KpiRow     Purchases this month · Awaiting posting (drafts) · Open payables · GST input this month
FilterBar  search · date range · supplier · status · branch · GRN / invoice
DataTable  Purchase no. · Date · Supplier · Supplier bill # · Product/lines · Quantity · Amount ·
           Status · Actions
Footer     showing · period totals · pager
```

## 3. Components

`KpiRow` · `FilterBar` · `DataTable` · `StatusBadge` · `ExportMenu` · `ConfirmDialog` · `PartyLink`.

## 4. Columns

| Column | Align | Format | Priority |
|---|---|---|---|
| Purchase no. | left | server number, links to `/purchases/:id` | 1 |
| Date | left | `01 Aug 2026` | 1 |
| Supplier | left | name + 9.5px city, links to the vendor | 1 |
| Supplier bill # | left | the supplier's own number — **required for duplicate detection** | 2 |
| Product / lines | left | first product + `+n more` | 4 |
| Quantity | right | total units | 4 |
| Amount | right | money, 700 | 1 |
| Status | left | Draft `warn` · Posted `good` · Partially paid `warn` · Paid `good` · Returned `info` · Reversed `danger` | 2 |
| Actions | right | View · Post (draft) · Record payment · Create return · Print | 1 |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New purchase | primary | `purchase:create` | — | `/purchasing/voucher` |
| Post (row, draft) | inline | `purchase:create` | **yes — shows stock and ledger impact** | Posts stock in and the payable |
| Record payment | row | `payment:create` | — | `/payments` pre-filled |
| Create return | row | `purchase:create` | — | `/purchasing/returns` linked |
| Print documents | secondary | `Purchasing` | no | `/purchasing/print` |

## 6. Financial rules

- A posted purchase is immutable; correction is a debit note (return) or a reversal.
- **Duplicate supplier bill numbers per supplier are refused** at entry and flagged here if they
  slip through a migration — a duplicate bill is how a business pays twice.
- Posting a purchase moves stock **and** raises the payable in one transaction; neither happens
  without the other.
- KPI totals are posted purchases only, and the drafts figure is shown separately because unposted
  purchases are unrecorded liabilities.

## 7. States

Empty, filtered empty, error, permission — standard.
A draft older than 7 days carries a `warn` chip ("unposted for 9 days").

## 8. Responsive · 9. Accessibility

`xl` hides Quantity and lines · `md` filter sheet · `xs` card list.

## 10. Open questions

1. Are GRN and purchase invoice one document or two in MVP? (The prototype treats them as one.)
2. Is landed cost (freight, duty) apportioned at purchase, and where does the UI capture it?
3. Does GST input need a separate register for the tax return?
