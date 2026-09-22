# Inventory reports

| | |
|---|---|
| **Route** | `/inventory-reports` |
| **Archetype** | H — Report |
| **Module / permission** | Inventory · `Reports` |
| **Prototype source** | `ui-prototype/src/inventory-reports.tsx` (`InventoryReports`), `src/report-engine.ts` |
| **Reference frame** | `ui-prototype/design/inventory reports page.png` |
| **Posts to the ledger** | no |

## 1. Purpose

Run the standard stock reports: valuation, ageing, expiry, movement summary, reorder, dead stock,
and stock by warehouse or class.

## 2. Anatomy

```
PageHead    "Inventory reports" · search · [Generate] [Export v] [Templates]
ReportPicker cards: Stock valuation · Batch & expiry · Movement summary · Reorder ·
             Dead stock · Stock by warehouse · Gift & breakage summary
Grid        [ Report settings ]        [ Output ]
              as-at date / date range    paged table with totals
              warehouse · class ·        zoom · download · print · export as
              company · include zero ·
              group by · [Generate]
Recent      Recently generated, with format chips
```

## 3. Components

`ReportPicker` cards · `FormSection` (settings) · `DataTable` (output) · `PrintDocument` ·
`ExportMenu` · `Panel` (recent runs).

## 4. Standard columns

Valuation: `SKU · Product Name · Class · Company · Qty · Unit Cost · Total Value`

**No `Warehouse` column on the valuation report.** Inventory value exists only at the tenant/product costing scope (ADR-0015, ADR-0018 §8), so a per-warehouse value cannot be produced without multiplying a warehouse quantity by an average cost — the recomputation ADR-0015 §7 forbids, and one that does not sum back to the tenant value. Warehouse **quantities** are available on the stock-overview and stock-as-of pages; warehouse **valuations** are not invented here.
(the column set the prototype's report engine already defines).
Every report adds, in its header: company, as-at date or range, warehouse and class filters,
accounting method for valuation, and generated-at.

## 5. Formatting rules

- Quantities and values right-aligned, tabular, full precision — **never abbreviated**.
- Group subtotals and a grand total on every report; the grand total is emphasised.
- Zero-quantity rows are excluded by default with an explicit "Include zero-stock items" toggle, and
  the toggle's state is printed on the output.
- Valuation uses weighted-average cost and the report states so.
- **The valuation figure is the carried value reconstructed to the report's as-at date** —
  `Σ inventory_value_delta` over movements dated on or before it. It is never `Qty × Unit Cost`
  (ADR-0015 §7), and never today's `value_on_hand` when the report is dated earlier. `Unit Cost` is
  a rate shown for information; the `Total Value` column is not derived from it.

## 6. Actions

| Action | Kind | Permission | Result |
|---|---|---|---|
| Generate | primary | `Reports` | Runs server-side; long runs go async with a notification |
| Export | secondary split | `Reports` | PDF / XLSX / CSV with identical figures |
| Save as template | ghost | `Reports` | Stores the settings in `/reports/templates` |
| Print | secondary | `Reports` | `PrintDocument` |

## 7. Financial rules

- Inventory valuation is a **financial statement input**. The figure here must equal the inventory
  balance in the trial balance at the same date; the report shows both and flags a difference rather
  than presenting only one.
- That equality only holds because both sides are reconstructed over the **same cutoff** from the
  same stored amounts (ADR-0015). A report that sums movements to a past date on one side and reads
  a current balance on the other will show a difference that is a date error, not a control
  failure — and someone will then widen a tolerance to silence it.
- Cost columns are hidden from roles without `stock:view-cost`, and the report refuses to export
  them for those roles rather than exporting a blank column.

## 8. States

No data for the filters; report still running (async, with a place to collect it); export failed;
permission-limited columns explained inline.

## 9. Responsive · 10. Accessibility

`md` settings above output · `xs` settings only, with an emailed/downloaded result.
Output tables are real tables with captions naming every filter applied.

## 11. Open questions

1. Which reports must tie exactly to the trial balance, and at what tolerance? (Answer must be
   **zero tolerance** — confirm with accounting-guardian.)
2. Is dead-stock defined by days without movement, or days of cover?
3. Scheduled delivery of reports — in MVP?
