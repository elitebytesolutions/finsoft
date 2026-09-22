# Field sales

| | |
|---|---|
| **Route** | `/field-sales` |
| **Archetype** | A — Register (+ performance panels) |
| **Module / permission** | Sales & POS · `Sales & POS` |
| **Prototype source** | `ui-prototype/src/trade-pages.tsx` (`FieldSales`) |
| **Posts to the ledger** | no — settlement posts from the payments and sales screens |

## 1. Purpose

The distribution side of the business: representatives, routes, load sheets, delivery runs,
recovery in the market and target achievement. One screen for the sales manager's morning review.

## 2. Anatomy

```
PageHead   "Field sales" · "Representative performance, targets, commission and delivery coverage."
           [period v] [Export]
KpiRow     Representatives · Sales target · Achieved · Credit in market
Grid       [ Representative performance ]   Representative · Target · Achieved · % · Commission
           [ Field team roster ]            ID · Name · Designation · Branch
           [ Booker & delivery coverage ]   Route / area · Booker · Deliveryman · Stops
           [ Credit in market ]             Rep · Outstanding · Over terms · Oldest
```

## 3. Components

`KpiRow` · `Panel` + `DataTable` (four) · `ProgressBar` (target achievement) · `PartyLink` ·
`ExportMenu`.

## 4. Formatting

| Figure | Rule |
|---|---|
| Target / Achieved | money, right-aligned, same period stated on the card |
| Achievement % | percentage + bar; `danger` below 70, `warn` 70–99, `good` ≥ 100 |
| Commission | money; **computed by the server**, never in the browser |
| Credit in market | outstanding attributable to that rep's customers, as at the period end |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Open representative | link | `HR & Payroll` | no | `/hr/employees/:id` |
| Open route | link | `Sales & POS` | no | Route detail (future) |
| Export | secondary | `Reports` | no | Period snapshot |

Nothing posts here. Commission becomes a payable through payroll, not through this screen.

## 6. States

Empty (no targets set): "No targets for this period — set targets to track achievement."
Missing commission configuration shows "Not configured" rather than `Rs 0.00`.

## 7. Responsive · 8. Accessibility

`md` panels stack into one column · `xs` each panel becomes a card list.
Progress bars carry their percentage as text.

## 9. Deviations from the prototype

The prototype's sidebar routes Load sheets, Delivery runs, Run settlement, Routes, Targets and
Performance **all** to this page. Those are six different jobs. Before build, either build the
separate screens or remove the nav entries — shipping six links to one page is a navigation defect.

## 10. Open questions

1. Which of the six distribution sub-screens are in MVP?
2. Is commission a percentage of net sales, of collection, or of margin — and who owns that rule?
3. Does "credit in market" include cheques in hand held by the rep?
