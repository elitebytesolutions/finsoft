# Customers

| | |
|---|---|
| **Route** | `/customers` |
| **Archetype** | A — Register |
| **Module / permission** | Parties · `Masters` · create needs `master:create` |
| **Prototype source** | `ui-prototype/src/parties.tsx` (`PartyList`, kind `Customer`) |
| **Reference frame** | `ui-prototype/design/customer listings page .png` |
| **Posts to the ledger** | no — creating a customer creates its control-account sub-ledger |

## API note — M4-W (2026-09-29)

Wired to the real customers API (`docs/design/M3/api-contract.md` §2, §4.1: C1 list, C2 create).
Per the M4-W course correction (binding on this lane), the ported screen's markup, columns and
wizard **stay** — only the data source changed, via an adapter
(`apps/web/src/lib/adapters/customers.ts`) that maps the real `Customer`/`CustomerListItem` DTOs
into the mock's `Master` shape `PartyList`/`CustomerTable` already read. `ui-plan.md` §3's plan to
**remove** Type, Dealing Person, NTN #, Area and Salesman is **not** what shipped: those columns
and filter controls stay in place, showing `—` (or disabled, for the two filters with no real
field to filter by — Customer Type, Area) rather than being deleted. `ui-plan.md`'s column removal
plan is superseded by this note for the columns; its two structural rulings still hold: the create
wizard's Code field is **read-only, server-assigned** (§5, first step), and there is no opening-
balance field (§7 — `OPENING_BALANCE_LOADED` has no posting rule).

**Balance (Rs) column added** to the list view (`CustomerTable`) — the real `balance`/`balanceAsOf`
from C1, Dr/Cr formatted server-side-signed, never summed in the browser. The KpiRow's "Total
outstanding" and "Over limit / on hold" tiles are **not buildable** (no total-outstanding or
credit-limit endpoint exists) and are not shown; the four remaining tiles (Customers / Active /
Inactive / Shops) show real counts with no invented trend percentage (C1 has no "vs last month"
endpoint — a KPI tile shows a number or nothing, never a fabricated delta).

**Listing is bounded, not server-paginated.** C1 is cursor-paginated with no total count
(contract §1). Rather than rebuild `PartyList`'s in-memory filter/sort/pager against a paged API —
the screen rewrite the M4-W correction forbids — `useCustomersList`
(`apps/web/src/lib/adapters/use-customers-list.ts`) follows C1's cursor automatically up to 1,000
customers, then stops; the existing client-side filter/sort/pager continues to operate on that
real (never fabricated), bounded array exactly as it did on the mock array. A tenant past that
bound needs this rebuilt server-side — flagged as debt, not silently truncated.

**Actions:** New customer needs `customer.create` (`GET /api/me/permissions`); Edit and
Deactivate/Reactivate (C4, C5, C6) need it too and are hidden — not merely disabled — for a caller
without it. Deactivate confirms and is refused with `409 CUSTOMER_HAS_BALANCE`, quoting the
server's balance verbatim.

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
