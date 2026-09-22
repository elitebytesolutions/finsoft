# Product catalogue (legacy)

| | |
|---|---|
| **Route** | `/products/legacy` |
| **Archetype** | A — Register |
| **Module / permission** | Products · `Products` · create/edit needs `master:create` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Products`, a page-local component distinct from `ProductCatalogue`) |
| **Reference frames** | none — see §1 |
| **Posts to the ledger** | no |

## 1. Purpose and status

The flat product list `/products` used before it was rebuilt as the tabbed, richer
[product-catalogue](../product-catalogue/) (`ProductCatalogue` component). It is kept live at
`/products/legacy`, routed and permission-gated exactly like any current page, not removed —
**this document exists to record what it is and that it should not be extended**, not to license
new work on it.

Both frames named for the product catalogue (`product catalogue page .png`,
`products catalogue page .png`) are the same image and both depict the current `ProductCatalogue`
screen — the filter row with Company/Principal, Class, Sub Class, Warehouse, Location and the
"Show/Hide Columns" panel described in `product-catalogue/README.md` §2. Neither depicts this
simpler legacy table, so no frame is listed.

## 2. Anatomy

```
PageHead   "Product catalogue" · "Manage medicines, pricing, batches and reorder controls."
                                                              [Export] [+ Add product]
Toolbar    [search product, generic or code] · [category select] · [More filters] · "<n> products"
Panel      "All products" — Product (icon well + name + code/generic) · Category ·
           Batches / next expiry · Stock · Avg. cost · Retail price · Status · [View]
Modal      "New Product" (`ProductFormModal`) — same modal component `ProductCatalogue` uses
```

There is no tab strip, no bulk selection, no column picker and no code/UPC/pack/company/class/shelf
columns — this is materially the pre-classification version of the same list.

## 3. Components

`PageHead` · `SearchField` · a plain category `Select` · `Table` (page-local rows, not the kit
`DataTable` — no sorting, no column menu, no pagination) · `Badge` · `ProductFormModal` (**shared**
with `product-catalogue` — the same "Add product" modal is reused verbatim, so the two screens can
create identically-shaped products even though they list them differently).

## 4. Columns

| Column | Align | Format | Compare to `product-catalogue` |
|---|---|---|---|
| Product | left | icon well + name (700) + 9.5px `<code> · <generic>` | same identifying pattern, no separate Code column |
| Category | left | plain text | present in both |
| Batches / next expiry | left | `<n> batches` (700) + 9.5px earliest expiry date | `product-catalogue` splits this differently: no combined cell, expiry lives inside the Batches tab |
| Stock | right | on-hand quantity, 700 | `product-catalogue`'s Stock column additionally colours `warn`/`danger`; this table does not — see §7 |
| Avg. cost | right | money — weighted average across batches | matches `product-catalogue`'s Cost / Unit, but **not gated by `stock:view-cost`** here — see §7 |
| Retail price | right | money, 700 | matches |
| Status | left | `In stock` (`good`) / `Low stock` (`warn`) | matches the health logic elsewhere, but has no `danger`/zero-stock tone — see §7 |
| (view) | right | `View` link to `/products/:id` | matches |

No Code, Pack, Company, UPC, Shelf, Class, Purchase/Wholesale price or reorder-level columns —
these were added when the screen became `product-catalogue` and were never backfilled here.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Add product | primary | `master:create` | no | Opens `ProductFormModal` — same modal, same validation as `product-catalogue` §6 |
| View | row | — | no | `/products/:id` (`product-detail`) — the **same** detail page both catalogues link to |
| Export | secondary | `Reports` | no | Rendered with no wired handler in the prototype |
| More filters | secondary | — | no | Rendered with no wired handler in the prototype |

## 6. Financial rules on this page

Same as `product-catalogue` §7: cost is derived from movements and must never be typed directly;
this page merely displays fewer of the fields that make that rule visible (no explicit "Cost /
Unit" label distinguishing it from a purchase price).

## 7. Deviations and gaps to reconcile

- **Cost is not gated by `stock:view-cost`.** Every other product and inventory screen in this
  system hides cost/value columns from roles without that permission
  (`product-catalogue` §4, `stock-overview` §4, `stock-batch-expiry` §7). This legacy table shows
  `Avg. cost` unconditionally. Since it is a real, reachable, permission-gated route (not dead
  code), this is a genuine gate gap, not a cosmetic one — flag before this route is ported.
- **Stock has no `danger` (zero/negative) tone**, only `warn` for below-reorder — inconsistent with
  `01-foundations.md` §1.4's fixed tone table and with `product-catalogue`'s own Stock column.
- **No flags** (`Narcotic`, `Precious`, `Expiry required`, `Cold chain`) shown anywhere on this
  table, unlike `product-catalogue` §4 — a narcotic product looks identical to any other here.
- The two catalogues can drift in what a "product" looks like (this one omits Class, Company, UPC
  entirely) while writing to the same underlying records through the same modal — a data-shape risk
  more than a display one.

## 8. States

Empty, filtered-empty, error — standard. No permission/forbidden distinction from `product-catalogue`;
both gate on `Products` module access and `master:create` for creation.

## 9. Responsive · Accessibility

`md` the table scrolls, Product stays sticky · `xs` card list. No column-hide behaviour exists to
describe, unlike `product-catalogue` §9, because there is no column menu.

## 10. Open questions

1. Is this route scheduled for removal, or does some workflow (e.g. a faster add-product path,
   or a role that should not see classification detail) genuinely need the simpler table kept?
2. If kept, does it get the `stock:view-cost` gate and the zero-stock `danger` tone backfilled, or
   does divergence from `product-catalogue` stop being tolerated and the two screens merge?
3. Who currently reaches `/products/legacy` — is it linked from anywhere in the product today, or
   only reachable by typing the URL?
