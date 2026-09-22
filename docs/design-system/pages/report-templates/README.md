# Template library

| | |
|---|---|
| **Route** | `/reports/templates` |
| **Archetype** | A — Register |
| **Module / permission** | Reports · `Reports` |
| **Prototype source** | `ui-prototype/src/reports-pages.tsx` (`ReportTemplates`) |
| **Posts to the ledger** | no |

## 1. Purpose

Manage report layouts: the built-in set and everything users have saved. Also the home of print
templates for documents.

## 2. Anatomy

```
PageHead   "Template library" · "Built-in reports and saved templates — organise, clone and delete
            your layouts." · [+ New from studio]
Tabs       Reports · Print templates
FilterBar  search · category · owner (mine / team / built-in) · source
CardGrid   template card: icon · name · description · category chip · source chip ·
           owner · last run · [Run] [...]
```

## 3. Components

`Tabs` · `FilterBar` · `TemplateCard` (page-local) · `DropdownMenu` · `ConfirmDialog` ·
`Badge` · `EmptyState`.

## 4. Card contents

Name (700) · one-line description · category chip · data source chip · `Built-in` or owner avatar ·
last run timestamp · primary `Run` action · overflow: Edit in studio, Duplicate, Rename, Share,
Set as default, Export definition, Delete.

Built-in templates show `Built-in` and cannot be edited or deleted — only duplicated. The overflow
reflects that by omitting those items, not disabling them.

## 5. Print templates tab

Per document type (invoice, purchase, GRN, PO, payment voucher, cheque, statement): the active
layout, its letterhead, its copy markings, and a preview. Changing the active template for a
document type is confirmed, because it changes what customers and suppliers receive.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Run | primary | `Reports` | no | `/reports/:id` |
| Duplicate | overflow | `Reports` | no | Copy owned by the current user |
| Share | overflow | `Reports` | no | Private / team / tenant |
| Set as default (print) | overflow | `Admin & Control` | **yes** | Changes what is printed for that document type |
| Delete | overflow (danger) | owner or `Admin & Control` | **yes** | Custom templates only; built-ins cannot be deleted |

## 7. Rules

- Deleting a template does not affect reports already generated from it — those are files, not
  links. The dialog says so, to remove the fear.
- A template whose data source or column no longer exists is marked `Needs attention` with the
  missing field named, and its Run action opens the studio instead of failing.

## 8. States

Empty custom set with a studio offer; a broken template marked and explained; filtered empty.

## 9. Responsive · 10. Accessibility

`xl` 4 cards per row · `md` 2 · `xs` 1. Cards are articles with the name as heading; the overflow
menu is keyboard reachable; chips carry text.

## 11. Open questions

1. Do print templates need a visual editor, or is configuration (letterhead, fields, copies) enough
   for MVP?
2. Can a template be exported and imported between tenants?
3. Who owns a template when its creator leaves?
