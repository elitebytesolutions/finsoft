# Page archetypes

Nine archetypes cover every screen in FinSoft. A page document names exactly one archetype (or one
archetype plus one named modifier) and then only records its deviations.

| # | Archetype | Job | Example pages |
|---|---|---|---|
| A | **Register / List** | Find and act on many records of one type | Voucher Register, Purchases, Customers |
| B | **Document Entry** | Create a financial document | Sales Voucher, Purchase Voucher, New Voucher |
| C | **Document Detail** | Read, approve, post, reverse one document | Voucher detail, Purchase detail, Sale detail |
| D | **Ledger / Statement** | Read postings in order with a running balance | Account Ledger, Cash Book, Bank Book |
| E | **Tree / Hierarchy** | Maintain a structured master | Chart of Accounts, Product Classes |
| F | **Master Record** | One party/product/employee and everything about it | Customer detail, Product detail |
| G | **Workbench** | A queue of items to clear today | Approval Queue, Cheque Clearing, Today's Tasks |
| H | **Report** | Configure, run, read and export an output | Financial Statements, Report Output |
| I | **Dashboard** | Orient and route | Executive Dashboard, Reports & Analytics |

Shared to all: `AppShell`, `TopBar`, `PageHead`, a visible tenant and period, and the full state set
from [04-states](04-states.md).

---

## A. Register / List

```
PageHead ........................... eyebrow · h1 · description · [Export] [+ New]
KpiRow ............................. 4 KPIs scoped to the current filter
FilterBar .......................... search · date range · 3-5 selects · Filters(n) · Columns · Sort
AppliedChips ....................... removable chips + Clear all
DataTable .......................... sticky header, selection, row actions
TableFooter ........................ Showing x-y of n · page totals · rows-per-page · pager
```

Rules
- KPIs recompute with the filters. If they do not, they say so ("All periods").
- Search is debounced 250ms, searches the identifying columns, and is reflected in the URL.
- Every filter, sort, page and column set is URL state, so a screen is shareable.
- Bulk selection reveals a bulk action bar in place of the filter bar; destructive bulk actions are
  last and confirm with a count.
- Row click opens the record; row actions never post without confirmation.
- `Export` exports **what is on screen** — the same filters, the same columns, plus company and
  period in the file header.

Reference frames: `voucher register improved page .png`, `purchases register page .png`,
`customer listings page .png`.

### Modifier A1 — Split-inspector register
Right-hand inspector (380–420px) previews the selected row: header, tabs (Overview, Ledger
Entries, Activity, Approvals, Related), and the primary action. The list stays interactive.
Used where users triage many documents (Voucher Register, Cheque Posting).

### Modifier A2 — Grouped register
Rows grouped under date or status headers with a count and a running group total, on a left rail.

---

## B. Document Entry

```
DocHeadBar ......................... icon · title · description · [Save draft] [Save & post] [Print] [More]
DocNumberStrip ..................... doc no · date · reference nos · bill book (read-only tiles)
FormSection(s) ..................... party/order info | fulfilment/posting info  (2 columns)
LineItemGrid ....................... the items or the Dr/Cr lines
TotalsBar .......................... sticky footer: counts, gross, discount, tax, NET (emphasised)
LedgerImpactCard ................... preview of the journal this will post
```

Rules
- **Draft first.** `Save draft` is always available; `Save & post` is the only primary.
- `Save & post` is disabled, with a reason, when: the entry is unbalanced, a required field is
  empty, the date falls in a closed period, stock would go negative, or the role lacks the action.
- Validation is inline per field plus a `FormErrorSummary` at the top on submit.
- Navigating away with unsaved changes prompts.
- Posting flow: confirm dialog → busy button → toast with the document number → route to the
  document detail page (archetype C). The entry form is never left in a half-posted state.
- Document numbers are **server-issued** and shown read-only as `Auto` until saved.

Reference frames: `sales voucher page .png`, `purchase voucher detail page.png`,
`voucher-creation-page.png`, `single entry voucher .png`, `bulk entry voucher .png`.

---

## C. Document Detail

```
Breadcrumbs
DocHeader .......................... doc no (h1) · StatusBadge · party · amount · [Reverse] [Print] [More]
PostingStatusStrip ................. Draft > Submitted > Posted > Reversed
DefinitionGrid ..................... all header fields, read-only
LineItemTable ...................... read-only lines
TotalsCard ......................... subtotal, tax, total, amount in words
LedgerImpactCard ................... the actual journal, linked
AuditStamp + Timeline + Attachments
```

