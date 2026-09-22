# Batch & expiry control

| | |
|---|---|
| **Route** | `/inventory/batches` |
| **Archetype** | A — Register, with a summary row that doubles as its own filter (see §8) |
| **Module / permission** | Inventory · `Inventory` |
| **Prototype source** | `ui-prototype/src/inventory-pages.tsx` (`InventoryWorkspace` with `view="batches"`, body `BatchExpiry`) |
| **Reference frames** | none |
| **Posts to the ledger** | no — dispositions (quarantine, priority sale) are decisions this page surfaces, not movements it posts |

## 1. Purpose

Every batch of every product, ordered by how urgently it needs attention: expired first, then
inside 90 days, then inside six months, then everything else — FEFO (first-expiry-first-out)
priority order made visible so nothing quietly expires on a shelf.

## 2. Shared component — read this with its siblings

Same `InventoryWorkspace` shell as `/inventory/issue`, `/inventory/count` and `/inventory/as-of` —
see [stock-issue-adjustment §2](../stock-issue-adjustment/#2-shared-component--read-this-with-its-siblings)
for what all seven inventory routes share. Not repeated here.

**Specific to this route:** the `BatchExpiry` body. This is the sibling that most resembles
`stock-overview`'s own "Batches & expiry" row in its anatomy table, but it is a fuller register
than that one-line summary suggests — a filterable, sortable table with its own four-way segmented
summary, not a plain KPI row (there is no KPI row here either — see §8).

## 3. Anatomy

```
PageHead      "Batch & expiry control" · description                     (no page-level actions)
InventoryNav  Current stock · Stock in · Issue/adjust · Stock transfer · Physical count · [Batch & expiry]
SummaryFilter four clickable tiles, one active at a time:
              Expired (danger) · Next 90 days (warn) · Within 6 months (neutral) · All batches (good)
              each shows its own count and a one-line consequence ("Quarantine immediately", etc.)
Toolbar       [search product or batch] · "<n> batch records" · [Export register]
Panel         "Batch & expiry register" — sorted by days remaining, ascending
              Product · Batch · Expiry · Days remaining · Qty · Value · Disposition
```

## 4. Columns

| Column | Align | Format |
|---|---|---|
| Product | left | name (700) + 9.5px SKU |
| Batch | left | batch id |
| Expiry | left | date |
| Days remaining | right | `"<n> days"` or `"<n> days overdue"` when negative, 700 weight |
| Qty | right | packs on hand in this batch |
| Value | right | money — `Qty × cost` |
| Disposition | left | `Quarantine` (`danger`, days < 0) · `Priority` (`warn`, days ≤ 90) · `Saleable` (`good`, days > 90) |

## 5. The summary tiles are filters, not a KPI row

Unlike every `KpiRow` elsewhere in the kit, these four tiles are **stateful toggle buttons**: clicking
one sets the table's window filter, and exactly one is always visually "active". A `KpiRow` in
`01-foundations`/`03-patterns` is read-only and reports on whatever the surrounding filters already
narrowed to — it does not itself filter anything. This page inverts that relationship. It is
functionally closer to `FilterChip`s styled as large summary tiles than to a `KpiRow`, and does not
have a clean home in the current component vocabulary. Flag to the design-system agent before a
second screen copies this pattern: either it becomes a named `SummaryFilterTiles` component with an
explicit contract (exactly one active, counts always reflect the *unfiltered* set so the buttons stay
meaningful after being clicked), or it is retired in favour of a `KpiRow` plus a separate `FilterBar`
segmented control that happens to share the same four buckets.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Summary tile | filter toggle | — | no | Narrows the table to that expiry window |
| Search | text field | — | no | Client-side filter over product name and batch id |
| Export register | secondary | `Reports` | no | Rendered in the prototype with no wired export; production must produce the filtered set with company, window and generated-at per `03-patterns.md` |

Nothing on this page posts. A disposition decision (quarantine, priority sale) is read here and
acted on elsewhere — this page does not itself move stock.

## 7. Financial rules on this page

- Batch value is `Qty × cost`, using the batch's own recorded cost — unlike `stock-as-of`, this
  page does not substitute a current average cost for a historical one, because it has no
  historical dimension: every figure is as-of now.
- Cost and value should be hidden from roles without `stock:view-cost`, consistent with every other
  inventory screen (`stock-overview` §4, `product-catalogue` §4). The prototype does not gate them
  here — flagged in §9.
- This is a read surface; it neither writes `stock_movements` nor calls the inventory kernel.

## 8. States

Empty search result — standard filtered-empty copy, but the four summary tiles keep their
unfiltered counts (per §5's contract) rather than going to zero. No batches at all (new tenant) —
standard empty state pointing at `stock-entry` to receive the first batch. There is no KPI row on
this view — the four summary tiles are the only page-level totals, and they behave as filters, not
as read-only figures (§5).

## 9. Deviations from the prototype

- **Cost and value are not permission-gated** in `BatchExpiry`, unlike the equivalent columns
  everywhere else in Inventory and Products. This must be reconciled before build — either the
  gate is added here too, or there is a documented reason batch value is exempt (none is apparent).
- **Export register is decorative** — the button renders but has no handler in the prototype.
- The summary-tile-as-filter pattern itself (§5) is carried over uncritically from the prototype;
  it is workable but undocumented anywhere in `03-patterns.md` or `02-components.md`, which is a
  gap in the foundations, not a licence to invent a fifth one-off version of it on another screen.

## 10. Open questions

1. Should the summary tiles be promoted to a named kit component (§5), and if so, does `KpiRow`
   gain a `filterable` variant or does this stay a distinct pattern?
2. Is "Within 6 months" meant to be mutually exclusive with "Next 90 days," and should the counts
   be additive (a batch expiring in 60 days counts toward both "90 days" and, loosely, "6 months")
   or disjoint, as the current filter logic implements them?
3. Does disposition ever need to be *set* here (an override, e.g. marking a saleable batch for
   early clearance), or is it always derived purely from days-remaining?
