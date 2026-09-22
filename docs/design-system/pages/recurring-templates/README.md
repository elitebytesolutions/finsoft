# Voucher templates (recurring)

| | |
|---|---|
| **Route** | `/recurring` |
| **Archetype** | A — Register |
| **Module / permission** | Accounting · `Cash, Bank & GL` · run needs `voucher:create` |
| **Prototype source** | `ui-prototype/src/control-pages.tsx` (`RecurringTemplates`) |
| **Posts to the ledger** | **yes** — running a template creates a voucher |

## 1. Purpose

Standing entries — rent, salaries, utilities, depreciation, bank charges — kept as templates so
each cycle is one reviewed click instead of a retyped journal.

## 2. Anatomy

```
PageHead   "Voucher templates" · "Standing vouchers — rent, salaries, utilities and charges posted
            automatically each cycle." · [Export] [+ New template]
KpiRow     Active templates · Due this cycle · Posted this month · Failed runs
DataTable  Template · Type · Frequency · Next run · Lines · Amount · Last run · Status · Actions
Drawer     Template detail: header fields + Dr/Cr lines (read-only preview) + run history
```

## 3. Components

`DataTable` · `KpiRow` · `Drawer` · `DrCrGrid` (read-only preview) · `StatusBadge` ·
`ConfirmDialog` · `Timeline` (run history).

## 4. Columns

| Column | Align | Format |
|---|---|---|
| Template | left | name (700) + 9.5px narration |
| Type | left | voucher type chip |
| Frequency | left | Monthly · Quarterly · Annually · On demand |
| Next run | left | date; `Overdue` in `danger` when past |
| Lines | right | count |
| Amount | right | money; `Variable` in `--muted` when the amount is entered at run time |
| Last run | left | date + resulting voucher link |
| Status | left | Active `good` · Paused `neutral` · Failed `danger` |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Run now | primary (row) | `voucher:create` | **yes — shows the full Dr/Cr preview and the period** | Creates a voucher; by policy it is created as a **draft**, not posted |
| New / Edit template | primary / overflow | `voucher:create` | no | Template editor (same grid as `/vouchers/new`, no post action) |
| Pause / Resume | overflow | `voucher:create` | pause: no, resume: yes | Stops scheduled runs |
| Delete template | danger | `master:delete` | **yes** | Templates have no postings of their own, so they may be deleted; produced vouchers are untouched |

## 6. Financial rules on this page

- **Automatic posting is not automatic approval.** A scheduled run produces a draft that a human
  posts, unless the tenant has explicitly enabled auto-post for that template — and even then, a
  run into a **closed period is refused**, with no system bypass.
- A failed run is recorded and surfaced as a KPI and a `danger` status; it is never retried silently.
- A template stores accounts and a formula, never a posted amount.

## 7. States

Empty: "No templates yet — turn a repeating voucher into a template from any posted voucher."
Failed run: row banner naming the failure (closed period, missing account, unbalanced formula) with
a **Fix template** action.

## 8. Responsive · 9. Accessibility

`md` drawer becomes a full-screen sheet · `xs` card list. The run confirmation restates the entry in
text so it can be read aloud before posting.

## 10. Open questions

1. Is auto-post ever permitted, and if so, who authorises it per template?
2. How are variable amounts supplied — prompt at run, or a formula over a source figure?
3. Do templates belong to a user or the tenant?
