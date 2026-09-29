# Audit trail

| | |
|---|---|
| **Route** | `/admin-audit` |
| **Archetype** | D — Ledger (append-only event log) |
| **Module / permission** | Administration · `Admin & Control` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Admin`, Audit log tab) |
| **Posts to the ledger** | no — it **is** the record of everything that did |

## API note — M4-W (2026-09-29)

Wired to the real `GET /api/audit` (`apps/api/src/audit/audit.controller.ts`,
`audit.view` — a privileged permission, `catalog.ts`). The "Audit log" tab of `Admin`
(`apps/web/src/screens/app-screens.tsx`, `AuditLogPanel`) replaced its mock `users[].audit`
table with the real, cursor-paginated feed: Timestamp · User (actor id, truncated — no
user-directory lookup exists yet, see this lane's OBSERVED) · Action (humanized from the real
`UPPER_SNAKE_CASE` code, e.g. `CUSTOMER_CREATED` → "Customer created") · Entity · Detail · Outcome
(`good`/`danger` from the action name containing `DENIED`/`FAIL`). Filters (From/To, Action,
Entity type, Actor id) and a "Load more" cursor pager were **added** — the mock had none. Users,
Roles & permissions, Fiscal periods, Security and Active sessions tabs are untouched, still mock,
out of this lane's scope.

**Denied before it asks.** A caller without `audit.view` never issues the request — the panel
checks `can('audit.view')` (`GET /api/me/permissions`) first and shows the Denied state directly,
rather than calling the API and racing `apiFetch`'s global 403 → `/unauthorized` redirect (the
same reasoning as this lane's `period-close`/`vouchers` fixes).

**Not yet wired:** the KpiRow (Events / Financial mutations / Security events / Failed attempts —
no aggregate endpoint exists), the event-detail Drawer (before/after diff — the real fields exist
on `AuditEvent` but the drawer itself was not built this lane, given time), `Verify integrity`, and
Export. Flagged as OBSERVED, not silently dropped.

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
