# Product companies (manufacturers)

| | |
|---|---|
| **Route** | `/companies` |
| **Archetype** | A — Register (+ create drawer) |
| **Module / permission** | Products · `Products` · create needs `master:create` |
| **Prototype source** | `ui-prototype/src/companies.tsx` (`ProductCompanies`) |
| **Reference frame** | `ui-prototype/design/company product page .png` |
| **Posts to the ledger** | no |

## 1. Purpose

The manufacturer master. Products belong to a company; purchasing, reporting and margin analysis
are all grouped by it, so it is a maintained master rather than a free-text field.

**Naming note:** "Company" here means *manufacturer*, while "company" in the top bar means *tenant*.
The UI must never use the bare word ambiguously — this page is titled **Product Companies** and the
picker on the product form is labelled **Manufacturer**.

## 2. Anatomy

```
PageHead   "Product Companies" · [Export] [+ New company]
KpiRow     Companies · Active products · Stock value by company (top) · Purchases this month
FilterBar  search · status · has-products
DataTable  Code · Company · Short name · Products · Stock value · Contact · Terms · Status · Actions
Drawer     "Create New Company" — code, name, short name, contact, email, phone, address,
           default payment terms, default margin, status
```

## 3. Components

`KpiRow` · `DataTable` · `Drawer` · `FormSection` · `StatusBadge` · `ConfirmDialog` · `ExportMenu`.

## 4. Columns

| Column | Align | Format |
|---|---|---|
| Code | left | tabular, unique per tenant |
| Company | left | name (700) + 9.5px short name |
| Products | right | count; links to the catalogue filtered by company |
| Stock value | right | money; hidden without `stock:view-cost` |
| Contact | left | person + 9.5px phone |
| Terms | left | default payment terms chip |
| Status | left | Active `good` · Inactive `neutral` |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New company | primary | `master:create` | no | Creates the master |
| Edit | row | `master:edit` | no | Code becomes read-only once products reference it |
| Deactivate | row | `master:edit` | **yes, naming the product count** | Hidden from pickers; existing products keep the reference |
| Delete | row | `master:delete` | **yes** | **Permitted only when no product references it**; otherwise the dialog explains and offers deactivate |
| Export | secondary | `Reports` | no | Filtered set |

## 6. States

Empty with an import offer; a company with zero products carries an `info` chip;
deactivating a company with active products warns with the count before proceeding.

## 7. Responsive · 8. Accessibility

`md` drawer becomes a sheet · `xs` card list. The drawer form has a visible required-field legend
and an error summary.

## 9. Open questions

1. Is a manufacturer ever also a vendor, and should the two masters be linked?
2. Are default margins per company used to suggest retail price on new products?
3. Is a company-level credit arrangement needed, or is that purely per vendor?
