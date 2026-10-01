# Chart of Accounts

> **Updated — M2-UI restoration.** The PO rejected the M2-S screens for abandoning the original
> design ("the ui is shit why does not it look like the demo screens i provided"). This screen
> was restored to the original `8c5c283` markup/layout (search, view toggle, KPI row, bulk
> toolbar, hierarchy map, pagination) wired to the real API via
> `apps/web/src/lib/adapters/chart-of-accounts.ts`. §2, §6 and §11 below (written for the M2-S
> read-only rewrite) are superseded by §2a/§6a. The chart is **still read-only server-side** —
> `coa-standard.md` §5 has not changed — but the PO now wants account creation in the MVP, so
> Add/Edit/Move/Activate/Deactivate/Delete/Import are back in the DOM, gated behind
> `ACCOUNT_CREATE_ENABLED` (`apps/web/src/lib/feature-flags.ts`, off by default) rather than
> removed, so the affordance is ready the moment the M2-C accounts-write API lands (in progress
> at time of writing — the coordinator is wiring the flag once it merges).

| | |
|---|---|
| **Route** | `/accounts` |
| **Archetype** | E — Tree / Hierarchy |
| **Module / permission** | Accounting · read: no dedicated permission code exists in the MVP RBAC catalogue (`packages/permissions/src/catalog.ts`) — every authenticated tenant member can read the chart. Confirm against the M2-B contract before build; if it turns out to be gated, the likely code is `voucher.view` (the closest real code), not `master:create`/`Cash, Bank & GL`, which do not exist in `PERMISSION_CODES` |
| **Prototype source** | `apps/web/src/screens/chart-of-accounts.tsx` (`ChartOfAccounts`) — mock-data version, being converted in place per M2-S |
| **Reference frames** | `design/chart of accounts improved.png`, `design/chart of accounts page .png` |
| **Posts to the ledger** | no — but it defines what everything else may post to |
| **Backed by (M2)** | `docs/posting-rules/coa-standard.md` — no `docs/design/M2/api-contract.md` published yet at time of writing (M2-B has not pushed). Endpoint shapes below are therefore **not fixed** and must be checked against the contract before wiring |

## 1. Purpose

The accountant reads the account structure here — every posting surface in the product picks
accounts from it. **In the M2 MVP this page is read-only.** `coa-standard.md` §5 states it
plainly: *"The MVP ships the chart read-only to users; create, rename and deactivate are Wave 2
remainder work, each audited."* There is no `POST /accounts` (or equivalent) in this wave.

This is a change from the page's original aspiration and from this delivery brief's own framing
("view the tree, add an account") — the "add an account" outcome **cannot be built against a real
endpoint in M2** because no such endpoint exists or is planned for this wave. See §6.

## 2. Anatomy (M2)

```
PageHead     icon · "Chart of Accounts" · description · [search]
KpiRow (5)   Total assets · liabilities · equity · income · expenses
             (aggregated, server-computed — the client never sums journal lines)
TreeTable    Account name · Code · Type · Normal balance (Dr/Cr) · Parent account ·
             Balance (PKR) · Status · Actions (View ledger only)
Footer       Showing 1-25 of <n> accounts · pager
```

Removed from the pre-M2 anatomy for this wave, because none of it is backed by a real capability:
`Hierarchy map` view toggle, `Import`/`Export`, `+ Add Account`, `BulkBar`, row-level `Add
sub-account` / `Edit` / `Move` / `Activate`/`Deactivate` / `Delete`, `Change` sparkline column,
`Last modified` column (no such field is specified), selection checkboxes. Every one of these
either requires a mutation the MVP does not offer, or a figure (day-over-day change, last-modified
actor) no posting rule computes.

### 2a. Anatomy (M2-UI restoration — current)

