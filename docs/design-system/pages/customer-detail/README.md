# Customer detail

| | |
|---|---|
| **Route** | `/customers/:code` |
| **Archetype** | F — Master record |
| **Module / permission** | Parties · `Masters` |
| **Prototype source** | `ui-prototype/src/parties.tsx` (`CustomerDetail`) |
| **Reference frame** | `ui-prototype/design/customers detail page .png` |
| **Posts to the ledger** | no — actions route to screens that post |

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
