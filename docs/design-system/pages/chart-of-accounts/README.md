# Chart of Accounts

| | |
|---|---|
| **Route** | `/accounts` |
| **Archetype** | E — Tree / Hierarchy |
| **Module / permission** | Accounting · `Cash, Bank & GL` · create/edit needs `master:create` |
| **Prototype source** | `ui-prototype/src/chart-of-accounts.tsx` (`ChartOfAccounts`) |
| **Reference frames** | `design/chart of accounts improved.png`, `design/chart of accounts page .png` |
| **Posts to the ledger** | no — but it defines what everything else may post to |

## 1. Purpose

The accountant maintains the account structure here and reads aggregated balances by branch of the
tree. Every posting surface in the product picks accounts from this structure, so its shape is a
constraint on the whole ledger.

## 2. Anatomy

```
PageHead     icon · "Chart of Accounts" · description · [search ⌘K] [Table view | Hierarchy map]
                                                        [All accounts v] [Import] [Export] [+ Add Account]
KpiRow (6)   Total assets · liabilities · equity · income · expenses · total accounts
BulkBar      (when rows selected) n selected · Edit · Move · Activate · Deactivate · Delete · More · Reset
FilterBar    All types v · All statuses v · All levels v · Reset · [view density] [columns]
TreeTable    Account name · Code · Type · Parent account · Sub-accounts · Balance (PKR) ·
             Change · Last modified · Status · Actions
Footer       Showing 1-12 of 42 accounts · rows per page · pager · Go to page
```

## 3. Components

`TreeTable` (D3) · `KpiRow` · `SegmentedControl` (Table view / Hierarchy map) · `BulkActionBar` ·
`Badge` · `Sparkline` · `ConfirmDialog` · `Modal` (add / edit account) · `TreeMap` view
(page-local: the hierarchy canvas with root, branch and leaf nodes).

## 4. The hierarchy — four levels, fixed

| Level | Name | Example | Postable |
|---|---|---|---|
| 1 | Primary | Assets (1000) | no |
| 2 | Subtype | Current Assets (1100) | no |
| 3 | Group | Cash Accounts (1110), Bank Accounts (1120) | no |
| 4 | Transaction account | Cash in Hand (1110-01), Meezan Bank 8721 (1120-01) | **yes** |

Level chips: `Header` (neutral), `Group` (info), `Postable` (good). Only `Postable` accounts appear
in `AccountPicker`, ledgers and voucher entry.

## 5. Columns

| Column | Align | Format | Priority |
|---|---|---|---|
| ☐ | — | selection, disabled on rows the role cannot act on | 1 |
| Account name | left | icon well + name (700) + 9.5px description; indent rails per level | 1 |
| Code | left | tabular, sortable | 1 |
| Type | left | level chip | 2 |
| Parent account | left | `Name (code)` or em dash at root | 4 |
| Sub-accounts | right | count; link scrolls to children | 4 |
| Balance (PKR) | right | money; **aggregated** on header rows; `--money-negative` when adverse | 2 |
| Change | right | signed percentage with arrow + 60px sparkline | 4 |
| Last modified | left | `Aug 28, 2024` + 9.5px `by S. Ali` | 5 |
| Status | left | Active `good` / Inactive `neutral` | 3 |
| Actions | right | overflow: Add sub-account, Edit, View ledger, Deactivate, Delete | 1 |

A header row's balance is the sum of its descendants and is rendered in the same column, in 700
weight, with the row tinted one step toward `--surface-sunken`.

## 6. Actions

| Action | Kind | Permission | Confirm | Notes |
|---|---|---|---|---|
| Add account | primary | `master:create` | no | Single button — opens the add-account modal. Sub-accounts are added from the row overflow. |
| Add sub-account (row) | overflow | `master:create` | no | Creates the **next** level down; level 4 cannot have children |
| Edit | overflow / bulk | `master:edit` | no | Name, description, status. **Code and parent of an account with postings are read-only** |
| Move | bulk | `master:edit` | **yes** | Re-parenting changes aggregation; blocked for accounts with postings |
| Activate / Deactivate | bulk | `master:edit` | yes for deactivate | Deactivation hides the account from pickers; existing postings are untouched |
| Delete | bulk / overflow | `master:delete` | **yes, typed** | See below |
| View ledger | overflow | `Cash, Bank & GL` | no | `/ledgers?account=<code>` |
| Import / Export | secondary | `master:create` / `Reports` | import: yes | CSV with the same columns |

### Delete is usually refused

Deletion is blocked when the account has sub-accounts, or any posting exists on it **or any
descendant**. The dialog states the reason and the count, and offers **Deactivate** instead. There
is no force-delete for any role — financial records are never hard-deleted
([NON_NEGOTIABLES](../../../NON_NEGOTIABLES.md)).

## 7. States

- Empty (new tenant): offers **Import a standard chart** and **Build from scratch**.
- Filtered empty: "No accounts match these filters."
- A node that fails to expand shows an inline retry on that row only, not a page error.
- Locked period does not affect this page — masters are not period-scoped — but deleting or moving
  an account that has postings in a closed period is refused with that reason.

## 8. Financial rules on this page

- Four-level structure is fixed; only level 4 is postable.
- Account **codes are immutable once posted to**.
- Deletion of a posted-to account is impossible; deactivation is the only exit.
- Balances shown are server-computed from the ledger; the client never sums journal lines.
- Normal balance side (Debit / Credit) is shown on every account and cannot be changed after the
  first posting.

## 9. Responsive

`xl` hides Change and Last modified · `lg` hides Parent account and Sub-accounts · `md` the tree
collapses to name + code + balance + status with horizontal scroll · `xs` card list, hierarchy
navigated one level at a time.

## 10. Accessibility

`TreeTable` uses `role="treegrid"` with `aria-level`, `aria-expanded` and `aria-posinset`;
left/right arrows collapse and expand; the indent rails are decorative and `aria-hidden`; the
selection checkbox label names the account and code.

## 11. Deviations from the prototype

- The prototype's `coa2-*` local CSS is replaced by `TreeTable`.
- The prototype's resizable name column and icon-density segmented control are kept as
  `TreeTable` features rather than page-local behaviour.
- Balances in the prototype are computed in the browser from seed journals; production reads them
  from the server.

## 12. Open questions

1. Is the code format fixed (`1110-01`) or tenant-configurable, and is it auto-suggested on create?
2. Do we support account merging for the Bhatti migration, and if so what does the UI look like?
3. Are branch/cost-centre balances a column, a filter, or a separate view?