```
Head         icon · "Chart of Accounts" · description · search · Table/Map toggle ·
             category filter · Import/Export · + Add Account (disabled)
Banner       "Adding, editing, moving and deactivating accounts is not available yet..."
             (shown while ACCOUNT_CREATE_ENABLED is off)
KpiRow (n)   Total <root account>... for every real level-1 account in this tenant's chart,
             plus Total Accounts — server-computed rollups (adaptChartOfAccounts's `rollup()`,
             Money.sum over trial-balance lines, never journals)
BulkToolbar  select-all · Edit/Move/Activate/Deactivate/Delete (disabled) · type/status/level
             filters (real, client-side — the whole chart is one bounded GET, not paginated) ·
             density toggle
TreeTable    Account name · Code · Type (Header/Group/Postable, from real `kind` + depth) ·
             Parent account · Sub-accounts · Balance (PKR, Dr/Cr) · Change (—, not fabricated) ·
             Last Modified (—, not tracked) · Status · Actions (ellipsis → ledger, for
             postable; delete dialog, disabled, for others)
Map view     Same hierarchy, card layout — unchanged from the restored design
Footer       Showing n–m of <total> accounts · rows-per-page · pager
```

`Change` and `Last Modified` render as em dashes, not the mock's hash-derived fake percentage and
fake author/date — see CLAUDE.md's "never fake data." They stay as columns (not deleted) so the
table's grid layout matches the original design pixel-for-pixel.

## 3. Components

`Table` (kit) for now, or a promoted `TreeTable` once `packages/ui` grows one — see
`docs/design-system/02-components.md` for what exists today. `KpiRow`. `Badge` for level/status.
No `Modal`, `BulkActionBar`, `ConfirmDialog` or `TreeMap` — nothing on this page opens a form.

## 4. The hierarchy — four levels, fixed (`coa-standard.md` §1–2)

| Level | `kind` | Example | Postable |
|---|---|---|---|
| 1 | HEADER | Assets (1000) | no |
| 2–3 | HEADER | Current Assets (1100), Cash Accounts (1110) | no |
| 4 | POSTABLE | Cash in Hand (1110-01) | **yes** |

Nineteen postable accounts, six headers, seeded once per tenant at provisioning (`COA/standard-v1`,
`coa-standard.md` §2). Only `POSTABLE` accounts appear in any picker or voucher-entry surface.
`type` (ASSET/LIABILITY/EQUITY/INCOME/EXPENSE) and `normal` (Dr/Cr) are fixed by the template and
are **not editable** in the MVP (nothing is).

## 5. Columns

| Column | Align | Format | Priority |
|---|---|---|---|
| Account name | left | icon well + name; indent rails per level | 1 |
| Code | left | tabular | 1 |
| Type | left | ASSET/LIABILITY/EQUITY/INCOME/EXPENSE chip | 2 |
| Normal balance | left | Dr / Cr chip — presentation only, never blocks a posting (`coa-standard.md` §2) | 3 |
| Parent account | left | `Name (code)` or em dash at root | 4 |
| Balance (PKR) | right | `MoneyCell`; server-computed, inception-to-date, the same arithmetic `ledger-and-trial-balance.md` §3 uses; a header row shows the aggregate of its descendants | 2 |
| Status | left | Active `good` / Inactive `neutral` | 3 |
| Actions | right | **View ledger** only — links to `/finance/accounts/:code` | 1 |

## 6. Actions

| Action | Kind | Available in M2 | Notes |
|---|---|---|---|
| View ledger | row link | **yes** | `/finance/accounts/<code>` |
| Search | control | yes, if the list endpoint takes a query param — otherwise client-side search over an already-paginated page is a performance violation and must not be added | filters the loaded page only if the API doesn't support `?q=` — confirm with the contract |
| Add account | primary button | **no — disabled**, tooltip "Adding accounts isn't available yet. The chart is fixed for this release." | `coa-standard.md` §5: Wave 2 remainder work |
| Add sub-account, Edit, Move, Activate/Deactivate, Delete, Import, Export | row / bulk | **no — not rendered** | same reason; there is nothing to disable-with-tooltip because the whole affordance (row selection, bulk bar) has no purpose with zero available mutations |

Per the mid-task correction: don't fake any of these with mock data. They are removed, not
greyed-out placeholders wired to nothing.

### 6a. Actions (M2-UI restoration — current)

