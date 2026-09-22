# Report studio

| | |
|---|---|
| **Route** | `/reports/studio` |
| **Archetype** | B — Document entry (a template is the document) |
| **Module / permission** | Reports · `Reports` |
| **Prototype source** | `ui-prototype/src/reports-pages.tsx` (`ReportStudio`), `src/report-studio.tsx`, `src/report-engine.ts` |
| **Posts to the ledger** | no |

## 1. Purpose

Build a report without a developer: pick a data source, choose columns, filter, group, total,
preview, and save it to the library.

## 2. Anatomy

```
PageHead   "Report studio" · "Design a report template — pick a data source, choose columns and
            save it to the library." · [Reset] [Save template]
Steps      [ 1 · Data source ] [ 2 · Columns ] [ 3 · Filters & grouping ] [ 4 · Save template ]
Grid       [ Builder panel ]                    [ Live preview ]
             1 source: Sales · Purchases ·        the report as it will run, with
               Stock · Movements · Ledger ·       real data and real totals
               Payments · POs · Employees ·
               Parties · Products
             2 columns: available | selected
               (drag to order, toggle numeric,
                toggle total)
             3 filters: field · operator · value
               group by · sort · top-N
             4 name · description · category ·
               shared with · [Save]
```

## 3. Components

`Stepper` · `DualListSelector` (available/selected columns, page-local) · `FilterBuilder`
(page-local) · `DataTable` (preview) · `FormSection` · `ConfirmDialog` · `Badge`.

## 4. Rules

- The preview runs on **real data, scoped to the tenant and the user's permissions** — a user cannot
  build a report that shows them figures they could not otherwise see. Column availability is
  permission-filtered at the source, not hidden at render.
- Numeric columns default to right-aligned, tabular, with a total; the builder shows and lets the
  user change that, but the defaults follow the formatting rules.
- Money columns inherit currency formatting automatically; the builder does not offer a "plain
  number" rendering for a money field.
- A template stores a query definition, never a snapshot of data.
- Saving requires a name unique within the tenant.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Preview | automatic | `Reports` | — | Debounced, limited to 100 rows, labelled "Preview — first 100 rows" |
| Save template | primary | `Reports` | no | Stored in `/reports/templates` |
| Save as copy | secondary | `Reports` | no | Clones an existing template |
| Share with | control | `Reports` | no | Private, team, or everyone in the tenant |

## 6. Financial rules

- A studio report is **not** a financial statement and is labelled as such on its output:
  "Operational report — not a statutory statement." Statutory statements come only from
  [reports centre](../reports-centre/), where the accounting treatment is fixed.
- Reports may not create computed columns that re-derive accounting figures (no user-defined
  "profit" formula) — aggregations are limited to sum, count, average, min, max over existing
  fields. This keeps a hand-built column from being mistaken for an accounting figure.

## 7. States

No source chosen (steps 2–4 disabled with the reason); no columns selected; preview empty for the
filters; preview error naming the failing filter; duplicate template name.

## 8. Responsive · 9. Accessibility

`lg` preview moves below the builder · `sm` and below: read-only browse of existing templates.
The dual list is keyboard operable (arrow to move, space to select); column order is changeable via
keyboard as well as drag; the preview announces its row count.

## 10. Open questions

1. Are user-defined calculated columns ever allowed, and with what guard rails?
2. Can a studio report be scheduled or emailed?
3. Who may share a template with everyone — any user, or an admin?
