# Application shell — sidebar, top bar, content frame

| | |
|---|---|
| **Route** | Wraps every route |
| **Archetype** | — (shell) |
| **Module / permission** | All · navigation is filtered by the role's module permissions |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Shell`, `renderNodes`), `src/ui.tsx` |
| **Reference frames** | `design/left menu improved .png`, `design/left menu new.png`, `design/left menu border less .png`, `design/header view .png` |
| **Posts to the ledger** | no |

## 1. Purpose

The frame every screen is seen through. It answers three questions permanently: **which company's
books am I in**, **who am I**, and **where can I go**. It is also the only place a user can start a
new document from anywhere.

## 2. Anatomy

```
+- Sidebar 248px ------------+- Main ------------------------------------------+
| brandmark + Finsoft        |  TopBar 72px sticky card                        |
|   Bhatti Traders    [«]    |   brand | CompanyPicker | GlobalSearch (Ctrl K) |
| [ Search anything   ⌘K ]   |         | + Create New v | bell | mail | help |  |
|                            |         | settings | avatar Saim Javed / Admin  |
| [Dashboard] [Today's Work] +-------------------------------------------------+
|                            |  content  28px padding · max 1600px             |
| FINANCE — manage finances  |                                                 |
|  ▸ Accounts                |    <page>                                       |
|      · Chart of Accounts   |                                                 |
|      · Account Ledger      |                                                 |
|      · Cash Book           |                                                 |
|  ▸ Voucher Management      |                                                 |
|  ▸ Bank                    |                                                 |
|  Cash Transactions         |                                                 |
|  Financial Statements      |                                                 |
| SALES & DISTRIBUTION  ...  |                                                 |
| PURCHASE & INVENTORY  ...  |                                                 |
| PARTIES · RECEIVABLES ...  |                                                 |
| HR · REPORTS · SETTINGS    |                                                 |
| [help card]                |                                                 |
| BT  Bhatti Traders / Admin |                                                 |
+----------------------------+-------------------------------------------------+
```

## 3. Components

`AppShell` · `Sidebar` (section tag, module row, leaf link, dot rail, collapse toggle,
user footer) · `TopBar` · `CompanyPicker` · `GlobalSearch` · `CreateNewMenu` ·
`NotificationPopover` · `UserMenu` · `SkipToContent`.

## 4. Navigation model

Three levels only: **section tag** (FINANCE) → **module row** (Accounts) → **leaf** (Cash Book).
No fourth level. A module with a single destination is rendered as a leaf, not an expandable row.

Section order is fixed: Core (Dashboard, Today's Work) · Finance · Sales & Distribution ·
Purchase & Inventory · Parties · Receivables & Payables · HR & Payroll · Reports · Settings.

Rules
- Modules the role cannot open are **not rendered** — never rendered disabled.
- The active leaf gets `--brand-050` fill, `--brand-700` text and a 2px left rail; its parent module
  row stays expanded and is marked active but not filled.
- Expansion state persists per user; the group containing the active route is always open on load.
- Voucher **types** are not navigation items — they are filters on the Voucher Register.
- Collapsed mode (84px) keeps icons and shows the label in a tooltip.

## 5. Top bar

| Element | Behaviour |
|---|---|
| `CompanyPicker` | The tenant indicator. Switching reloads all data and clears page state. Always visible, never hidden by a breakpoint. |
| `GlobalSearch` | `Ctrl/Cmd K`. Searches customers, vendors, products, vouchers, invoices, accounts. Results grouped by type, each row showing code, name and a type chip. Keyboard-navigable, `Enter` opens. |
| `Create New` | Primary gradient split button. Menu is permission-filtered: Sales voucher, Purchase voucher, Journal voucher, Payment/Receipt, Product, Customer, Vendor. |
| Notifications | Badge count; popover lists approvals due, cheques maturing, stock below reorder, period close due. Each row routes; none of them posts. |
| `UserMenu` | Name, role, company, profile, switch role (dev only), sign out. |

## 6. States

Sidebar and top bar render immediately with skeletons for company and counts. If the session
expires, the shell shows a re-authentication modal rather than routing away, so unsaved drafts
survive.

## 7. Financial rules on this page

- The active **company** (tenant) is permanently visible; every request is scoped to it by the
  server, never by anything the shell sends from a header or body field.
- The active **fiscal period** is shown in the page header of every financial screen; when it is
  closed, the shell surfaces the `PeriodLockedBanner` above the content area.

## 8. Responsive

`lg` sidebar auto-collapses · `sm` sidebar becomes an off-canvas drawer with a hamburger in the top
bar · `xs` top bar reduces to brand mark, search icon and avatar. The company picker survives every
breakpoint.

## 9. Accessibility

`banner` / `navigation` / `main` landmarks · skip link is the first tab stop · module rows are
`button` with `aria-expanded` · the active leaf carries `aria-current="page"` · the notification
popover is a focus-trapped `dialog` · `Ctrl/Cmd K` is announced in the search field's label.

## 10. Deviations from the prototype

- The prototype's **role switcher** in the top bar is a demo device. Production uses real
  authentication; role switching exists only in non-production builds.
- The prototype's help card is retained but linked to real documentation.
- Prototype nav items that route to a placeholder (several Distribution and Sales Force leaves point
  at `/field-sales`) must either get a real destination or be removed before release.

## 11. Open questions

1. Does the company picker allow switching between tenants for a user who belongs to several, or is
   a session bound to one tenant? (Security-guardian decision — affects token scope.)
2. Branch/location: is it a second scope selector in the top bar, or a filter on each page?
3. Notification retention and read-state storage.
