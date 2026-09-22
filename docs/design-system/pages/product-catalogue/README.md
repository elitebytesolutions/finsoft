# Product catalogue

| | |
|---|---|
| **Route** | `/products` (legacy list at `/products/legacy`) |
| **Archetype** | A — Register (tabbed) |
| **Module / permission** | Products · `Products` · create/edit needs `master:create` |
| **Prototype source** | `ui-prototype/src/product-catalogue.tsx` (`ProductCatalogue`) |
| **Reference frames** | `design/product catalogue page .png`, `products catalogue page .png` |
| **Posts to the ledger** | no |

## 1. Purpose

The medicine master: what we sell, how it is packed, what it costs, what it sells for, where it
sits, and how much is on hand. Every other screen's product picker is a view of this table.

## 2. Anatomy

```
PageHead   "All Products" · "Manage medicines, pricing, batches and reorder controls."
           [Import] [Export] [+ Add product]
Tabs       All · By Company · By Class · Shelf · Short Items · Expiry Required · Precious ·
           Narcotics · Stock List
FilterBar  search (name, code, UPC, generic) · company · class · shelf · status
DataTable  ☐ · Code · Product Name · Pack · Company · Class · UPC · Shelf · Stock ·
           Cost / Unit · Purchase · W. Price · Retail · Low Level · High Level · Actions
Footer     showing · rows per page · pager
Modal      "New Product" / "Edit Product"
```

Tabs are **saved filters over one table**, not different tables — the columns never change between
tabs, only the row set and the default sort.

## 3. Components

`Tabs` · `FilterBar` · `DataTable` (with column menu) · `Modal` (wide, product form) ·
`StatusBadge` · `ImportDialog` · `ExportMenu` · `ConfirmDialog`.

## 4. Columns

| Column | Align | Format | Priority |
|---|---|---|---|
| Code | left | tabular, links to `/products/:id` | 1 |
| Product Name | left | name (700) + 9.5px generic name | 1 |
| Pack | left | `10's`, `100ml` | 2 |
| Company | left | manufacturer, links to `/companies` | 3 |
| Class | left | class chip | 3 |
| UPC | left | barcode, tabular | 4 |
| Shelf | left | location code | 4 |
| Stock | right | on-hand; `warn` below low level, `danger` at zero | 1 |
| Cost / Unit | right | weighted average; **hidden without `stock:view-cost`** | 2 |
| Purchase / W. Price / Retail | right | money, 2 dp | 2 |
| Low / High Level | right | reorder controls | 5 |
| Actions | right | Edit · View · Batches · Deactivate | 1 |

Flags render as chips beside the name: `Narcotic` `danger` · `Precious` `info` ·
`Expiry required` `warn` · `Cold chain` `info`.

## 5. Product form fields

Code · Name · Generic name · Company · Class · Pack size and unit · UPC/barcode · Shelf ·
GST rate · Cost method (fixed to weighted average) · Purchase price · Wholesale price ·
Retail price · Low level · High level · Expiry required · Narcotic · Precious · Cold chain ·
Status.

Validation: code and UPC unique per tenant; retail ≥ wholesale ≥ purchase unless the tenant permits
otherwise (then it warns, with the margin shown); low level < high level; GST from the permitted
set.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Add product | primary | `master:create` | no | Creates the master. **Opening stock is not set here** — it is a stock entry |
| Edit | row | `master:edit` | price change: yes, with the effective date | Cost method and pack size become read-only once movements exist |
| Deactivate | row | `master:edit` | **yes** | Removed from pickers; existing stock and history remain |
| Delete | — | — | — | **Not offered** for a product with any movement |
| Import | secondary | `master:create` | yes, with a validation preview | CSV with per-row errors before anything is written |

## 7. Financial rules

- Cost is **derived from movements**, never typed. The cost field in the form is the purchase price
  reference, not the valuation cost, and the labels say so.
- Changing pack size after movements exist would silently restate quantity history — it is refused.
- Price changes are effective-dated and audited; they never restate posted documents.

## 8. States

Empty catalogue with an import offer; filtered empty; a product with stock but no movements flagged
as an integrity error; narcotics visible only to permitted roles if the tenant requires it.

## 9. Responsive · 10. Accessibility

`xl` hides UPC, Shelf, levels · `lg` hides Class and Company · `md` the table scrolls with Code and
Name sticky · `xs` card list. Flag chips carry text; the stock cell's warning state is stated in its
accessible label.

## 11. Open questions

1. Is the pack hierarchy (box → strip → tablet) modelled, and does the UI need unit conversion?
2. Who may change retail price, and does it need approval?
3. Are narcotics restricted by role, by branch, or both?