Rules
- A posted document shows **no inputs at all**.
- `Reverse` opens a confirm dialog that states the reversing entry's date and period and creates a
  new document; it never mutates this one.
- A cancelled or reversed document keeps its data and gains a banner linking to its counterpart.
- Everything on the page is printable via the `PrintDocument` layout.

---

## D. Ledger / Statement

```
PageHead ........................... eyebrow · h1 · [date range] [Saved views] [Export] [Open full page]
AccountHeader ...................... account name · code · type · nature · status · branch · Switch account
KpiRow ............................. Opening · Total debits · Total credits · Closing · Transactions (+ Insights)
Workspace grid ..................... [ Related accounts rail ] [ Ledger card ]
  LedgerCard ....................... title + count · search · Filters · Columns · Sort · applied chips
                                     LedgerTable
                                     footer: showing · page totals · ending balance · pager
```

Rules
- Opening balance is always the first row and always labelled.
- Debit and credit are separate columns; running balance is last and in `--money-balance`.
- Closing balance in the KPI row must equal the last running balance on the last page — if a filter
  makes that untrue, the page says so in an `InlineWarning`.
- Date range, account and status are URL state; `Saved views` persists a named combination.
- Compact density by default.

Reference frame: `account ledger improved page .png`.

---

## E. Tree / Hierarchy

```
PageHead ........................... icon · h1 · description · search · [Table view | Hierarchy map] · [Import] [Export] [+ Add]
KpiRow ............................. one KPI per top-level class + a count
BulkBar ............................ n selected · Edit · Move · Activate · Deactivate · Delete · More
TreeTable .......................... name+description · code · type chip · parent · children · balance · change · modified · status · actions
Footer ............................. showing · rows per page · pager
```

Rules
- Four levels: Primary → Subtype → Group → Postable. Only level 4 is selectable for posting.
- Header rows show **aggregated** balances and are visually distinct from postable rows.
- Delete is blocked, with the reason stated, when the node has children or any posting exists on it
  or its descendants. The block is explained in the dialog, not hidden behind a disabled button.
- `Add sub-account` always creates the next level down from the selected node.

Reference frame: `chart of accounts improved.png`.

---

## F. Master Record

```
Breadcrumbs
RecordHeader ....................... avatar/icon · name (h1) · code · StatusBadge · [Edit] [More]
KpiRow ............................. balance, exposure, activity figures for this record
Tabs ............................... Overview · Ledger · Documents · Related · Settings · Activity
TabBody ............................ DefinitionGrid + DataTables scoped to this record
```

Rules
- Editing a master opens a modal or a dedicated edit route; the record page itself is read-only.
- Ledger and document tabs are the same `LedgerTable`/`DataTable` with the record pre-filtered.
- A master that has postings can be **deactivated**, never deleted.

---

## G. Workbench

```
PageHead ........................... eyebrow · h1 · description · [Refresh] [Settings]
KpiRow ............................. what is waiting, by bucket
Queue panels ....................... one panel per work type, each a small table with a row action
Side rail .......................... calendar, agenda, quick actions, calculators
```

Rules
- Every row has exactly one obvious next action, and that action confirms if it posts.
- Counts in the KPI row equal the rows in the panels; a mismatch is a defect.
- The page refreshes on focus and shows `Updated HH:MM`.

Reference frame: `todays task page .png`.

---

## H. Report

```
PageHead ........................... eyebrow · h1 · description · search · [Generate] [Export] [Templates]
KpiRow ............................. headline figures of the last run
ReportPicker ....................... cards for each report type
Grid ............................... [ Settings panel ] [ Output viewer ]
  Settings ......................... type · date range · comparison · method · format · advanced
  Output ........................... paged preview with zoom, download, print, export-as
RecentRuns ......................... list with format chips
```

Rules
- Output always carries company, period, accounting method and generated-at.
- Figures in a report are never abbreviated.
- Export formats: PDF, XLSX, CSV. CSV carries the same columns as the screen.
- A report that is slow runs asynchronously and tells the user where the result will appear.

Reference frame: `improved financial statements page .png`.

---

## I. Dashboard

```
HeroBand ........................... dark navy greeting, period, 2 actions
KpiRow ............................. 4 headline KPIs
QuickActions ....................... 6 routed tiles, permission-filtered
Grid ............................... [ trend chart ] [ composition donut + health list ]
Lower grid ......................... attention list · recent documents
```

Rules
- No posting from a dashboard. Every tile routes to the screen that posts.
- Every figure states its period and links to the underlying list or ledger.
- The hero band is the only dark surface.
