# Settings & control

| | |
|---|---|
| **Route** | `/settings` |
| **Archetype** | — (settings shell: nav rail + sections) |
| **Module / permission** | Administration · `Admin & Control` |
| **Prototype source** | `ui-prototype/src/control-pages.tsx` (`SettingsPage`) |
| **Posts to the ledger** | no — but several settings change how future postings behave |

## 1. Purpose

Tenant configuration: who we are, how our year is structured, how documents are numbered, what the
tax rules are, and which behaviours are switched on.

## 2. Anatomy

```
PageHead   "Settings & control" · "Organisation profile, financial year, document numbering and
            preferences." · [Save changes]
Layout     [ section rail 240px ]        [ section content ]
             Company                        titled panels of fields, each with
             Financial year & periods       a description and a Save per panel
             Document numbering
             Tax
             Finance
             Sales & distribution
             Purchase
             Inventory & products
             Users & roles ->
             Approval rules
             Print templates ->
             Audit trail ->
             Backup & restore
```

Items with `->` route to their own screen rather than rendering inline — settings is a hub, not a
container for everything.

## 3. Components

`SettingsRail` (page-local) · `Panel` · `FormSection` · `Field` set · `Toggle` · `Select` ·
`ConfirmDialog` · `Badge` · `FormErrorSummary`.

## 4. Sections and their risk

| Section | Contents | Risk level |
|---|---|---|
| Company | Name, legal name, NTN/STRN, address, branches, logo, currency, timezone | Medium — appears on every document |
| Financial year & periods | Year start, period list with status, **closing is done at `/period-close`** | **High** |
| Document numbering | Prefix, sequence, reset policy per document type | **High** — see below |
| Tax | GST rates, WHT sections and rates, filer/non-filer defaults | **High** |
| Finance | Default accounts (rounding, suspense-free policy, cheque control accounts), decimal places | **High** |
| Sales & distribution | Price lists, default sale type, credit policy defaults | Medium |
| Purchase | Default terms, duplicate-bill policy, landed cost method | Medium |
| Inventory & products | Costing method (fixed to weighted average), batch policy, expiry windows, reorder defaults | **High** |
| Approval rules | Thresholds per document type and role | **High** |
| Backup & restore | Schedule, last backup, restore request (request only, never executed from the app) | **High** |

## 5. Rules for high-risk settings

- **Document numbering** changes are confirmed with a preview of the next number and a warning that
  gaps and duplicates are audit findings. Sequences are server-issued; the screen never lets a user
  set "next number" backwards to a value already used.
- **Costing method is displayed read-only** as Weighted average
  ([ADR-0007](../../../adr/ADR-0007-weighted-average-costing.md)). It is not a dropdown, because
  changing it would restate every cost in history.
- **Decimal places** for money cannot be reduced once postings exist.
- **Tax rate changes are effective-dated** and never restate posted documents; the panel shows the
  current and scheduled rates.
- **Backup & restore** offers a restore *request*, not a restore. The application never restores a
  database from a UI action; the panel says so and names the procedure
  ([INFRASTRUCTURE](../../../INFRASTRUCTURE.md)).
- Every change writes an audit entry with old and new values.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save (per panel) | primary | `Admin & Control` | **yes for high-risk panels, restating the effect** | Audited; effective immediately unless effective-dated |
| Add branch | secondary | `Admin & Control` | yes | Creates a branch master |
| Request restore | danger | Owner only | **yes, typed confirmation** | Raises a request; performs nothing |

## 7. States

Unsaved changes per panel with a persistent bar; validation errors summarised per panel; a setting
locked by existing data explains why inline ("Decimal places cannot be changed — 4,212 postings
exist").

## 8. Responsive · 9. Accessibility

`md` the rail becomes a select above the content · `xs` one panel per screen with back navigation.
Each panel is a `<form>` with its own heading and error summary; locked fields are read-only text
with an explanation, not disabled inputs.

## 10. Open questions

1. Which settings are per tenant and which are per branch?
2. Who may change tax rates — Owner only, or Accountant too?
3. Is there a settings change-history view, or does it live only in the audit trail?
