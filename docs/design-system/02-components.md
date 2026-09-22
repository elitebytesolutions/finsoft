# The Financial UI Kit — component catalogue

Everything here lives in `packages/ui`. Feature code imports; it never copies, forks or re-styles.
If a page needs something that is not here, the page doc records it under *Page-local components*
and the `design-system` agent decides whether it is promoted.

Prototype ancestor for the primitives: `ui-prototype/src/ui.tsx`
(`Button`, `Badge`, `PageHead`, `Kpi`, `Panel`, `SearchField`, `Modal`, `Table`).
The kit is that set, hardened and extended.

---

## A. Shell

### A1 `AppShell`
Two-column grid: `Sidebar` (248px, 84px collapsed) + `main`. Collapse state persists per user.

### A2 `Sidebar`
Brand block, command search (`Ctrl/Cmd K`), section tags, module rows, leaf links, footer user row.

- **Section tag** — uppercase 9px label with a right-hand hint ("FINANCE — Manage your finances").
- **Module row** — 42px, icon well + label + description + chevron; expands to a `nav-sub` group.
- **Leaf link** — icon + label; active state is `--brand-050` background, `--brand-700` text and a
  2px left rail; a dot rail connects children to their module.
- Collapsed mode: icons only, labels and descriptions hidden, tooltip on hover.
- Permission-aware: a module the role cannot open is **not rendered** (never rendered-disabled).

Reference: `ui-prototype/design/left menu improved .png`, `left menu new.png`.

### A3 `TopBar`
72px sticky white card with 20px radius: brand, `CompanyPicker`, `GlobalSearch` (with `Ctrl K`
affordance), then right cluster — `CreateNewMenu` (primary gradient), notifications, messages,
help, settings, `UserMenu` with role/avatar.

The **company picker is the tenant indicator** and is always visible.
Below 1280px the brand tagline, the search shortcut chip, the create-button label and the user
name collapse; nothing else moves.

Reference: `ui-prototype/design/header view .png`.

### A4 `PageHead`
`eyebrow` (breadcrumb, e.g. `Accounting / Receivables`) → `h1` → one-sentence `description`,
with a right-aligned `actions` slot. Action order, right to left: **primary, secondary, overflow**.
Maximum one primary per page.

### A5 `Breadcrumbs`
Used where the eyebrow is not enough (record pages three levels deep). Last crumb is the current
record and is not a link.

---

## B. Primitives

### B1 `Button`
Kinds: `primary` (gradient, one per surface) · `secondary` (white, `--line` border) ·
`ghost` · `danger` (`#FFF0F1` / `#C74E59`) · `split` (primary + caret for related actions).
Min height 37px, radius 10px, 15px icon, 7px gap.

States: rest, hover, active, focus-visible (3px `rgba(62,173,114,.24)` ring, 2px offset),
**disabled**, **busy** (spinner replaces the leading icon, label unchanged, pointer-events off).

A disabled button must carry a `title`/tooltip saying **why** it is disabled — permission, period
locked, unbalanced entry, nothing selected.

### B2 `IconButton`
34px square (44px round in the top bar), 17px icon. `aria-label` is required.

### B3 `Badge`
Pill, tones from [01-foundations §1.4](01-foundations.md). Text only — no icon-only badges.
`StatusBadge` is a thin wrapper that maps a domain status to a tone via one shared map, so
"Posted" is the same green on every screen.

### B4 `Chip` / `FilterChip`
Removable applied-filter token ("Date: This Month ×") plus a `Clear all` ghost link.

### B5 `Tabs`
Underlined tabs, 2px `--brand-600` indicator. Tabs switch a **view of the same record set**;
they never navigate to a different resource and never carry unsaved form state across.

### B6 `SegmentedControl`
Two to four mutually exclusive view modes (Table view / Hierarchy map; Dr / Cr).

### B7 `Tooltip`, `Popover`, `DropdownMenu`
`--e-3`, 16px radius. Dropdown items are left-aligned, destructive items are last and `danger`.

### B8 `Avatar`, `UserCell`
Initials on `#DFF2E6` / `#0F8A45`. `UserCell` is avatar + name + role, used in audit and activity
lists.

