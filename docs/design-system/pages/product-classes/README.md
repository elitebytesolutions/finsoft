# Product classification

| | |
|---|---|
| **Route** | `/product-classes` |
| **Archetype** | E — Tree / Hierarchy |
| **Module / permission** | Products · `Products` · edit needs `master:create` |
| **Prototype source** | `ui-prototype/src/product-classes.tsx` (`ProductClasses`) |
| **Reference frame** | `ui-prototype/design/porduct classification.png` |
| **Posts to the ledger** | no |

## 1. Purpose

The two-level product classification — main type and sub type — used for reporting, margin analysis
and navigation. Small master, high leverage: every product report groups by it.

## 2. Anatomy

```
PageHead   "Product Classes" · [Export] [+ Add class]
KpiRow     Main types · Sub types · Unclassified products · Products classified
TreeTable  Class name · Sub ID · Parent Main ID · Sub Type Name · Products · Visibility · Actions
Footer     showing · pager
Modal      Add / edit class: level (Main / Sub), parent, code, name, visibility, sort order
```

## 3. Components

`TreeTable` (two levels only) · `KpiRow` · `Modal` · `Toggle` (visibility) · `ConfirmDialog` ·
`StatusBadge`.

## 4. Columns

| Column | Align | Format |
|---|---|---|
| Class name | left | indented by level, name (700) |
| Sub ID | left | code, tabular |
| Parent Main ID | left | parent code, em dash at main level |
| Sub Type Name | left | descriptive name |
| Products | right | count; links to the catalogue filtered by class |
| Visibility | left | toggle — Visible `good` / Hidden `neutral`; hidden classes stay on existing products but are not offered on new ones |
| Actions | right | Add sub type · Edit · Hide · Delete |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Add class | primary | `master:create` | no | Main or sub, parent required for sub |
| Add sub type (row) | overflow | `master:create` | no | Creates under that main type |
| Edit | row | `master:edit` | no | Code read-only once products reference it |
| Hide | toggle | `master:edit` | no | Reversible, no data effect |
| Delete | row | `master:delete` | **yes** | **Only when no products and no sub types reference it**; otherwise the dialog explains and offers Hide |
| Move products | overflow | `master:edit` | **yes, with the count** | Re-classifies a whole class's products in one audited operation |

## 6. States

- **Unclassified products** is a KPI on purpose: an unclassified product silently disappears from
  every grouped report. The KPI links to the filtered catalogue.
- Empty: offers a starter classification import.
- A main type with no sub types carries an `info` chip.

## 7. Responsive · 8. Accessibility

`md` the tree collapses to name + products + visibility · `xs` card list.
`role="treegrid"` with `aria-level`; the visibility toggle's label states the consequence.

## 9. Open questions

1. Is two levels enough, or does reporting need a third (therapeutic group)?
2. Are classes shared with the legacy Bhatti coding for migration, and must codes be preserved?
3. Should class drive a default GST rate or margin?
