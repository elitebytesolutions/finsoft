# Foundations

Every value here is a **token**. Components consume tokens; screens consume components.
A raw hex code, px value or shadow in a feature file is a design-system violation.

Source of truth: `packages/ui/src/tokens/*` (to be created in Wave 1), derived from
`ui-prototype/src/styles.css` `:root` and the reference frames in `ui-prototype/design/`.

---

## 1. Colour

### 1.1 Brand & accent

| Token | Value | Use |
|---|---|---|
| `--brand-600` | `#15803D` | Primary action text/icon, active nav text, eyebrow |
| `--brand-500` | `#1D9C52` | Primary button gradient start, positive chart series |
| `--brand-700` | `#14783C` | Primary button gradient end |
| `--brand-800` | `#0A6B36` | Top-bar Create New gradient end, pressed state |
| `--brand-050` | `#E9F7ED` | Active nav background (prototype `--mint`), selected row wash |
| `--brand-100` | `#DCF0E2` | Card borders inside brand-tinted panels |

Primary button fill is the gradient `linear-gradient(135deg, var(--brand-500), var(--brand-700))`
with shadow `0 7px 16px rgba(20,120,60,.25)`. The top-bar create button uses the darker pair
(`#0F8A45` to `#0A6B36`) because it sits on white at a larger size.

### 1.2 Neutrals

| Token | Value | Use |
|---|---|---|
| `--bg-app` | `#F3F7FA` | App canvas behind all cards |
| `--surface` | `#FFFFFF` | Every card, table, sidebar, top bar |
| `--surface-sunken` | `#F9FBFA` | Input fill, table header fill, inline toolbars |
| `--line` | `#E4E9EF` | Standard 1px border and divider |
| `--line-soft` | `#EDF1EF` | Table row divider (lighter than `--line`) |
| `--ink` | `#1E293B` | Primary text, figures |
| `--ink-2` | `#475569` | Secondary text, nav labels |
| `--muted` | `#64748B` | Captions, meta, placeholders |
| `--muted-2` | `#8A9691` | Table cell secondary text, icon rest state |

### 1.3 Financial semantics — fixed meaning, never decorative

| Token | Value | Meaning |
|---|---|---|
| `--money-debit` | `#0F6B3A` on `#E7F3EC` | Debit amount / debit chip |
| `--money-credit` | `#B45309` on `#FFF4DE` | Credit amount / credit chip |
| `--money-balance` | `#2C6C77` | Running / closing balance column |
| `--money-negative` | `#C6535C` | Negative balance, over-limit exposure, adverse variance |
| `--money-zero` | `#8A9691` | The em dash rendering of zero |

Debit is **not** "good" and credit is **not** "bad". These tokens must never be reused for
success/failure, and success/failure tokens must never be used for Dr/Cr.

### 1.4 Status tones

| Tone | Text / Background | Used for |
|---|---|---|
| `good` | `#35915B` / `#E8F7EC` | Posted, Cleared, Active, Completed, Received |
| `warn` | `#AE7724` / `#FFF4DE` | Draft, Pending approval, In clearing, Expiring, Partially paid |
| `danger` | `#C6535C` / `#FEEAEC` | Dishonoured, Void, Cancelled, Overdue, Over limit, Negative stock |
| `info` | `#347282` / `#E8F2F5` | Submitted, Scheduled, Transferred, informational |
| `neutral` | `#6E7A76` / `#F1F4F3` | Unposted, Unknown, Archived, Not applicable |

One status maps to one tone, product-wide. The mapping per page is fixed in that page's document.

### 1.5 Accent wells (KPI / icon tiles)

`green #EAF7EE / #15803D` · `teal #E5F2F4 / #2F7B88` · `blue #EAF0F8 / #547CA9` ·
`yellow #FFF5DF / #C48B2E` · `red #FFF0F1 / #D35F69` · `violet #F1EEFD / #7258B4`.
Rotation order for a KPI row: green, blue, yellow, teal, red, violet.

### 1.6 Dark surfaces

`--hero-band: linear-gradient(120deg,#131A2A 0%,#1B2A44 70%,#21406B 130%)` with
`--hero-eyebrow: #8FB3E8`. Used **only** for the dashboard hero band and the executive summary
strip of a report. Never for a data surface.

### 1.7 Dark mode

Out of scope for MVP. Tokens are defined so a future `[data-theme="dark"]` can remap them;
do not hard-code light values inside components.

---

## 2. Typography

Family: `Inter, "SF Pro Display", "Segoe UI", sans-serif`.
Figures use the same family with `font-variant-numeric: tabular-nums lining-nums` — **always**, in
every table cell, KPI value, total and numeric input.

| Token | Size / weight / tracking | Use |
|---|---|---|
| `--t-page-title` | 27px / 700 / -1px | Page h1 |
| `--t-doc-title` | 22px / 700 / -0.5px | Document number on a detail page, state-page heading |
| `--t-kpi` | 22px / 700 / -0.5px | KPI value |
| `--t-section` | 13px / 700 | Card or panel heading (h2, h3) |
| `--t-body` | 12.5px / 600 | Nav items, form values, buttons in dense bars |
| `--t-body-sm` | 11.5px / 500 | Page description, helper text |
| `--t-table` | 12px / 500 | Table cell |
| `--t-table-strong` | 12px / 700 | The identifying cell of a row (code, document no.) |
| `--t-label` | 10.5px / 600 | Field label, KPI label |
| `--t-caption` | 9.5px / 500 | Meta line, secondary cell text |
| `--t-eyebrow` | 9px / 800 / 1.3px, uppercase | Breadcrumb eyebrow above a page title |
| `--t-th` | 9px / 700 / 0.6px, uppercase | Table column header |
| `--t-badge` | 10px / 700 | Badge, chip, pill |

