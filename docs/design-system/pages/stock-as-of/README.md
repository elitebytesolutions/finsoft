# Stock as on date

| | |
|---|---|
| **Route** | `/inventory/as-of` |
| **Archetype** | A — Register (read-only, point-in-time) |
| **Module / permission** | Inventory · `Inventory` |
| **Prototype source** | `ui-prototype/src/inventory-pages.tsx` (`InventoryWorkspace` with `view="as-of"`, body `StockAsOf`) |
| **Reference frames** | none |
| **Posts to the ledger** | no — this is a **read**, reconstructed surface |

## 1. Purpose

Answer "what did we hold, and what was it worth, on a past date" without waiting for a period-end
report. It reconstructs quantity from the movement ledger rather than reading a stored historical
balance, so it is exact for any date the movement history covers.

## 2. Shared component — read this with its siblings

Same `InventoryWorkspace` shell as `/inventory/issue`, `/inventory/count` and `/inventory/batches`
— see [stock-issue-adjustment §2](../stock-issue-adjustment/#2-shared-component--read-this-with-its-siblings)
for what all seven inventory routes share. Not repeated here.

**Specific to this route:** the `StockAsOf` body — a banner, a toolbar and a read-only table. There
is no KPI row (see the same note in the sibling documents) and, unlike the other three sibling
views, **no posting action of any kind** — this view never calls `onPost`.

**This route is reachable only from a button, not from the shared tab strip** — see §9.

## 3. Anatomy

```
PageHead      "Stock as on date" · description                            (no page-level actions)
InventoryNav  Current stock · Stock in · Issue/adjust · Stock transfer · Physical count · Batch & expiry
              (none of the six items shows as active on this route — see §9)
Banner        icon · "Historical stock position" · explanatory sentence · [ As on date: <date picker> ]
Toolbar       [search product] · [All locations ▾] · [Export snapshot]
Panel         "Stock as on <date>" — Product · Category · Quantity · Avg. cost · Stock value ·
              Reorder status
```

## 4. Columns

| Column | Align | Format |
|---|---|---|
| Product | left | name (700) |
| Category | left | plain text |
| Quantity | right | reconstructed as-of quantity: current stock minus every non-transfer movement dated after the cutoff |
| Avg. cost | right | money — the product's **current** weighted-average cost, not a historical cost as of the cutoff (see §8). It is a **rate, shown for information**; it is never multiplied by a quantity to produce a value |
| Stock value | right | money, 700 — the **carried value as at the cutoff**: `Σ inventory_value_delta` over movements dated on or before the cutoff, for the costing scope. **Not `Quantity × Avg. cost`** (ADR-0015 §7), and **not today's `value_on_hand`** — that is a different date's answer. See §8 |
| Reorder status | left | `Below level` (`warn`) / `Sufficient` (`good`), compared to the product's **current** reorder point |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| As on date | date field | — | no | Recomputes every row for the new cutoff; future dates are disabled (`max` = today) |
| Search | text field | — | no | Client-side filter by product name |
| Location select | select | — | no | Rendered, but not wired to the calculation — see §8 |
| Export snapshot | secondary | `Reports` | no | Per `03-patterns.md` H/A rules, must carry the as-of date, company and generated-at in the file header |

Nothing on this page posts, edits or deletes.

## 6. Financial rules on this page

- **The as-of view is a point-in-time reconstruction from movements**, per `stock-overview` §6, and
  it must state the timestamp it was computed at. The prototype does not print a "computed at"
  timestamp anywhere on this page — only the chosen as-of date, which is not the same thing (the
  reconstruction is run live, on every keystroke of the date field, against the in-memory movement
  set). Production must add the computed-at stamp.
- Quantity is derived, never typed or stored for a past date — consistent with the ledger being
  truth.
- This page reads; it never writes `stock_movements` and never calls the inventory kernel's posting
  entry point.

## 7. States

Empty search result — standard filtered-empty copy. A cutoff date before the tenant's data begins —
should read as all quantities zero, not as an error; not distinguished from a genuine zero-stock
date in the current implementation (see §8). Error loading the movement set — standard `ErrorState`.

## 8. Deviations from the prototype

- **Stock value is reconstructed to the cutoff, and this is now decided.** A historical snapshot
  must sum `inventory_value_delta` over movements dated on or before the cutoff. It must **not**
  read today's `stock_costing_state.value_on_hand`, which answers a different question, and it must
  not multiply a historical quantity by today's average — that is the ADR-0015 §7 recomputation
  with a date error layered on top. Both the quantity and the value are reconstructed from the
  movement ledger over the same cutoff, so they agree with each other and with the inventory GL as
  at that date.

- **Avg. cost and Reorder status still use current values, and this remains open.** The average is
  a rate, shown for information only, so it no longer feeds the value column — which removes the
  misstatement. But a column headed `Avg. cost` in a snapshot dated 1 January, showing today's
  rate, is still misleading. Either relabel it as current-value context, or reconstruct the
  historical rate. Reorder status has the same problem and the same two options.
- **The "All locations" select does nothing.** It renders with a static option list but the
  quantity calculation (`data.movements.filter(...)`) has no location dimension at all. Either the
  reconstruction becomes location-aware or the control should not be shown until it is.
- **No "computed at" timestamp** — see §6.
- **No confirmation that a chosen date actually predates when a product existed** — a product added
  after the cutoff still appears, at its current stock level minus later movements, which can
  understate rather than correctly show "did not exist yet."

## 9. Open questions

1. `InventoryNav`'s six items are `overview`, `stock-in`, `issue`, `transfer`, `count`, `batches` —
   `as-of` is not among them, so this route is reachable only via the "Stock as on date" button on
   the Overview page and has no persistent tab of its own. Is that intentional (a secondary, less-
   used view) or an oversight that should add a seventh tab?
2. Should this view support a location dimension, given the control for one is already drawn?
3. Does "as of" need its own permission distinct from `Inventory`, given it can expose historical
   valuation that `stock:view-cost` gates elsewhere in this module?
