# Page documents — index

One folder per page. Each folder holds a `README.md` that is **the design system of that page**:
its archetype, anatomy, components, columns, actions, states, financial rules, responsive and
accessibility behaviour, and its open questions.

A page is designed when its folder is filled in. A page is done when the built screen matches it.

Archetype codes: **A** Register · **B** Document entry · **C** Document detail · **D** Ledger ·
**E** Tree · **F** Master record · **G** Workbench · **H** Report · **I** Dashboard
(see [03-patterns.md](../03-patterns.md)).

---

## Core & cross-cutting

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Application shell (sidebar, top bar) | — | — | [app-shell](app-shell/) |
| Executive dashboard | `/dashboard` | I | [dashboard](dashboard/) |
| Today's tasks | `/today` | G | [todays-work](todays-work/) |
| Access restricted | `/unauthorized` | — | [unauthorized](unauthorized/) |

## Accounting — accounts & ledgers

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Chart of Accounts | `/accounts` | E | [chart-of-accounts](chart-of-accounts/) |
| Account Ledger | `/ledgers` | D | [account-ledger](account-ledger/) |
| Account detail (ledger permalink) | `/finance/accounts/:code` | D | [account-detail](account-detail/) |
| Cash Book | `/cash-book` | D | [cash-book](cash-book/) |
| Cash Transactions | `/cash-transactions` | A | [cash-transactions](cash-transactions/) |

## Accounting — vouchers

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Voucher Register | `/vouchers` | A1 | [voucher-register](voucher-register/) |
| Voucher detail | `/vouchers/:id` | C | [voucher-detail](voucher-detail/) |
| New Voucher | `/vouchers/new` | B | [voucher-new](voucher-new/) |
| Voucher templates (recurring) | `/recurring` | A | [recurring-templates](recurring-templates/) |
| Approval queue | `/approvals` | G | [approval-queue](approval-queue/) |
| Period close | `/period-close` | G | [period-close](period-close/) |

## Accounting — bank & cheques

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Bank Accounts | `/bank-accounts` | A | [bank-accounts](bank-accounts/) |
| Bank Transactions | `/bank-transactions` | D | [bank-transactions](bank-transactions/) |
| Bank Book / reconciliation | `/bank-book` | D | [bank-book](bank-book/) |
| Receive & Issue Cheques | `/cheque-voucher` | B | [cheque-voucher](cheque-voucher/) |
| Cheque posting & reversal | `/cheque-posting` | A1 | [cheque-posting](cheque-posting/) |
| Cheque exceptions | `/cheque-actions` | A | [cheque-actions](cheque-actions/) |
| Cheque clearing | `/cheque-clearing` | G | [cheque-clearing](cheque-clearing/) |

## Accounting — receivables & payables

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Accounts receivable | `/receivables` | A | [receivables](receivables/) |
| Accounts payable | `/payables` | A | [payables](payables/) |
| Payments & receipts | `/payments` | B | [payments-centre](payments-centre/) |
| Credit limits & terms | `/credit-limits` | A | [credit-limits](credit-limits/) |

## Sales & distribution

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Sales invoices register | `/sales` | A | [sales-register](sales-register/) |
| Sales voucher (entry) | `/sales/voucher` | B | [sales-voucher](sales-voucher/) |
| Sales invoice detail | `/sales/:id` | C | [sales-invoice-detail](sales-invoice-detail/) |
| Sales returns | `/sales-returns` | B | [sales-returns](sales-returns/) |
| Field sales | `/field-sales` | A | [field-sales](field-sales/) |

## Purchasing

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Purchases register | `/purchasing` | A | [purchases-register](purchases-register/) |
| Purchase voucher (entry) | `/purchasing/voucher` | B | [purchase-voucher](purchase-voucher/) |
| Purchase invoice detail | `/purchases/:id` | C | [purchase-detail](purchase-detail/) |
| Purchase returns | `/purchasing/returns` | B | [purchase-returns](purchase-returns/) |
| Purchase orders | `/po` | A+B | [purchase-orders](purchase-orders/) |
| Demand & procurement | `/procurement` | G | [procurement](procurement/) |
| Print documents | `/purchasing/print` | H | [print-documents](print-documents/) |

## Inventory

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Stock & valuation (overview) | `/inventory` | A | [stock-overview](stock-overview/) |
| Manual stock in / out | `/inventory/stock-in` (alias `/inventory/movements`) | B | [stock-entry](stock-entry/) |
| Stock issue & adjustment | `/inventory/issue` | B | [stock-issue-adjustment](stock-issue-adjustment/) |
| Stock transfer | `/inventory/transfer` | B | [stock-transfer](stock-transfer/) |
| Physical count | `/inventory/count` | A | [stock-count](stock-count/) |
| Stock as on date | `/inventory/as-of` | A | [stock-as-of](stock-as-of/) |
| Batch & expiry control | `/inventory/batches` | A | [stock-batch-expiry](stock-batch-expiry/) |
| Stock movements ledger | `/inventory/movements/history` | D | [stock-movements](stock-movements/) |
| Stock vouchers (gift / breakage) | `/inventory/breakage` | B | [stock-vouchers](stock-vouchers/) |
| Inventory reports | `/inventory-reports` | H | [inventory-reports](inventory-reports/) |