**Prototype scale note.** `ui-prototype` renders at a compressed scale (table text at 9.8px, badges
at 8.5px) to fit the reference frames. The production kit keeps the ratios but raises the floor:
**table text 12px, badge text 10px, nothing below 10px**.

Line height: 1.45 for prose, 1.2 for figures and single-line cells.

---

## 3. Spacing

4px base. Allowed steps: **2, 4, 7, 9, 13, 14, 18, 22, 28, 36** px (`--sp-0.5` … `--sp-9`).
Nothing between steps.

| Context | Value |
|---|---|
| Card padding | 18px |
| Card-to-card gap in a grid | 14px |
| Section gap (KPI row to main card) | 18px |
| Page content padding | 28px, max width 1600px, centred |
| Table cell padding | 13px vertical / 14px horizontal; 18px on the outer edge |
| Form field gap | 13px |
| Button group gap | 9px |
| Icon-to-label gap | 7px (button) / 11px (nav row) |

---

## 4. Radius

| Token | Value | Use |
|---|---|---|
| `--r-xs` | 7px | kbd, tiny chip |
| `--r-sm` | 9–10px | Input, select, button, icon button, nav row |
| `--r-md` | 12–14px | Toolbar, search field, company picker, icon well |
| `--r-lg` | 17–18px | Card, panel, KPI |
| `--r-xl` | 20px | Top bar, modal, hero band |
| `--r-pill` | 999px | Badge, filter chip |

---

## 5. Elevation

Shadows are soft and green-tinted. A card is defined by its **border**, lifted only slightly by its
shadow.

| Token | Value | Use |
|---|---|---|
| `--e-0` | none | Inline / nested surfaces |
| `--e-1` | `0 6px 22px rgba(31,67,55,.035)` | KPI, panel, card |
| `--e-2` | `0 10px 30px rgba(31,67,55,.06)` | Top bar, sticky headers |
| `--e-3` | `0 18px 50px rgba(27,64,52,.15)` | Popover, dropdown, notification panel |
| `--e-4` | `0 24px 80px rgba(16,45,35,.28)` | Modal / drawer |
| `--e-hero` | `0 16px 40px rgba(19,26,42,.25)` | Dashboard hero band only |

Overlay scrim: `rgba(14,31,26,.48)` with `backdrop-filter: blur(3px)`.

---

## 6. Motion

| Token | Value | Use |
|---|---|---|
| `--m-fast` | 180ms ease | Hover, chevron rotation, chip toggle |
| `--m-base` | 250ms ease | Sidebar collapse, accordion, drawer |
| `--m-lift` | `translateY(-2px)` + `--e-2` | Card / quick-action hover only |

`@media (prefers-reduced-motion: reduce)` disables all transform and transition motion — already
honoured in the prototype and mandatory in the kit. **No motion on a figure**: a number never
animates, counts up or slides in.

---

## 7. Iconography

`lucide-react`, stroke width **1.8** (2.2 on filled primary buttons). Sizes: 13px inline cell,
15px button, 17px nav row, 19px top bar, 18px KPI well.

Fixed icon meanings — do not re-map:
`Landmark` account/bank · `BookOpen` ledger · `ReceiptText` voucher · `FilePlus2` new document ·
`Banknote` cash · `WalletCards` bank book/payment · `ScrollText` cheque/audit ·
`Boxes`/`Layers` stock · `PackageCheck` GRN · `Pill` product · `Users` party/employee ·
`ShieldCheck` approval/permission · `LockKeyhole` locked period or denied access ·
`History` reversal/movement history · `ArrowLeftRight` transfer/contra · `Percent` tax.

Every icon that carries meaning alone gets an `aria-label`; decorative icons get `aria-hidden`.

---

## 8. Layout grid

```
+- sidebar 248px (84px collapsed) -+- main --------------------------------+
|                                  |  top bar  (72px, sticky, r-xl)        |
|  brand + search                  | ------------------------------------- |
|  nav groups                      |  content  28px padding, max 1600px    |
|  help card                       |    page head                          |
|  user footer                     |    KPI row                            |
|                                  |    filter bar                         |
|                                  |    main card(s)                       |
+----------------------------------+---------------------------------------+
```

Standard content column splits:

| Split | Ratio | Use |
|---|---|---|
| Full | `1fr` | Register, catalogue, matrix |
| Document | `minmax(0,1.4fr) / minmax(280px,1fr)` | Line items + totals & ledger impact |
| Workspace | `minmax(290px,330px) / minmax(0,1fr)` | Selector rail + ledger/detail |
| Split-inspector | `minmax(0,1fr) / minmax(380px,420px)` | Register list + detail inspector |
| Halves | `1fr 1fr` | Two peer panels |

KPI rows are `repeat(4,1fr)`; `.mini` is 3; statements use 5–6. Gap 14px.

---

## 9. Density modes

| Mode | Row height | Default on |
|---|---|---|
| Comfortable | 52px | Detail pages, low-volume lists |
| **Standard** | 44px | Everything (default) |
| Compact | 36px | Ledger, trial balance, movement history, reconciliation |

Density is a per-user preference offered in the table's Columns/View menu. It never changes the
column set, alignment or formatting.
