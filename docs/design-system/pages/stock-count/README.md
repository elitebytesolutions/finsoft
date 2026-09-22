# Physical count

| | |
|---|---|
| **Route** | `/inventory/count` |
| **Archetype** | A — Register, modifier: inline bulk-edit worksheet (no existing archetype models this exactly — see §9) |
| **Module / permission** | Inventory · `Inventory` · posting needs `stock:post` |
| **Prototype source** | `ui-prototype/src/inventory-pages.tsx` (`InventoryWorkspace` with `view="count"`, body `PhysicalCount`) |
| **Reference frames** | none |
| **Posts to the ledger** | **yes** — a single variance adjustment per line that differs from system quantity |

## 1. Purpose

Reconcile what the system believes is on the shelf against what is physically there, batch by
batch, and post only the differences. This is the count sheet referenced by `stock-overview`'s
"Stock count" view and by `stock-entry`'s reason table (`Found on count` → Inventory gain); it is
the one screen where a variance is entered and posted, rather than read.

## 2. Shared component — read this with its siblings

Same `InventoryWorkspace` shell as `/inventory/issue`, `/inventory/as-of` and `/inventory/batches`
— see [stock-issue-adjustment §2](../stock-issue-adjustment/#2-shared-component--read-this-with-its-siblings)
for the full list of what is shared (`PageHead`, `InventoryNav`, `AppData`/`onPost`) and not
repeated here.

**Specific to this route:** the `PhysicalCount` body — a single always-visible worksheet, not a
paged register. Every batch line for every product is loaded at once (`data.products.flatMap`);
the only reduction is client-side text search. There is **no KPI row** — the only summary figure is
the single "Net variance" tile in the toolbar, and it is a live total, not a set of KPIs.

## 3. Anatomy

```
PageHead      "Physical count" · description                              (no page-level actions)
InventoryNav  Current stock · Stock in · Issue/adjust · Stock transfer · [Physical count] · Batch & expiry
Toolbar       icon · "Count sheet · Lahore Main" · line-count + fixed count date ·
              [search product or batch] · "Net variance" tile (turns `warn`-tinted when non-zero) ·
              [Post count]  (disabled while net variance is zero)
Panel         "Physical inventory count" — one table, every batch line editable in place
              Product · Batch · Expiry · System qty · Physical qty (input) · Variance · Status
Success       posting replaces the toolbar+table with the shared `OperationSuccess` panel
```

## 4. Columns

| Column | Align | Format |
|---|---|---|
| Product | left | name (700) + 9.5px SKU |
| Batch | left | batch id |
| Expiry | left | date |
| System qty | right | the quantity the ledger currently believes, read-only |
| **Physical qty** | right | editable `QuantityInput`, pre-filled with the system quantity |
| Variance | right | `Physical − System`, signed, 700 weight when non-zero |
| Status | left | `Matched` (`good`) when variance is zero, `Review` (`warn`) otherwise |

There is no "blind count" mode: the physical-quantity field is pre-populated with the system
quantity the counter is meant to be verifying, which they can simply leave unchanged. Whether that
is acceptable is an open question — see §9.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Post count | primary | `stock:post` | **prototype: none — disabled only while variance is zero; see §8** | One `Count` movement per line with a non-zero variance, sharing one reference number; the count sheet becomes immutable |
| Post another | secondary | — | no | Clears the sheet back to system quantities |

Posting loops every line and calls `onPost` once per non-zero-variance batch — this is a **bulk**
post from a single confirm, unlike every other posting surface in the kit, which posts one document
at a time. Archetype B's rule ("Bulk posting is not offered", stated for the Voucher Register) is
being crossed here for a different reason — the count sheet *is* the document, and its lines are
its lines — but it should be stated explicitly, not left implicit.

## 6. Financial rules on this page

- **A stock count posts a variance adjustment, never an overwrite of the system quantity** — this
  is a Level 0 rule ([NON_NEGOTIABLES](../../../NON_NEGOTIABLES.md), restated in `stock-overview`
  §6) and this screen honours it: the kernel receives a signed `Count` movement per line, not a
  replacement quantity.
- The module never writes `stock_movements`; it calls `inventoryKernel.postMovement` per line
  inside one transaction, and the posting engine raises the accounting event for the aggregate
  value effect.
- Posting must be idempotent for the sheet as a whole, not only per line — three identical "Post
  count" clicks must not triple the variance.
- Closed period blocks posting; the sheet remains editable and printable.
- Once posted, the sheet is immutable; a further correction is a new count or a manual adjustment,
  never an edit to this one.

## 7. States

Empty search result — the standard filtered-empty copy, but the Post action still refers to the
full unfiltered sheet's variance, and the page should say so. No variance — Post is disabled, not
hidden. A very large catalogue — this screen has no pagination or virtualisation in the prototype;
production needs one or the other before a tenant with thousands of batches can use it (see §9).

## 8. Deviations from the prototype

- **No confirmation before posting.** As with `stock-issue-adjustment`, archetype B requires a
  confirm dialog restating what will post before a "Save & post" action fires. Here that dialog
  must restate the **count sheet total**: number of lines with a variance, the net quantity
  variance, and the net value effect — the single most consequential number on the screen — none of
  which is shown anywhere before the click today.
- No pagination, virtualisation or "count in progress" resumable-draft affordance, despite
  `stock-overview` §7 promising one ("A count sheet in progress is shown as a resumable draft").
  The prototype's `PhysicalCount` has no draft state at all: the sheet is either being edited or it
  is posted.
- No location/warehouse selector — the toolbar hard-codes "Lahore Main"; multi-warehouse tenants
  need one, per `stock-overview`'s own open question 3.

## 9. Open questions

1. What is this screen's correct archetype? It reads like a register (one row per batch, filtered
   by search) but behaves like a single bulk document-entry form with inline edit. If this pattern
   recurs elsewhere, it needs a named modifier in `03-patterns.md` rather than being reinvented per
   screen — flag to the design-system agent before a second instance is built.
2. Is a blind count (system quantity hidden until the physical count is entered and reconciled
   after) required, given the pre-filled field currently defeats the purpose of counting?
3. How does a partially-completed count sheet survive a page reload, given there is no draft state?
4. Does the confirm dialog in §8 need a line-by-line preview, or is the aggregate sufficient given
   the sheet itself is already the line-by-line view?
