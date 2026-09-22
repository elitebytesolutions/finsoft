# Customers

| | |
|---|---|
| **Route** | `/customers` |
| **Archetype** | A — Register |
| **Module / permission** | Parties · `Masters` · create needs `master:create` |
| **Prototype source** | `ui-prototype/src/parties.tsx` (`PartyList`, kind `Customer`) |
| **Reference frame** | `ui-prototype/design/customer listings page .png` |
| **Posts to the ledger** | no — creating a customer creates its control-account sub-ledger |

## 1. Purpose

The customer directory: who they are, where they are, what they owe, and whether we should keep
selling to them on credit.

## 2. Anatomy

```
PageHead   "Customers" · [Import] [Export] [+ New customer]
KpiRow     Customers · Active this month · Total outstanding · Over limit / on hold
FilterBar  search (name, code, phone, NTN) · city · area · salesman · status · balance band
DataTable  Code · Name · Type · City · Phone · Dealing Person · NTN # · Balance (Rs) · Status · Actions
Footer     showing · total outstanding · pager
Wizard     "Create New" — stepped party form
```

## 3. Components

`KpiRow` · `FilterBar` · `DataTable` · `Stepper` + `Modal` (create wizard) · `StatusBadge` ·
`ExportMenu` · `ImportDialog` · `PartyLink`.

## 4. Columns

| Column | Align | Format | Priority |
|---|---|---|---|
| Code | left | tabular, links to `/customers/:code` | 1 |
| Name | left | name (700) + 9.5px area | 1 |
| Type | left | Retail · Wholesale · Hospital · Clinic · Institution | 3 |
| City / Area | left | text | 3 |
| Phone | left | tabular, click-to-call on touch | 4 |
| Dealing Person | left | contact name | 5 |
| NTN # | left | tabular; `warn` chip when missing and the customer is a filer | 4 |
| Balance (Rs) | right | money; brackets and `--money-negative` when in credit | 1 |
| Status | left | Active `good` · Inactive `neutral` · On hold `danger` | 2 |
| Actions | right | View · Ledger · New sale · Record receipt · Edit · Deactivate | 1 |

## 5. Create wizard steps

1. **Identity** — code (auto-suggested), name, type, NTN/STRN, filer status
2. **Contact & address** — dealing person, phone, email, address, city, area, route
3. **Commercial** — salesman, price list, credit limit, payment terms, opening balance
4. **Review** — everything, with the opening balance's accounting effect stated

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New customer | primary | `master:create` | **yes when an opening balance is entered** — it posts | Creates the party and its sub-ledger |
| Edit | row | `master:edit` | credit limit change: yes | Code read-only once postings exist |
| Deactivate | row | `master:edit` | **yes, refused with a balance outstanding** | Hidden from pickers |
| Delete | — | — | — | **Never offered** |
| Import | secondary | `master:create` | yes, with a validation preview | CSV with per-row errors |

## 7. Financial rules

- **Opening balance is a posting**, not a field: it raises an opening-balance event, is dated, and
  is refused in a closed period. The wizard's final step says so in words.
- Balance is server-computed from the sub-ledger. The client never sums invoices.
- A customer with any posting can be deactivated but never deleted.
- Credit limit and hold status are shown here and maintained on [credit limits](../credit-limits/).

## 8. States

Empty with an import offer; filtered empty; a customer over limit or on hold carries a `danger` chip
in the status column and sorts into the KPI count.

## 9. Responsive · 10. Accessibility

`xl` hides Dealing Person and NTN · `md` filter sheet · `xs` card list: name, city, balance, status.
The wizard announces step changes; the balance cell's credit state is in its accessible label, not
only in brackets.

## 11. Open questions

1. Is the customer code auto-generated, and can it be edited before first posting?
2. Are routes/areas a maintained master or free text?
3. Does a customer need a linked GL account, or is a single control account with sub-ledgers used?
   (ADR needed — this shapes the chart of accounts.)