---

## C. Data entry

### C1 `Field`
Label (10.5px/600) → control → helper or error. Required marker is a red asterisk after the label.
Error state: `--money-negative` border and message; the message replaces the helper, never stacks.

### C2 `TextInput`, `Select`, `DateField`, `DateRangeField`, `Textarea`
35px (dense) / 40px (form) height, radius 9px, `--surface-sunken` fill, `--line` border.
`DateRangeField` shows `01 Aug 2026 – 31 Aug 2026` with a calendar icon and preset list
(This month, Last month, This quarter, FY to date, Custom).

### C3 `MoneyInput`
Right-aligned, tabular figures, currency prefix shown as a static adornment, decimal places fixed
by the currency. **Bound to a decimal type end to end** — the component emits a string, never a JS
`number`, in line with [ADR-0011](../adr/ADR-0011-money-representation.md).

### C4 `QuantityInput`
Right-aligned, unit-of-measure adornment, step respects the product's pack size.

### C5 `AccountPicker`
Typeahead over the chart of accounts showing `code — name` with the account type chip.
**Only level-4 postable accounts are selectable**; headers and groups appear as disabled group
labels. Recent accounts appear first.

### C6 `PartyPicker`, `ProductPicker`
Typeahead with secondary line (party: city and balance; product: pack, batch, available stock).
`ProductPicker` surfaces FEFO batch and expiry in the option row.

### C7 `LineItemGrid`
The workhorse of every entry screen. Row number, per-column editors, per-row delete, `Add row`,
`Clear all items`, keyboard column traversal (Tab / Shift-Tab, Enter adds a row from the last cell),
and a sticky totals footer.

Rules: computed columns (gross, net, amount) are **read-only, filled, right-aligned**; entering a
product auto-fills pack, batch, rate and tax and says so in an inline hint; the grid is virtualised
above 200 rows.

### C8 `DrCrGrid`
The accounting variant of C7: Account, Particulars/Narration, Cost centre, Debit, Credit.
Shows live **Total Dr / Total Cr / Difference**; the post action is disabled while the difference is
non-zero, and the difference is shown in `--money-negative` until it reaches zero.
The grid never computes a balancing line automatically.

### C9 `FormSection`
Titled card with an icon well grouping related fields (`Order & Customer Information`,
`Bank & Posting Information`). Two-column `form-grid` by default, one column below 900px.

### C10 `Stepper`
Numbered steps with title and subtitle for multi-step entry (purchase voucher, party creation).
Step state: done, current, upcoming. Steps are navigable backwards; forward only when valid.

---

## D. Data display

### D1 `DataTable`
The single table component. Features, all optional and declared per page:

sticky header · sticky first column · column sort · column show/hide (`Columns` menu) ·
row selection with a bulk action bar · row hover · expandable rows · row actions overflow ·
per-page footer totals · pagination with rows-per-page · density · CSV export · virtualised body.

Fixed rules:
- Header: uppercase 9px, `--surface-sunken` fill, top and bottom `--line` border.
- Cell: 12px, `--line-soft` bottom border, 13/14px padding; the identifying cell is 700 weight.
- A cell may carry a 9.5px secondary line (`--muted-2`) beneath its primary value.
- Numeric columns: right-aligned, tabular. Text columns: left. **Nothing is centred except icons.**
- Zero renders as an em dash in `--money-zero`, not `0.00`, in ledger and movement tables.
- Every row that represents a record links to that record from its identifying cell.
- The footer states `Showing 1–25 of 412` on the left and page totals on the right.

### D2 `LedgerTable`
`DataTable` preset for postings: `# · Date · Voucher No. · Type · Particulars / Counterparty ·
Reference · Debit (Rs) · Credit (Rs) · Running Balance (Rs) · Status · Actions`.
Opening balance is row zero, labelled `Balance brought forward`; the footer carries page totals and
the ending balance. Running balance uses `--money-balance`.

### D3 `TreeTable`
Hierarchical accounts and classifications: expand/collapse chevrons, indent rails, level chips
(Header / Group / Postable), aggregated balances on header rows, and a companion `Hierarchy map`
view mode.

