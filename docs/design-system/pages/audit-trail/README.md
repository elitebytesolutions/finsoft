# Audit trail

| | |
|---|---|
| **Route** | `/admin-audit` |
| **Archetype** | D — Ledger (append-only event log) |
| **Module / permission** | Administration · `Admin & Control` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Admin`, Audit log tab) |
| **Posts to the ledger** | no — it **is** the record of everything that did |

## 1. Purpose

Every financial mutation and every security-sensitive action, in order, attributable, immutable.
This is the screen that makes the rest of the product defensible.

## 2. Anatomy

```
PageHead    "Audit trail" · [date range v] [Export] [Verify integrity]
KpiRow      Events (period) · Financial mutations · Security events · Failed attempts
FilterBar   search · user · action type · entity type · module · branch · outcome · IP
DataTable   Timestamp · User · Action · Entity · Detail · Before → After · Module · IP · Outcome
Footer      showing · pager (cursor-based)
Drawer      event detail: full before/after payload, request id, session, related documents
```

## 3. Components

`KpiRow` · `FilterBar` · `DataTable` (cursor paginated, virtualised) · `Drawer` · `DiffView`
(page-local, before/after) · `StatusBadge` · `ExportMenu`.

## 4. Columns

| Column | Align | Format |
|---|---|---|
| Timestamp | left | `01 Sep 2026, 10:27:14 AM` with timezone in the header |
| User | left | avatar + name; `System` for jobs, with the job named |
| Action | left | chip: Created · Posted · Reversed · Approved · Cancelled · Signed in · Role changed · Permission changed · Period closed · Export |
| Entity | left | type + identifier, linked to the record |
| Detail | left | one-line human summary ("Posted JV-2026-0419, Rs 3,250") |
| Before → After | left | compact diff for field changes; "View" opens the drawer |
| Module | left | chip |
| IP | left | shown to `Admin & Control` only |
| Outcome | left | Success `good` · Denied `warn` · Failed `danger` |

## 5. Rules

- **Read-only, for every role, forever.** There is no edit, no delete, no bulk action, and no
  retention control in the UI. The absence of those controls is the feature.
- Failed and denied attempts are recorded and shown — a permission denial is a security signal, and
  hiding it makes the trail useless.
- Filtering that hides rows always states the count hidden.
- Export is itself an audited event.
- Every financial mutation has an entry written **in the same transaction** as the mutation
  ([NON_NEGOTIABLES](../../../NON_NEGOTIABLES.md)); a financial document with no audit entry is an
  integrity failure and is surfaced by `Verify integrity`.

## 6. Verify integrity

An explicit action that checks the audit chain for the selected period and reports: entries counted,
gaps detected, documents without audit entries, audit entries without documents. It reports; it
never repairs.

## 7. States

Empty for the range (state the range, not "no data") · large ranges paginate by cursor and say so ·
integrity check running · integrity failure, reported in `danger` with counts and a link to the
affected records.

## 8. Responsive · 9. Accessibility

`xl` hides IP and Module · `md` filter sheet, diff opens in a sheet · `xs` read-only card list.
The table has a caption naming the period and filters; the diff view pairs before and after with
labels, not colour alone; timestamps are machine-readable via `<time datetime>`.

## 10. Open questions

1. Retention: how long is the trail kept online, and what is the archive path?
2. Is the trail exportable in a tamper-evident format for an external auditor?
3. Do we record read access to sensitive data (salary, cost, full account numbers)?
