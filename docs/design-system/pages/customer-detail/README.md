# Customer detail

| | |
|---|---|
| **Route** | `/customers/:code` |
| **Archetype** | F — Master record |
| **Module / permission** | Parties · `Masters` |
| **Prototype source** | `ui-prototype/src/parties.tsx` (`CustomerDetail`) |
| **Reference frame** | `ui-prototype/design/customers detail page .png` |
| **Posts to the ledger** | no — actions route to screens that post |

## API note — M4-W (2026-09-29)

**Route is `/customers/:id`, not `/customers/:code`** — there is no lookup-by-code endpoint
(`docs/design/M3/api-contract.md` §4.1: C3–C7 all take the id), and codes are otherwise immutable
display text. `CustomerDetail` (`apps/web/src/screens/parties.tsx`) is self-contained — it fetches
C3 (`GET /api/customers/:id`), C7 (the ledger) and `GET /api/audit?entityType=customer&entityId=:id`
itself from the route id, the same pattern `AccountLedger`/`PeriodClose` (M2-S) already use — rather
than receiving mock `data`/`onPatch` props.

Per the M4-W course correction, the ported panels (Customer Snapshot, Financial Health, Quick Edit,
Report Center, Recent Interactions, Account Ledger) **stay**; only their data and, where a figure
was computed in the browser from mock arrays, their computation changed:

- **Ledger tab is the real C7 response.** The running balance is the server's `runningBalance`
  field, never `Σ(debit − credit)` computed here (CLAUDE.md: money is never arithmetic in the
  browser) — replacing the mock's own `run += l.debit - l.credit`. An opening "Balance brought
  forward" row was added (was missing from the ported table), per
  [account-ledger](../account-ledger/)'s convention.
- **Outstanding balance** (Financial Health) is the real, signed `balance`/`balanceAsOf` from C3.
  Total Sales / Total Payments / Credit Limit have no backing endpoint yet (I1/R1 are M3-P, not
  merged on this branch) and show "Coming with receivables" / "Not tracked in this release" rather
  than a fabricated figure or a removed tile.
- **Recent Interactions is the real audit trail** for this record (`GET /api/audit`) — the mock's
  three hardcoded rows ("Rs 200,000 via Bank Transfer", a fixed quote, fabricated trend
  percentages) are gone; per the correction's own "never invent data" clause, invented content is
  replaced with the real thing where a real thing exists, not kept as a static placeholder.
- **Quick Edit** saves via C4 (`PATCH`) with the `version` this page read (optimistic concurrency).
  City and NTN fields were **added** (the mock's form lacked them; both are real, editable fields).
  Credit Limit has no real field and is shown disabled, not removed.
- **NTN/CNIC, Sales Tax No and Customer Group** defaults (fabricated placeholders like
  `35202-1234567-1`) are gone — `—` when the real field is empty, and Customer Group/Sales Tax No
  (no such fields exist) are dropped from the Snapshot card rather than shown with an invented
  value.

**Actions:** Edit and the overflow "More" (Deactivate/Reactivate) need `customer.create` and are
hidden for a caller without it — the module-level `Guard` alone does not gate them.

## 1. Purpose

One customer, everything: contact, commercial terms, current balance, their ledger, their invoices,
their receipts, their returns and their credit behaviour.

## 2. Anatomy

```
Breadcrumbs  Parties > Customers > Adeel Pharmacy
RecordHeader avatar · name (h1) · code · type chip · [Active] · [New sale] [Record receipt] [Edit] [More v]
KpiRow       Outstanding · Credit limit · Available credit · Last payment
Tabs         Overview · Ledger · Invoices · Receipts · Returns · Credit · Activity
  Overview   DefinitionGrid: dealing person, phone, email, address, city, area, route, salesman,
             NTN/STRN, filer status, price list, terms, opening balance and its date
  Ledger     LedgerTable scoped to this customer: Date · Voucher No · Narration · Debit (Rs) ·
             Credit (Rs) · Balance (Rs) · Status
  Invoices   Invoice · Date · Amount · Paid · Outstanding · Days · Status
  Receipts   Voucher · Date · Mode · Amount · Allocated · Unallocated
  Returns    Return · Date · Invoice · Items · Amount · Reason
  Credit     limit, terms, hold status, utilisation, change history, dishonoured cheques
  Activity   audit timeline for the master record
```

## 3. Components

`RecordHeader` · `KpiRow` · `Tabs` · `DefinitionGrid` · `LedgerTable` · `DataTable` ·
`UtilizationBar` · `Timeline` · `Modal` (edit) · `StatusBadge`.

## 4. Formatting

Ledger tab follows [account ledger](../account-ledger/) rules exactly: separate Debit and Credit
columns, running balance in `--money-balance`, opening row labelled. Outstanding in the KPI row must
equal the ledger's closing balance; the page states the as-at moment.

Ageing is shown in the Invoices tab as a `Days` column measured from the due date, with the same
0–30/31–60/61–90/90+ buckets used in [receivables](../receivables/).

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New sale | primary | `sale:create` | — | `/sales/voucher` pre-filled; **blocked with a reason if on hold or over limit** |
| Record receipt | primary | `payment:create` | — | `/payments` pre-filled |
| Edit | secondary | `master:edit` | credit change: yes | Party form |
| Statement | overflow | `Reports` | no | Customer statement PDF for a chosen period |
| Deactivate | overflow | `master:edit` | **yes; refused with an outstanding balance** | Hidden from pickers |

## 6. Financial rules

- Every figure is server-computed; nothing on this page is derived in the browser.
- The customer is never deleted, in any role.
- Credit limit changes are audited and shown in the Credit tab with who, when, from and to.
- Dishonoured cheques appear in the Credit tab because they are a credit signal, not just an
  accounting event.

## 7. States

Not found / other tenant → shared Not found. New customer with no activity → each tab shows its own
empty state. On hold → a persistent `danger` banner naming who placed the hold and when.

## 8. Responsive · 9. Accessibility

`md` KPI 2×2, definition grid 4 → 2 · `sm` tabs become a select · `xs` card lists.
`h1` is the customer name; the hold banner is `role="status"`; ledger cells carry side labels.

## 10. Open questions

1. Does the statement include unallocated receipts, and in which order?
2. Should the Credit tab show a computed risk score, and would that be an AI suggestion?
3. Are contacts a list (multiple people) rather than a single dealing person?
