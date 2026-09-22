# Master record detail

| | |
|---|---|
| **Route** | `/masters/:code` · account form `/finance/accounts/:code` |
| **Archetype** | F — Master record |
| **Module / permission** | Masters · `Masters` |
| **Prototype source** | `ui-prototype/src/detail-pages.tsx` (`MasterDetail`, `AccountDetail`) |
| **Posts to the ledger** | no |

## 1. Purpose

The record page for any master that does not have a richer page of its own: an account, a bank, a
branch, a route, a doctor, a cost centre. It shows the record, where it is used, and — when it is
account-like — its ledger.

## 2. Anatomy

```
Breadcrumbs  Masters > Accounts > 1110-01 Cash in Hand
RecordHeader icon · name (h1) · code · type chip · [Active] · [Edit] [More v]
KpiRow       (account-like) Current balance · Aggregated debit · Aggregated credit · Transactions
             (other types) Used by · Created · Last modified · Status
Tabs         Overview · Ledger (account-like only) · Linked records · Activity
  Overview   DefinitionGrid of every field on the record, including balance type
  Ledger     LedgerTable: Journal · Date · Description · Debit · Credit · Balance
  Linked     the records that reference this master, grouped by type, each linked
  Activity   audit timeline for the master
```

## 3. Components

`RecordHeader` · `KpiRow` · `Tabs` · `DefinitionGrid` · `LedgerTable` · `DataTable` · `Timeline` ·
`Modal` (edit) · `StatusBadge`.

## 4. Rules

- The Ledger tab appears **only** for records that are postable accounts; for everything else it is
  absent, not empty — an empty ledger tab on a route master is a design defect.
- The Linked records tab is the deletion gate: if it has rows, deletion is impossible and the
  Overview says so.
- Balance type (Debit / Credit) is shown as a chip and is read-only once postings exist.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Edit | secondary | `master:edit` | no | Type-specific form |
| View full ledger | link | `Cash, Bank & GL` | no | `/ledgers?account=<code>` |
| Deactivate | overflow | `master:edit` | **yes, with the reference count** | Hidden from pickers |
| Delete | overflow | `master:delete` | **yes** | Only when unreferenced and unposted; otherwise explained and offered as deactivate |

## 6. Financial rules

- Balances are server figures; the ledger tab follows the [account ledger](../account-ledger/) rules
  (separate Dr/Cr, labelled opening row, running balance in `--money-balance`).
- No hard delete of anything financial.
- Code immutability once posted to.

## 7. States

Not found / other tenant → shared Not found. A master with no linked records shows an `info` chip.
An account-like master with a balance but no transactions in range explains the range.

## 8. Responsive · 9. Accessibility

`md` KPI 2×2, definition grid 4 → 2 · `xs` card lists.
`h1` is the record name with the code in the accessible name; the ledger tab's presence is stable
across renders so focus is not lost.

## 10. Open questions

1. Should `/masters/:code` and `/finance/accounts/:code` be one route? (Recommendation: yes — one
   record page, with the ledger tab shown for account-like types.)
2. Does an account master need a "merge into" operation for migration cleanup?
