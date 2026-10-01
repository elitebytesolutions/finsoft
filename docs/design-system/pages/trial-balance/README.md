# Trial Balance

| | |
|---|---|
| **Route** | `/trial-balance` |
| **Archetype** | H — Report |
| **Module / permission** | Accounting · `report.financial` |
| **Prototype source** | none — new for M2. A trial balance already exists as one tab inside the mock `reports-pages.tsx` Reports Centre (`/reports/trial-balance`, `ReportsCentre` / `STATEMENT_SLUGS`); that screen also renders a Profit & Loss and a Balance Sheet, neither of which M2 supports. This page is a separate, standalone route so it can be wired to the real API without waiting on — or faking — the other two statements. The Reports Centre mock is untouched, keeps its prototype banner, and is not this page. |
| **Reference frame** | none |
| **Posts to the ledger** | no — read surface only |
| **Owner** | Accounting |

## API note — M2-UI (visual-language alignment)

No prototype ancestor for this screen (genuinely new in M2), so there was nothing to restore —
but the M2-UI brief asked for it to share "the same page header, table, and totals styling as
the original ledger and cash book," which the M2-S version (generic kit `PageHead`) did not.
Restyled to the `al-head`/`al-crumbs` header and `al-table` (Dr/Cr-toned cells, `vou-total`
footer row) the restored Account Ledger and Voucher Detail screens use, with no behavioural or
data change — same `GET /api/reports/trial-balance` call, same states, same text, so
`trial-balance.test.tsx` needed zero changes.

## API note — M2-S (2026-09-29)

Written directly from `REPORT/trial-balance@1`
([ledger-and-trial-balance.md](../../../posting-rules/ledger-and-trial-balance.md) §3), approved by
the Accounting Guardian 2026-09-27. This is a **new page document for a genuinely missing screen**
(PO decision, relayed by the delivery coordinator): the existing mock Reports Centre bundles Trial
Balance with two unsupported statements, so it is not converted — this is a new, minimal,
real-API-only screen next to it.

**Blocked on the M2-B API contract** for the actual data call: as of this writing, `feature/M2-B-accounting-api`
has not been pushed to `origin` and `docs/design/M2/api-contract.md` does not exist. This document
specifies the target screen from the approved posting rule; the M2-S delivery report states plainly
that the screen itself is not wired yet.

## 1. Purpose

As-of a date, prove the ledger balances: every postable account with activity, its net debit or
credit position, and the two column totals equal to the last decimal place. This is the screen an
accountant opens after posting anything, and the one a close depends on.

## 2. Anatomy

```
PageHead     eyebrow "Accounting / Trial balance" · h1 "Trial Balance" ·
             description · [As of date] [Export]
KpiRow       Total debit · Total credit · Difference (always 0.00 or the page is broken) ·
             Accounts with activity
BalanceStrip "Balanced" (good) or "Out of balance" (danger, should be unreachable in production)
Grid         Code · Account · Debit (PKR) · Credit (PKR)
Footer       Totals row, pinned
```

No filters beyond the as-of date — this report has none in the MVP (no branch, no cost centre, no
account-type filter). Rows are grouped by header account (Assets, Liabilities, Equity, Income,
Expenses) with a header row carrying no monetary value of its own (headers post nothing;
[ledger-and-trial-balance.md](../../../posting-rules/ledger-and-trial-balance.md) §3 says grouping is
presentation and does not change the totals).

## 3. Components

`PageHead` · `Kpi` (×4) · `DateField` (as-of date; reused from whatever the voucher form's date
picker becomes) · `Table` (or `DataGrid`/`LedgerGrid` once those land in `packages/ui` — see §6
below) · `MoneyCell` · `Banner` (balanced/out-of-balance strip; error/empty states).

## 4. Data

| Column | Align | Format |
|---|---|---|
| Code | left | account code, tabular |
| Account | left | account name; header rows in 700 weight |
| Debit (PKR) | right | `MoneyCell`; em dash when the row's debit column is `0.0000` |
| Credit (PKR) | right | `MoneyCell`; em dash when the row's credit column is `0.0000` |

