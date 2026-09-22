# Stock issue & adjustment

| | |
|---|---|
| **Route** | `/inventory/issue` |
| **Archetype** | B — Document entry (single-line, no line grid) |
| **Module / permission** | Inventory · `Inventory` · posting needs `stock:post` |
| **Prototype source** | `ui-prototype/src/inventory-pages.tsx` (`InventoryWorkspace` with `view="issue"`, body `IssueAdjustment`) |
| **Reference frames** | none |
| **Posts to the ledger** | **yes** — via the inventory kernel and the posting engine |

## 1. Purpose

Take a small quantity out of stock, or correct a variance someone has already verified by counting
or investigating, without opening the full manual stock-entry document. One product, one batch, one
line, one reason. Anything larger or multi-line belongs on `stock-entry` (`/inventory/stock-in`).

## 2. Shared component — read this with its siblings

`/inventory/issue`, `/inventory/count`, `/inventory/as-of` and `/inventory/batches` are four routes
rendered by the **same** component, `InventoryWorkspace`, which also renders `/inventory`
(documented in [stock-overview](../stock-overview/)), `/inventory/stock-in` (documented in
[stock-entry](../stock-entry/)) and `/inventory/transfer` (documented in
[stock-transfer](../stock-transfer/)). Do not build a second copy of the shared parts.

**Shared across all seven inventory routes:**
- The `PageHead` eyebrow ("Inventory / Stock operations") and the per-view title/description pulled
  from one `titles` map in `InventoryWorkspace`.
- `InventoryNav` — a persistent six-item tab strip (Current stock, Stock in, Issue/adjust, Stock
  transfer, Physical count, Batch & expiry) rendered above the body on every view. **`/inventory/as-of`
  is not one of its six items** — see [stock-as-of §9](../stock-as-of/#9-open-questions).
- The `AppData` store and the `onPost` callback that writes a `StockMovement`.

**Specific to this route:** the `IssueAdjustment` body — a two-panel work grid with a mode toggle,
not a table. There is **no KPI row on this view.** `stock-overview`'s own anatomy block draws a
`KpiRow` above all views' bodies; in the code, the `kpi-grid` is built only inside `CurrentStock`
(the Overview body). Treat that as a documentation gap in `stock-overview`, not as a KPI row this
page actually has.

## 3. Anatomy

```
PageHead      "Stock issue & adjustment" · description                    (no page-level actions)
InventoryNav  Current stock · Stock in · [Issue/adjust] · Stock transfer · Physical count · Batch & expiry
Body          inventory-work-grid (two panels)
  Panel A     "Stock issue & adjustment" — mode toggle [ Stock issue | Inventory adjustment ]
              Product * · Batch * · Direction (Adjustment mode only: Increase/Decrease) ·
              Quantity * · Issue to (Issue mode only: Operations/Sales counter/Samples/Damaged goods) ·
              Reason / notes * (free text)
              inline warning when quantity exceeds the batch balance
              post bar: "Balance after posting" · [Post issue] / [Post adjustment]
  Panel B     "Selected batch" — live snapshot: product name, batch id + expiry, packs available
Success       posting replaces the grid with the shared `OperationSuccess` panel: check icon,
              reference number, "Post another"
```

## 4. Components

`SegmentedControl` (Stock issue / Inventory adjustment) · `ProductPicker` · a page-local
`ProductBatchFields` pairing (product + batch selects, shared with `PhysicalCount`'s sibling form
in the prototype but not exposed there — promotion candidate if a second document-entry screen
needs it) · `QuantityInput` · a plain `Select` for Direction and Issue-to · `Textarea` for reason ·
`InlineWarning` (over-quantity) · `Button`.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Post issue / Post adjustment | primary | `stock:post` | **prototype: none — see §10** | Inventory kernel posts the movement (signed quantity); posting engine posts the journal in the same transaction |
| Post another | secondary | — | no | Clears the form, stays on the page |

Quantity is capped in the input (`max`) at the selected batch's available stock whenever the
movement is a decrease, and the submit handler independently refuses to post past it.

## 6. Financial rules on this page

- **No offset account is shown anywhere on this screen.** Compare `stock-entry`
  (`/inventory/stock-in`), whose form requires an `Offset account *` field and states the rule
  plainly: *"A stock movement with no accounting counterpart is not permitted."* This page posts a
  quantity change with only a free-text reason — no resolved account, no mapping table. That is a
  contradiction of the same invariant this product enforces one screen over, and it must be
  reconciled before build: either this screen gains the same reason→account resolution as
  `stock-entry` (§5 of that document), or the two forms are merged into one. **Do not build this
  page as a movement with no visible ledger consequence.**
- Subject to the same kernel rule regardless of UI: the module never writes `stock_movements`
  directly; it calls `inventoryKernel.postMovement`, which posts the movement and raises the
  accounting event in the same transaction.
- Posting is idempotent.
- Closed period blocks posting.
- A posted movement is immutable; correction is an opposite movement, linked.

## 7. States

Empty product list (new tenant, no products) — blocked entirely, not just this form. Quantity
exceeds batch balance — inline `danger` warning, submit disabled. Missing reason — required field,
inline validation. Closed period — see `04-states.md` §6. Post failure — see `04-states.md` §10.

## 8. Responsive · Accessibility

`md` the two panels stack, batch snapshot moves below the form · `sm` unchanged, this is a short
form. Product and batch selects are labelled; the quantity input's accessible name states the unit
(packs); the over-quantity warning is `aria-live="polite"`.

## 9. Deviations from the prototype

- **No confirmation before posting.** Archetype B (`03-patterns.md`) requires: *"Posting flow:
  confirm dialog → busy button → toast with the document number → route to the document detail
  page."* `IssueAdjustment` posts directly on submit with no `ConfirmDialog`. This is a foundations
  violation, not a valid pattern to copy — production must add the confirm step, restating product,
  batch, signed quantity and (once §6 above is resolved) the account it will hit.
- No document detail page to route to afterwards — posting stays on this screen and shows
  `OperationSuccess` instead of navigating away, unlike the archetype's prescribed flow. Whether
  that is acceptable for a quantity-only correction, or whether it also needs a detail page, is
  open — see §10.
- No offset-account field at all (§6) — the most significant gap on this page.
- The reason field is unconstrained free text, unlike `stock-entry`'s configured reason list.

## 10. Open questions

1. Does this screen get the same reason→account mapping as `stock-entry`, or is it merged into that
   document entirely and this route retired?
2. Should `Post issue` / `Post adjustment` require the confirm dialog every archetype-B screen
   requires, and if so, does it also need a linked detail page afterwards?
3. Is "Issue to" (department) itself the accounting classification, or a separate dimension from
   the offset account?