`stock-overview`, `stock-entry`, `stock-issue-adjustment`, `stock-transfer`, `stock-count`,
`stock-as-of` and `stock-batch-expiry` are seven routes rendered by two components
(`InventoryWorkspace` and `StockTransferPage`) that share one `PageHead`/`InventoryNav` shell — see
[stock-issue-adjustment §2](stock-issue-adjustment/#2-shared-component--read-this-with-its-siblings)
for exactly what is shared and what is not. Each still has its own document because each is its own
route with its own job; none is a duplicate of another.

## Products

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Product catalogue | `/products` | A | [product-catalogue](product-catalogue/) |
| Product catalogue (legacy) | `/products/legacy` | A | [product-catalogue-legacy](product-catalogue-legacy/) |
| Product detail | `/products/:id` | F | [product-detail](product-detail/) |
| Product companies | `/companies` | A | [product-companies](product-companies/) |
| Product classification | `/product-classes` | E | [product-classes](product-classes/) |
| Product reports | `/product-reports` | H | [product-reports](product-reports/) |

## Parties & masters

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Customers | `/customers` | A | [customers](customers/) |
| Customer detail | `/customers/:code` | F | [customer-detail](customer-detail/) |
| Vendors | `/vendors` | A | [vendors](vendors/) |
| Vendor detail | `/vendors/:code` | F | [vendor-detail](vendor-detail/) |
| Business masters | `/masters` | A | [masters](masters/) |
| Master record detail | `/masters/:code` | F | [master-detail](master-detail/) |

## HR & payroll

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Employees | `/hr` | A | [employees](employees/) |
| Employee detail | `/hr/employees/:id` | F | [employee-detail](employee-detail/) |
| Attendance | `/hr/attendance` | A | [attendance](attendance/) |
| Attendance entry | `/hr/attendance/entry` | B | [attendance-entry](attendance-entry/) |
| Payroll | `/hr/payroll` | B | [payroll](payroll/) |

## Reports

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Financial statements / reports centre | `/reports` | H | [reports-centre](reports-centre/) |
| Reports & analytics | `/reports/analytics` | I | [reports-analytics](reports-analytics/) |
| Report studio | `/reports/studio` | B | [report-studio](report-studio/) |
| Template library | `/reports/templates` | A | [report-templates](report-templates/) |
| Report output | `/reports/:id` | H | [report-output](report-output/) |

## Administration

| Page | Route | Arch. | Folder |
|---|---|---|---|
| Users | `/admin` | A | [admin-users](admin-users/) |
| User detail | `/admin/users/:id` | F | [user-detail](user-detail/) |
| Roles & permissions | `/admin-roles` | A | [roles-permissions](roles-permissions/) |
| Audit trail | `/admin-audit` | D | [audit-trail](audit-trail/) |
| Settings & control | `/settings` | — | [settings](settings/) |

---

## Redirects and aliases

Not every route in `ui-prototype/src/App.tsx` is a page. These render nothing of their own and so
get no folder — recorded here instead, so the index stays a complete map of every route.

| Route | Target | Why |
|---|---|---|
| `/` | `/dashboard` | The app has no separate landing page; the root path is only ever an entry point, and it lands users on the [dashboard](dashboard/) archetype-I orientation screen. |
| `/finance` | `/accounts` | A short-hand for the accounting module's default screen. It exists so a top-level "Finance" link can be wired without deciding which accounting page is "home" — that decision is made once, here, rather than per-link. Gated by the same `Cash, Bank & GL` permission as its target. |
| `/inventory/movements` | renders `ManualStockEntry` — the same component as `/inventory/stock-in` | Not a `Navigate`; the route mounts the identical component directly, so it is a second URL for one screen rather than a client-side redirect. It is a naming alias left over from before the screen was renamed `stock-in` — both URLs must keep working, and both are documented as one page in [stock-entry](stock-entry/). Do not build a second document for it, and do not let the two URLs' behaviour diverge. |

## Page document template

Copy this into a new `pages/<slug>/README.md`.

```markdown
# <Page name>

| | |
|---|---|
| **Route** | `/route` |
| **Archetype** | <A-I> (+ modifier) |
| **Module / permission** | <module> · <permission key> |
| **Prototype source** | `ui-prototype/src/<file>.tsx` |
| **Reference frame** | `ui-prototype/design/<image>.png` |
| **Posts to the ledger** | yes / no — via which financial event |
| **Owner** | <module owner> |

## 1. Purpose
One paragraph: whose job this is and what they came to do.

## 2. Anatomy
ASCII block of the regions, top to bottom.

## 3. Components
Kit components used, and any page-local component with its justification.

## 4. Data
Columns / fields with alignment, format, priority; KPIs with their period.

## 5. Actions
Each action: label, kind, permission, confirmation, result, disabled reasons.

## 6. States
Anything page-specific beyond 04-states.

## 7. Financial rules on this page
The Level 0 invariants this screen must make visible.

## 8. Responsive · 9. Accessibility · 10. Deviations from the prototype
## 11. Open questions
```
