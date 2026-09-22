# Business masters

| | |
|---|---|
| **Route** | `/masters` |
| **Archetype** | A — Register (tabbed by master type) |
| **Module / permission** | Masters · `Masters` · create needs `master:create` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Masters`), `src/master-form.tsx` |
| **Posts to the ledger** | no — except opening balances, which post |

## 1. Purpose

One directory for the smaller masters that do not deserve their own screen: accounts used as
parties, banks, branches, locations, cities, areas, routes, departments, designations, doctors,
cost centres and reason codes.

Customers, vendors, products and employees have their own screens; everything else lives here.

## 2. Anatomy

```
PageHead   "Business masters" · "One reliable directory for accounts, parties, locations and
            classifications." · [Import] [Export] [+ New record]
Tabs       Accounts · Banks · Branches · Locations · Cities & areas · Routes · Departments ·
           Designations · Doctors · Cost centres · Reason codes
FilterBar  search · status
DataTable  Code · Name · Record type · Balance type · Parent · Used by · Status · Actions
Modal      Create / edit — fields vary by tab
```

## 3. Components

`Tabs` · `FilterBar` · `DataTable` · `Modal` (`MasterModal` with a per-type field schema) ·
`StatusBadge` · `ConfirmDialog` · `ImportDialog` · `ExportMenu`.

## 4. Shared columns

| Column | Align | Format |
|---|---|---|
| Code | left | tabular, unique within its type |
| Name | left | 700 + 9.5px description |
| Record type | left | which master this row is |
| Balance type | left | Debit / Credit chip — only for account-like records, em dash otherwise |
| Parent | left | for hierarchical types (area → city, route → branch) |
| Used by | right | reference count; links to the records using it |
| Status | left | Active `good` · Inactive `neutral` |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New record | primary | `master:create` | opening balance: **yes** | Creates in the active tab's type |
| Edit | row | `master:edit` | no | Code read-only once referenced |
| Deactivate | row | `master:edit` | **yes, with the reference count** | Hidden from pickers |
| Delete | row | `master:delete` | **yes** | **Only when `Used by` is zero and no postings exist** |
| Import / Export | secondary | `master:create` / `Reports` | import: yes, with preview | CSV per type |

## 6. Financial rules

- A master with any posting or reference is **deactivated, never deleted**.
- Opening balances entered here post like any other opening balance: dated, audited, refused in a
  closed period.
- Reason codes map to expense accounts; changing a mapping is effective-dated and does not restate
  past postings.

## 7. States

Empty per tab with a type-specific sentence; filtered empty; a record with zero references carries
an `info` chip so unused clutter is visible.

## 8. Responsive · 9. Accessibility

`md` tabs become a select · `xs` card list. The modal's field set changes with the type and the
change is announced; each tab panel is labelled.

## 10. Deviations from the prototype

The prototype mixes these types in one flat list with a `Record type` column. Production keeps the
column but adds the tabs, because a user maintaining routes should not scroll past doctors.

## 11. Open questions

1. Which of these types are actually needed for MVP, and which come from the Bhatti migration?
2. Are cities/areas/routes a three-level hierarchy, and does distribution depend on it?
3. Do cost centres affect posting (a dimension on every line) or only reporting?