Per account, exactly one of Debit/Credit carries the balance — never both — following the column
rule in §3 of the posting-rules doc:

```
net = Σ debit − Σ credit   (occurred_at ≤ as-of date)
net > 0  → Debit column = net,   Credit column = 0.0000
net < 0  → Debit column = 0.0000, Credit column = |net|
net = 0  → both 0.0000, row still shown — the account had activity
```

**The column follows the sign of the balance, not the account's normal side** — an overdrawn bank
appears in the Credit column. This is the one fact about this screen most likely to be "corrected"
by someone who has not read the rule; it is not a bug when it happens.

Only accounts with **at least one line dated on or before the as-of date** appear — an account with
no activity yet is not a zero row cluttering the report.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| As of date | control | — | no | Re-queries for the chosen date; defaults to today |
| Export | secondary | `report.financial` | no | CSV/XLSX/PDF, same columns as the screen, carrying company/period/generated-at (03-patterns.md §H) |

Nothing on this page mutates a posting — there is no drill-down edit path; a row's account name may
link to `/finance/accounts/:code` for the underlying ledger (read-only, consistent with every other
accounting screen).

## 6. States

- **Loading** — skeleton rows, not a spinner (04-states.md §1).
- **Empty** — a brand-new tenant with no postings yet: *"No activity as of this date. Post a voucher
  or choose a later date."*
- **Error** — *"We could not load the trial balance."* with a retry and a request reference
  (04-states.md §4). Nothing partial is shown — a trial balance that loaded halfway is not a trial
  balance.
- **Forbidden** — a role without `report.financial` sees the standard permission-denied state
  (04-states.md §5), not a blank table. (No real permission list reaches the client yet to hide the
  nav entry proactively — see the shared note on every M2-S page; the 403 → `/unauthorized` redirect
  is the actual gate.)
- **Out of balance** — should be unreachable given Invariant 2, but the UI does not assume it is
  impossible: if the server ever returns unequal totals, the `BalanceStrip` renders `danger` with
  the exact difference and the page does **not** silently "fix" the display by rounding either total
  — that would hide a real defect.
- **Component gap.** `packages/ui` does not yet have a dedicated report grid (`DataGrid`/`LedgerGrid`
  named in this task's kit list do not exist in `packages/ui/src/index.tsx` today — the real exports
  are `Table`, `Kpi`, `PageHead`, `Banner`, etc.). This screen uses the existing `Table` primitive
  until a purpose-built grid is requested from the design-system agent; not requested in this
  increment because the screen itself is not yet wired to data, and requesting a component ahead of
  a proven need is how one-offs get invented instead of design-system components.

## 7. Financial rules on this page

- Balances are **inception-to-date** (one fiscal year, no year-end close yet — inception-to-date and
  year-to-date coincide in M2).
- Both `POSTED` and `REVERSED` entries are included; excluding `REVERSED` while including its
  reversal would double-count the correction (§1 of the posting-rules doc).
- No rounding: every figure is a sum of stored `numeric(19,4)` values, summed at full precision and
  displayed at 2dp; totals are never summed from already-rounded displayed values.
- The client never computes a total, a net or a column assignment — every number on this page is
  exactly what the server returned.

## 8. Responsive

`md` the grid scrolls horizontally with Code/Account sticky · `sm` and below: card list, one card per
account, Debit/Credit labelled inline (mirrors the ledger's `xs` treatment).

## 9. Accessibility

Real table with column headers (`scope="col"`); header (grouping) rows are `<th scope="rowgroup">`;
the `BalanceStrip` text, not colour alone, states balanced/out-of-balance; the as-of date control is
labelled and keyboard-operable.

## 10. Deviations from the prototype

Not applicable — no prototype source (§ table above).

## 11. Open questions

1. Does the as-of date default to today, or to the end of the current open fiscal period?
2. Should a header row's implicit subtotal (sum of its postable descendants) be shown, given
   ledger-and-trial-balance.md §3 treats grouping as presentation-only? If shown, it must be
   server-computed like every other figure here, not summed in the browser.
3. Export formats and whether Export needs its own permission distinct from viewing the report.