| Action | Kind | Available | Notes |
|---|---|---|---|
| View ledger | row action (postable rows) | **yes** | `/ledgers?account=<code>` |
| Search / category / type / status / level filters | control | **yes** | client-side over the fully-loaded chart (`GET /accounts` returns the whole chart, not a page of it — this is not the "filter server data in the browser" anti-pattern) |
| Export | button | **yes** | client-side CSV of the currently-loaded, already-filtered rows |
| Add Account, Edit, Move, Activate, Deactivate, Delete, Import | button | **present, `disabled`, tooltip "Coming soon"** | restored per the PO's brief; wired the moment `ACCOUNT_CREATE_ENABLED` flips true behind a real accounts-write API (M2-C, in progress) |

The Add-account form's fields, for the M2-C spec (from the restored `MasterModal` /
`master-form.tsx`, unchanged since it is not API-driven): Record type, Record name (required),
City, Contact / NTN / account no., Balance type (Debit/Credit/—), Opening balance (PKR), Chart
level (1–4), Parent account. Code is server/sequence-assigned, never user-entered.

## 7. States

- **Loading:** skeleton rows in the tree shape (header rows collapsed), not a spinner over a blank
  page.
- **Empty (should not occur in practice — every tenant is seeded with the template at creation,
  `coa-standard.md` §6):** "No accounts yet" with no "Build from scratch" CTA (there is nothing to
  build with, per §6 above).
- **Error:** page-level `ErrorState` naming what failed, with retry.
- **Partial:** if headers loaded but a branch's balance fetch failed, that branch's balance cell
  shows an inline retry, not a page error.
- **Forbidden:** if the endpoint does turn out to be permission-gated and the caller lacks it, the
  global 403 → `/unauthorized` contract handles it (`apps/web/src/lib/api/client.ts`); no local
  "forbidden" state is needed on this page beyond that.

## 8. Financial rules on this page

- Four-level structure is fixed; only level 4 is postable (`coa-standard.md` §2).
- The chart is **read-only** for the whole MVP — this is not a UI restriction layered over a
  capable API, it is the actual shape of the system this wave.
- Balances shown are server-computed from the ledger; the client never sums journal lines.
- Normal balance side is shown for information; it never blocks or colours a posting
  (`coa-standard.md` §2, "Normal balance never blocks a posting").
- Account codes, types and control kind are permanent once a posting exists on the account
  (`coa-standard.md` §5) — moot in M2 since nothing can edit them anyway, but worth stating because
  it is the reason create/rename/deactivate are hard, not merely deferred for scheduling reasons.

## 9. Responsive

`lg` hides Parent account · `md` the tree collapses to name + code + balance + status with
horizontal scroll · `xs` card list, hierarchy navigated one level at a time.

## 10. Accessibility

Tree rows use `role="treegrid"` with `aria-level` and `aria-expanded`; indent rails are decorative
(`aria-hidden`); every money cell carries an accessible label naming the account.

## 11. Deviations from the prototype

- **Superseded by the M2-UI restoration.** The screen now matches the prototype's markup/layout
  (search, hierarchy map, KPI row, bulk toolbar, pagination) almost exactly — see §2a/§6a. The
  two real deviations that remain:
  - Every balance is server-computed (`adaptChartOfAccounts`'s `rollup()`, summing already-
    computed trial-balance lines with `Money`) — never a client-side journal sum, unlike the
    prototype's own `valueOfTree`/`netOf`.
  - `Change` (sparkline) and `Last modified` render as em dashes — no posting rule produces
    either figure — instead of the prototype's hash-derived fake values. The columns themselves
    are kept (not dropped) to preserve the table's fixed grid layout.

## 12. Open questions

1. Confirmed answer, recorded here rather than left open: account **creation is out of scope for
   M2** (`coa-standard.md` §5). This closes what was open question 1 in the previous version of
   this document.
2. What permission code (if any) gates `GET /accounts` and `GET /accounts/:code`? Not yet in the
   M2-B contract.
3. Does the list endpoint paginate/support search server-side, or does it return the whole
   (small, ~25-row) chart in one call? At MVP volumes the whole chart is plausible, but "no
   unbounded lists" (CLAUDE.md) means this must be confirmed, not assumed.
4. Do we support branch/cost-centre balances at all in M2? Not mentioned in any posting rule —
   assume **no** until the contract says otherwise.
