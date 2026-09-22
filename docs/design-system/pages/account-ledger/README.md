# Account Ledger

| | |
|---|---|
| **Route** | `/ledgers` · record form `/finance/accounts/:code` |
| **Archetype** | D — Ledger / Statement |
| **Module / permission** | Accounting · `Cash, Bank & GL` |
| **Prototype source** | `ui-prototype/src/account-ledger.tsx`, `src/ledger.tsx`, `src/finance-pages.tsx` |
| **Reference frames** | `design/account ledger improved page .png`, `design/account ledger page .png` |
| **Posts to the ledger** | no — it is the canonical **read** surface for postings |

## 1. Purpose

The reference implementation of archetype D and the most-read screen in the product. An accountant
selects an account and a period and reads every posting in date order with a running balance, then
drills into any voucher behind a line.

If any other screen disagrees with this one, this one is right.

## 2. Anatomy

```
Breadcrumbs        Accounting > Ledgers
PageHead           "Account Ledger" · description        [01 Aug 2026 – 31 Aug 2026 v]
                                                         [Saved views v] [Export v] [Open full page]
AccountHeader      icon · Cash in Hand · [Active] · 1110-01 · Asset · Current Asset · Debit
                   description line              | Head Office / Main Book | [Switch account v]
KpiRow (5 + insights)
                   Opening balance · Total debits (n txns) · Total credits (n txns) ·
                   Closing balance · Total transactions   || Account insights panel
Workspace grid  [ rail 290px, stretches to ledger height ]
  Related accounts         LedgerCard: "Ledger Transactions (15)" + sub-line
   search                   search · [Filters n] [Columns] [Sort] [...]
   account rows w/ balance  filter row: Date · Voucher type · Transaction type · Amount ·
   [View all accounts ->]               Reference/Counterparty · Status · More filters
                            applied chips + Save as view
                            LedgerTable
                            footer: showing · page totals · ending balance · rows · pager
```

## 3. Components

`AccountHeader` (page-local, promotion candidate) · `KpiRow` · `LedgerTable` (D2) ·
`FilterBar` + `FilterChip` · `SavedViews` · `DateRangeField` · `AccountPicker` (Switch account) ·
`Panel` (Related accounts, Account insights) · `ExportMenu`.

## 4. Columns

| # | Column | Align | Format | Priority |
|---|---|---|---|---|
| 1 | ☐ | — | selection for export | 4 |
| 2 | # | right | row ordinal within the filtered set | 4 |
| 3 | Date | left | `01 Aug 2026` | 1 |
| 4 | Voucher No. | left | link to the voucher; em dash on the brought-forward row | 1 |
| 5 | Type | left | Journal · Sales · Receipt · Payment · Purchase · Contra | 2 |
| 6 | Particulars / Counterparty | left | narration (700) + 9.5px `To <contra account>` | 1 |
| 7 | Reference | left | external reference (INV-1048, RCV-3821) | 4 |
| 8 | **Debit (Rs)** | right | `--money-debit`; em dash when nil | 1 |
| 9 | **Credit (Rs)** | right | `--money-credit`; em dash when nil | 1 |
| 10 | Running Balance (Rs) | right | `--money-balance`, 700 | 1 |
| 11 | Status | left | Posted `good` · Reversed `danger` · Draft is **excluded by default** | 2 |
| 12 | Actions | right | View voucher · View counterpart · Copy reference | 3 |

Row 1 is always `Balance brought forward` with the sub-line `Dr opening · Debit nature` and no
voucher number.

## 5. KPIs

| KPI | Definition |
|---|---|
| Opening balance | Balance at the start of the selected range, with its Dr/Cr side |
| Total debits | Sum of debit column over the range + transaction count |
| Total credits | Sum of credit column over the range + transaction count |
| Closing balance | Opening ± movements, with side; **must equal the last running balance** |
| Total transactions | Count in the range |
| Account insights | Monthly movement, average transaction, largest debit, largest credit |

If a filter narrows the set such that the closing KPI no longer equals the last visible running
balance, the page shows an `InlineWarning`: *"Filters are applied — the running balance reflects
the filtered set, not the account."* This is the single most dangerous misreading on this screen.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Switch account | select | `Cash, Bank & GL` | no | Reloads for the chosen postable account |
| Date range | control | — | no | URL state |
| Filters | control | — | no | Voucher type, transaction type, amount band, reference, status |
| Save as view | ghost | — | no | Named filter set, per user, optionally shared |
| Export | secondary split | `Reports` | no | CSV / XLSX / PDF of the filtered set with company, account, period, generated-at |
| Open full page | primary | — | no | Chrome-less full-width reading mode |
| Row: View voucher | link | `Cash, Bank & GL` | no | `/vouchers/:id` |

**Nothing on this page mutates a posting.** There is no edit, no delete, no inline status change.

## 7. States

- Empty account: "No postings on 1110-01 in this period." with a period-widen action.
- Filtered empty: clear-filters action, KPIs still show the unfiltered period figures and say so.
- Error: the page keeps the account header and replaces the table with `ErrorState`.
- Large accounts: rows virtualise above 200; the footer still reports true totals from the server,
  never from the loaded page.

## 8. Financial rules on this page

- Debit and credit are **separate columns**; no signed single column, ever.
- The running balance is derived and is rendered in `--money-balance` to say so.
- Opening balance is always present and always labelled.
- Only **posted** entries appear by default; including drafts is an explicit filter and paints the
  running balance column as provisional with a hatched background.
- Page totals are **page** totals and are labelled "Page totals (this page)"; period totals live in
  the KPI row.
- A reversed entry stays visible with `Reversed` status and links to its reversing voucher.

## 9. Responsive

`xl` hides Reference and # · `lg` the Related-accounts rail becomes a `Switch account` dropdown ·
`md` KPI row 2 columns, insights panel collapses to a disclosure · `sm`+ the table scrolls
horizontally with Date sticky — Debit, Credit and Running balance are never dropped.

## 10. Accessibility

`<caption>` names account, code and period. `aria-sort` on Date and Amount. Each money cell carries
an accessible label naming the side. The brought-forward row is a `<th scope="row">`. The
InlineWarning is in an `aria-live="polite"` region so a screen-reader user learns that filters
changed the balance semantics.

## 11. Deviations from the prototype

- The prototype computes balances in the browser from seed journals; production reads server
  figures and never re-sums.
- The prototype's second, differently-styled ledger in `finance-pages.tsx` (`ledger-ref-*`) is a
  duplicate and is **removed** — one ledger surface only.
- Compact density is the default here (prototype uses standard).

## 12. Open questions

1. Does "Open full page" need a distinct route for sharing, or is it a view mode?
2. Cost centre / branch: a column, a filter, or a sub-ledger selector?
3. Do we show the contra account for multi-line vouchers as "Split" with a hover breakdown?