### D4 `KpiCard` / `KpiRow`
Label + icon well + value + delta ("+12% vs last period") and an optional sparkline.
A KPI is a **figure with a period**; if the period is not obvious from the page filter, the card
states it. Deltas use `good`/`danger` tones, never Dr/Cr tokens.

### D5 `Panel`
Titled white card: `h3` + optional sub-line + right action slot + body.

### D6 `DefinitionGrid`
Read-only label/value pairs for document headers and record summaries (4 columns desktop,
2 at 1100px, 1 at 700px). This is how a **posted** document shows its fields — never inputs.

### D7 `TotalsCard`
Subtotal, discount, tax, grand total, amount in words. Grand total is the only 22px figure.
Always the last card in the document column or a sticky bottom bar on entry screens.

### D8 `LedgerImpactCard`
The journal a document produced: account, particulars, debit, credit, plus a "View in journal" link
and the posting status. Present on **every** document that posts. If the document is a draft, the
card shows the *preview* of the entry it will produce, clearly labelled `Preview — not yet posted`.

### D9 `Timeline`
Chronological activity (created, edited, posted, approved, reversed) with actor, timestamp and
detail. Fed by the audit record, read-only, append-only in appearance as well as in storage.

### D10 `AttachmentList`
File name, size, uploaded-by, uploaded-at, download. Upload only on drafts.

### D11 `Charts`
Recharts. Area for trend, donut for composition, bar for comparison. Rules: maximum 6 series,
tokens only for colour, currency axis abbreviated but tooltips exact, always a legend, never a
chart without the table or figure it summarises being reachable in one click.

### D12 `PrintDocument`
Print-only layout: letterhead, company block, document title, period, party block, line table,
totals, amount in words, signature strip, `Generated on` footer. Driven by `@media print`.

---

## E. Overlays

### E1 `Modal`
Centred, `min(520px, 100%)`, radius 20px, scrim + blur. Focus is trapped and restored, `Esc`
closes, the heading is `aria-labelledby`. Used for create forms, confirmations and pickers.
`wide` variant for line-item forms.

### E2 `Drawer`
Right-side panel for record inspectors and filter builders. Same focus rules as the modal.

### E3 `ConfirmDialog`
Required for post, reverse, void, delete and period close. Contents: what will happen, the figures
involved, the period affected, the irreversibility sentence, and a typed confirmation for the
highest-risk actions (period close, master delete).

### E4 `Toast`
Bottom-right, 5s, with an action link ("View voucher JV-2026-0419"). Success toasts state the
**document number** produced. Errors do not auto-dismiss.

---

## F. Feedback & state

`Skeleton` (never a bare spinner on a data surface) · `EmptyState` (icon well, heading, one
sentence, one action) · `ErrorState` (with a support reference id) · `PermissionState` (lock icon,
role named, no retry) · `PeriodLockedBanner` · `StaleDataBanner` · `InlineWarning` ·
`FormErrorSummary` (top of form, links to first invalid field).

See [04-states.md](04-states.md) for the copy and behaviour of each.

---

## G. Financial-specific components

### G1 `DrCrAmount`
Renders an amount in the correct Dr/Cr column with the right token. The only sanctioned way to
render a posting amount.

### G2 `BalanceChip`
Balance + `Dr`/`Cr` suffix chip — used wherever a single-column balance must state its side.

### G3 `PeriodSelector`
Fiscal period picker showing status (Open / Closed / Locked). Selecting a closed period puts every
posting affordance on the page into its locked state.

### G4 `PostingStatusStrip`
Draft → Submitted → Posted → (Reversed / Cancelled) progress strip on document pages.

### G5 `IdempotencyGuard`
Wrapper for submit buttons that issues a client key per form instance, disables on submit and
reuses the key on retry, so three clicks produce one journal entry.

### G6 `AuditStamp`
`Created by X on D · Posted by Y on D · Reversed by Z on D`. Present on every posting document.

### G7 `AiSuggestion`
A suggestion chip with a sparkle marker, an `Accept` action and a `Why?` disclosure.
It cannot submit a form and cannot be the default value of a posting field.
