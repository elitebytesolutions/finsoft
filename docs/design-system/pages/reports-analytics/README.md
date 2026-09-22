# Reports & analytics

| | |
|---|---|
| **Route** | `/reports/analytics` |
| **Archetype** | I — Dashboard |
| **Module / permission** | Reports · `Reports` |
| **Prototype source** | `ui-prototype/src/reports-analytics.tsx` (`ReportsAnalytics`) |
| **Reference frame** | `ui-prototype/design/reports and analytics page .png` |
| **Posts to the ledger** | no |

## 1. Purpose

The reporting front door: featured analyses, the full catalogue by category, and a route into the
studio. It orients; it does not compute.

## 2. Anatomy

```
Hero          headline · sub-line · [Explore reports] [Open studio]
KpiRow        Reports available · Saved templates · Run this month · Scheduled (if enabled)
Featured      3–4 large cards: chart preview · title · description · [Open]
CategoryPills All · Financial · Sales · Purchasing · Inventory · Parties · HR · Tax · Custom
CatalogueGrid report cards: icon · name · description · category chip · last run · [Run]
```

## 3. Components

`HeroBand` (light variant) · `KpiRow` · `ReportCard` · `CategoryPills` (`Chip` group) ·
`Sparkline` / mini charts · `SearchField`.

## 4. Rules

- Cards show a **real preview** where cheap (a sparkline of the last run), and nothing where not —
  never a decorative fake chart. A fake chart on a financial product is a credibility cost.
- Category pills filter in place; the selection is URL state.
- Every card states when the report was last run and by whom, so users know whether a figure they
  remember is current.
- Cards the role cannot run are not shown.

## 5. Actions

| Action | Kind | Permission | Result |
|---|---|---|---|
| Run / Open | card | per report | Routes to `/reports/:id` with defaults |
| Open studio | secondary | `Reports` | `/reports/studio` |
| Template library | secondary | `Reports` | `/reports/templates` |

Nothing computes or posts here.

## 6. States

Empty custom category ("No saved templates yet — build one in the studio").
A report that failed its last run carries a `danger` chip with the reason on the card.

## 7. Responsive · 8. Accessibility

`xl` 4 cards per row · `lg` 3 · `md` 2 · `xs` 1. Category pills scroll horizontally at `xs`.
Cards are links with the report name as the accessible name; preview charts are `aria-hidden` with
the figure stated in text.

## 9. Deviations from the prototype

The prototype's hero is marketing copy ("Turn Your Inventory Data…"). Production keeps a hero but
makes it functional: the period selector and the two primary routes.

## 10. Open questions

1. Which reports are "featured", and is that per role?
2. Do we surface scheduled reports here if scheduling ships later?
3. Should recently-run reports appear ahead of the catalogue for returning users?
