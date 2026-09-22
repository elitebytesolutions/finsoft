# Financial statements / reports centre

| | |
|---|---|
| **Route** | `/reports` |
| **Archetype** | H — Report |
| **Module / permission** | Reports · `Reports` |
| **Prototype source** | `ui-prototype/src/reports-pages.tsx` (`ReportsCentre`) |
| **Reference frame** | `ui-prototype/design/improved financial statements page .png` |
| **Posts to the ledger** | no |

## 1. Purpose

Generate the statements the business is judged on: income statement, balance sheet, trial balance,
cash flow, account ledger and ratio analysis. These figures are filed with the FBR, so the screen's
job is accuracy and provenance, not visual interest.

## 2. Anatomy

```
PageHead      eyebrow "REPORTS / REPORTS CENTRE" · "Financial Statements" · description
              [search reports ⌘K] [+ Generate Report] [Export v] [Template Library]
KpiRow (5)    Revenue · Assets · Liabilities · Net profit · Status ("All systems balanced", last updated)
ReportPicker  Income Statement · Balance Sheet · Trial Balance · Cash Flow · Account Ledger ·
              Ratio Analysis   (cards with a one-line description and an arrow)
Grid          [ Report settings ]                [ Output viewer ]
                Report type                        file name · page n of m · zoom
                Date range                         [Download] [Print] [Export as v]
                Comparison (previous period)       page thumbnails | rendered statement
                Accounting method (Accrual)
                Format (PDF recommended)
                Advanced options
                [ Generate Report ]
Recent        "Recent generated reports" — name · timestamp · format chip · overflow
```

## 3. Components

`KpiRow` · `ReportPicker` cards · `FormSection` (settings) · `DocumentViewer` (page-local: paged
preview, thumbnails, zoom) · `ExportMenu` · `Panel` (recent runs) · `PrintDocument`.

## 4. Statement rendering rules

- Statement tables use the `stmt` preset: section headings in 700, indented line items, subtotal
  rows with a top border, total rows with a tinted background, comparative period in the adjacent
  column.
- Column headers name the period exactly: `Aug 2026 (Rs)` and `Jul 2026 (Rs)`.
- Figures are **never abbreviated** and always carry two decimals.
- Negative figures in brackets.
- Every statement header carries: company name and registration, statement title, period, accounting
  method, generated-at timestamp and the user who generated it.

## 5. The "Status" KPI

`All systems balanced` (`good`) means the trial balance nets to zero and the control accounts
reconcile to their sub-ledgers. When it does not, the KPI turns `danger`, names the discrepancy and
the figure, and links to the trial balance. It is never hidden and never shows a stale green.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Generate report | primary | `Reports` | no | Runs server-side; long runs go async with a collection point |
| Download / Print / Export as | secondary | `Reports` | no | PDF / XLSX / CSV, identical figures |
| Template library | secondary | `Reports` | no | `/reports/templates` |
| Save as template | ghost | `Reports` | no | Stores the settings |

## 7. Financial rules

- Statements are generated **server-side from posted entries only**; drafts are excluded and the
  header says so.
- A statement for a period that is still open is watermarked `Provisional — period not closed`.
- Comparative figures come from the same source, never from a cached previous export.
- The trial balance must net to zero; if it does not, the report renders **with** the imbalance
  shown as a line, rather than being suppressed. Hiding an imbalance is worse than showing one.

## 8. States

Generating (async with a place to collect) · no data for the period · imbalance detected ·
permission-limited (a role without `Reports` never reaches here) · export failed.

## 9. Responsive · 10. Accessibility

`lg` the viewer drops the thumbnail rail · `md` settings above the viewer · `xs` settings only,
with a download. Statements have a reachable HTML table version, not only a rendered page; zoom
controls are buttons; the status KPI is `role="status"`.

## 11. Open questions

1. Which statement formats must match an FBR or SECP template exactly?
2. Does "Cash flow" use the direct or indirect method?
3. Are consolidated (multi-company) statements in scope?
