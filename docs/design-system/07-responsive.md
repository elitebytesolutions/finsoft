# Responsive & print

FinSoft is **desktop-first**. The design target is a 1440–1920px browser window used all day.
Tablet is supported for review and approval. Phone is supported for a small set of read and
approve journeys only — it is never a posting surface for a multi-line document.

---

## 1. Breakpoints

| Token | Width | Behaviour |
|---|---|---|
| `xxl` | ≥ 1600 | Full layout, content capped at 1600px and centred |
| `xl` | 1400–1599 | KPI rows stay at 4; secondary table columns begin to hide |
| `lg` | 1200–1399 | Sidebar collapses to icons by default; document split becomes 1.6/1 |
| `md` | 900–1199 | Two-column grids become one; `DefinitionGrid` 4 → 2; inspector becomes a drawer |
| `sm` | 700–899 | Sidebar becomes an off-canvas drawer; filter bar collapses into a Filters sheet |
| `xs` | < 700 | Card list replaces tables; entry screens are read-only with a "open on desktop" note |

The prototype uses a long tail of page-specific max-widths (1100/1250/1400/1500…). The production
kit normalises to the six above; a page may add **one** extra breakpoint and must record it in its
page document with the reason.

## 2. Table strategy by breakpoint

1. **Priority columns.** Every column has a priority: `1` identity, `2` primary figures,
   `3` status/date, `4` supporting, `5` audit. Columns drop from priority 5 upward as width falls.
2. **Horizontal scroll** within the table card (never the page) once priority 1–2 no longer fit,
   with the identity column sticky.
3. **Card list** below `xs`: identity + status on the first line, the two key figures on the second,
   date and party on the third, action in an overflow.

A ledger never drops Debit, Credit or Running balance. If they do not fit, the table scrolls.

## 3. Component behaviour

| Component | md | sm | xs |
|---|---|---|---|
| Sidebar | icons only | off-canvas drawer | off-canvas drawer |
| TopBar | tagline, shortcut chip, user name hidden | search becomes an icon | brand mark + search icon + avatar |
| KpiRow | 4 → 2 columns | 2 | 1, horizontally scrollable strip |
| FilterBar | wraps | `Filters` sheet | `Filters` sheet |
| Document split | stacks, totals move below lines | stacks | stacks |
| Inspector | drawer | full-screen sheet | full-screen sheet |
| LineItemGrid | horizontal scroll | read-only summary | read-only summary |
| TotalsBar | sticky bottom | sticky bottom | sticky bottom |

## 4. Touch

Tablet targets are at least 44×44px; row actions expand to 44px in `md` and below. Hover-only
affordances (row action reveal, tooltip) always have a tap equivalent.

## 5. Print

Print is a first-class output — invoices, vouchers, statements and reports are printed daily.

- `@media print` removes shell chrome (sidebar, top bar, filters, actions) and expands the document
  card to the page.
- Every printed page carries: company name and address, document title, document number, period or
  date, page `n of m`, and `Generated on <date time> by <user>`.
- Tables repeat their header row on each printed page (`thead { display: table-header-group }`) and
  avoid breaking a row across pages.
- Money and quantity columns keep their alignment and full precision.
- Colour is not required to read a printed page: statuses print with their text, Dr/Cr with their
  column headers.
- Page size A4 portrait by default, landscape for tables wider than 8 columns.
- `PrintDocument` ([02-components §D12](02-components.md)) is the only sanctioned print layout.
