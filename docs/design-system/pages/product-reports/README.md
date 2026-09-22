# Product reports

| | |
|---|---|
| **Route** | `/product-reports` |
| **Archetype** | H — Report |
| **Module / permission** | Products · `Reports` |
| **Prototype source** | `ui-prototype/src/product-reports.tsx` (`ProductReports`), `src/report-engine.ts` |
| **Reference frame** | `ui-prototype/design/products reports page .png` |
| **Posts to the ledger** | no |

## 1. Purpose

Product-centred analysis: what sells, what does not, what it earns, and what it costs to hold.
Distinct from [inventory reports](../inventory-reports/), which answer *how much do we hold*.

## 2. Anatomy

```
PageHead     "Product reports" · search · [Generate] [Export v] [Templates]
ReportPicker Purchase analysis · Sales analysis · Margin by product · Fast & slow movers ·
             Price list · Product master listing · Company-wise performance
Grid         [ Settings ] date range · company · class · product · group by · top-N · include zero
             [ Output ]  paged table + totals + optional chart
Recent       recent runs with format chips
```

## 3. Components

`ReportPicker` · `FormSection` · `DataTable` · `BarChart` (optional, top-N only) ·
`PrintDocument` · `ExportMenu`.

## 4. Standard column sets

Purchase analysis: `SKU · Product Name · Product Class · Brand / Company · Purchase Qty ·
Unit Cost · Total Value` (as defined in the prototype's report engine).
Sales analysis adds `Sales Qty · Net Sales · Margin · Margin %`.

Rules: quantities and money right-aligned and tabular; margin percentage to one decimal; negative
margin in `--money-negative` with brackets; every report header states company, period and filters.

## 5. Financial rules

- **Margin uses posted documents and weighted-average cost only.** Draft documents are excluded and
  the report says so.
- Sales figures here must equal the sales register totals for the same filters; the report states
  the reconciliation basis (net of returns, excluding tax) explicitly in its header, because "sales"
  means four different numbers to four different readers.
- Cost and margin columns are hidden from roles without `stock:view-cost`, and are excluded from
  their exports rather than blanked.

## 6. Actions

Generate · Export (PDF/XLSX/CSV) · Save as template · Print · Schedule (out of MVP scope, shown as
a disabled control with a reason, or omitted entirely — decide in the open question below).

## 7. States

No data for the filters; async run in progress; permission-limited columns explained inline;
zero-activity products excluded by default with a visible toggle.

## 8. Responsive · 9. Accessibility

`md` settings above output · `xs` settings only, result downloaded.
Charts have table equivalents; the top-N control states what is excluded.

## 10. Open questions

1. Do we ship a "Schedule report" control in MVP, or omit it entirely? (Omit beats disabling.)
2. Is margin calculated before or after discounts and bonus quantities? (Must be stated on the
   report, not only decided in code.)
3. Does "fast/slow mover" use units, value, or days of cover?
