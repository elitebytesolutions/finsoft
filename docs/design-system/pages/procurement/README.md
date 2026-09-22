# Demand & procurement

| | |
|---|---|
| **Route** | `/procurement` |
| **Archetype** | G — Workbench |
| **Module / permission** | Purchasing · `Demand & PO` · `po:create` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Procurement`) |
| **Reference frame** | `ui-prototype/design/manual demand of goods .png` |
| **Posts to the ledger** | no — it produces purchase orders |

## 1. Purpose

Turn reorder signals into supplier-ready orders. The buyer reviews what the system suggests, adjusts
quantities, and raises POs by supplier in one pass.

## 2. Anatomy

```
PageHead    "Smart procurement" · "Turn reorder signals into supplier-ready purchase orders."
            [Refresh suggestions] [Manual demand] [Create POs]
KpiRow      Items below reorder · Suggested value · Suppliers involved · Days of cover (avg)
FilterBar   supplier · class · company · branch · urgency
SuggestTable ☐ · Product · Current · Reorder at · Days cover · Suggested qty (editable) ·
            Preferred supplier · Last cost · Value · Priority
GroupBar    Group by supplier (default) | by product class
Pipeline    Draft POs created in this session, with [Open] links
```

## 3. Components

`KpiRow` · `DataTable` with selection and one editable column · `GroupedTable` ·
`SupplierPicker` (per row override) · `ConfirmDialog` · `Panel` (pipeline) · `Badge`.

## 4. Suggestion columns

| Column | Align | Format |
|---|---|---|
| Product | left | name + 9.5px pack and class |
| Current | right | on-hand quantity; `danger` when zero |
| Reorder at | right | the product's reorder level |
| Days cover | right | current ÷ average daily sale; `danger` below 7 |
| Suggested qty | right | **editable**; defaults to the reorder formula, rounded to pack size |
| Preferred supplier | left | from the product master; overridable per row |
| Last cost | right | money, read-only |
| Value | right | suggested qty × last cost |
| Priority | left | High `danger` · Medium `warn` · Low `neutral`, derived from days cover |

The suggestion formula is stated in a disclosure on the panel header — a buyer must be able to see
why a number was suggested. Suggestions are marked as system-generated; editing one marks the row as
adjusted.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Create POs | primary | `po:create` | **yes — lists the POs that will be created, by supplier, with values** | Creates **draft** POs, one per supplier; routes to `/po` |
| Manual demand | secondary | `po:create` | no | Adds a product row that the suggestion engine did not propose |
| Refresh suggestions | secondary | — | no | Recomputes; edited rows are preserved and marked |

## 6. Financial rules

Nothing posts. The output is draft purchase orders, which themselves post nothing. Every downstream
financial effect happens at the purchase voucher, reviewed by a human.

## 7. States

- No suggestions: "Nothing is below reorder level." — the healthy state.
- Missing reorder levels: a banner with the count and a link to fix them in the product catalogue,
  because a missing level silently suppresses suggestions.
- A product with no preferred supplier blocks inclusion until one is chosen on the row.

## 8. Responsive · 9. Accessibility

`md` grouping headers become sticky; the editable quantity stays visible · `xs` read-only.
The editable cell is labelled with the product name; the priority chip carries text.

## 10. Open questions

1. What is the reorder formula — fixed level, days-of-cover, or seasonal? Who owns it?
2. Should suggestions consider open POs already covering the gap? (They must, but the rule needs
   stating.)
3. Are narcotics or controlled items excluded from automatic suggestion?
