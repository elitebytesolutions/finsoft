# Account detail (ledger permalink)

| | |
|---|---|
| **Route** | `/finance/accounts/:code` |
| **Archetype** | D — Ledger / Statement, with a header-account roll-up branch not modelled by any existing modifier (see §5) |
| **Module / permission** | Accounting · `Cash, Bank & GL` |
| **Prototype source** | `ui-prototype/src/detail-pages.tsx` (`AccountDetail`), reusing `ui-prototype/src/ledger.tsx` (`AccountSelect`, `LedgerKpis`, `LedgerBook`) and `src/ledger-data.tsx` (`netOf`, `exportLedgerCsv`) |
| **Reference frames** | none — see §1 |
| **Posts to the ledger** | no — read surface only |

## 1. This route currently has no document, and the index entry that implies it does is wrong

`pages/README.md`'s Accounting table lists **Account Ledger** as covering both `/ledgers` and
`/finance/accounts/:code`, and [account-ledger](../account-ledger/)'s own header row says the same
("record form `/finance/accounts/:code`"). That is not accurate: `AccountDetail` is a **different
component**, in a different file (`detail-pages.tsx`, not `account-ledger.tsx`), with behaviour
`account-ledger.md` does not describe at all — the header-account roll-up branch in §3 below. The
two screens share two sub-components (`LedgerKpis`, `LedgerBook`) for the leaf-account case only.

Both frames `account-ledger.md` cites (`account ledger improved page .png`, `account ledger page
.png`) show the breadcrumb "Accounting > Ledgers" and the full interactive register — search,
`Filters`, `Voucher Type`, `Sort`, `Columns`, pagination — that belongs to `/ledgers`
(`AccountLedger`), not to this page. `AccountDetail` has none of that toolbar. Neither existing
frame depicts this route, for either the header or the leaf branch, so no frame is listed here.
This gap should be raised with whoever maintains the reference set, not silently inherited by
reusing an `/ledgers` screenshot for a screen that looks materially plainer.

## 2. Purpose

A stable, linkable, code-addressed view of one line in the chart of accounts: opening it always
lands on the same account, unlike `/ledgers`, which holds the selected account only in component
state. It is where `Chart of Accounts` "View ledger" and `/ledgers`' "Open Full Page" both point.
For a postable (level 4) account it is a statement; for a header account (level 1–3) it is a
roll-up of every account under it, because a header account has no postings of its own to show.

## 3. Two branches, one route

```
isHeader = master.level is set and master.level !== 4
```

**Header branch** (`level` 1, 2 or 3):
```
PageHead    eyebrow "Accounting / Account ledger" · header name (h1) ·
            "<code> · <type> · level <n> header — postings live on level-4 children;
             this roll-up aggregates them."                       [<- Ledger list]
IdentBar    icon · name · "<code> · <type> header · <n> sub-accounts (<m> postable)
             roll up under this head"                              [Switch account v]
KpiRow      Sub-accounts · Aggregated debit · Aggregated credit · Net position
Panel       "Sub-ledger roll-up" — every descendant, flattened (not indented as a tree)
            Code · Account · Level (chip: postable `good` / header, no tone) · Debit · Credit ·
            Balance (Dr/Cr suffix) · [Ledger ->] (postable rows only)
```

**Leaf branch** (`level` 4, postable):
```
PageHead    eyebrow "Accounting / Account ledger" · account name (h1) ·
            "<code> · <type> · level 4 transaction account — full statement below."
                                                                    [<- Ledger list]
IdentBar    icon · name · "<code> · <type> · <Rs debited> debited / <Rs credited> credited
             in Aug 2026"                                          [Switch account v]
LedgerKpis  Opening balance · Debits (Dr) · Credits (Cr) · Closing balance   (shared with `/ledgers`)
LedgerBook  "Ledger statement" — Date · Voucher · Particulars · Debit · Credit · Balance,
            opening row, one row per posting, closing row              [Download CSV]
```

`Switch account` (`AccountSelect`) navigates to `/finance/accounts/:code` for the chosen code and
works identically from either branch — picking a header re-enters this branch logic, picking a
level-4 account goes to the leaf branch. This is the one control this page has that `/ledgers`
lacks in reverse: `/ledgers`' own `AccountSelect` is filtered to postable accounts only
(`ledgers=data.masters.filter(m=>m.level===4)` in `AccountLedger`), so **`/ledgers` cannot reach a
header account at all** — only this route can.

## 4. Components

Header branch: `PageHead` · `AccountSelect` (unfiltered — the one place in the product it is used
without `postable=true`) · `KpiRow` · a plain HTML roll-up table (page-local; not `TreeTable`, since
it flattens rather than nests, and not `LedgerTable`, since its columns are balances, not postings)
· `ExportMenu`.

Leaf branch: `PageHead` · `AccountSelect` (unfiltered here too, unlike `/ledgers`) · `LedgerKpis` ·
`LedgerBook` (both shared verbatim with `account-ledger` — see [account-ledger
§3](../account-ledger/#3-components)) · `ExportMenu`.

## 5. Financial rules on this page

- Same invariants as `account-ledger` §8: debit and credit are separate columns; the running
  balance in `LedgerBook` is derived, never client-summed in production; opening balance is always
  present and labelled.
- The header branch's "Aggregated debit/credit" and "Net position" are sums over every descendant's
  net movement — this is the one place in the product a balance is shown for a **non-postable**
  account, and it must be clearly distinguished from a postable balance so nobody mistakes it for
  an account they can post to. The level chip (`postable` vs `header`) is the only thing doing that
  job today; consider whether the whole roll-up panel needs a stronger "this is a summary, not a
  ledger" treatment.
- `netOf`/`buildLedger` compute client-side in the prototype from seed journals; production reads
  server-computed figures, exactly as `account-ledger` §11 already requires for `/ledgers`.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Switch account | select | `Cash, Bank & GL` | no | Re-navigates to `/finance/accounts/<code>` |
| Ledger list (back) | ghost | — | no | `/ledgers` |
| Ledger (roll-up row) | link | `Cash, Bank & GL` | no | `/finance/accounts/<code>` of the postable child |
| Export / Download CSV | secondary | `Reports` | no | Header branch exports the roll-up; leaf branch exports the statement — different payloads behind the same-looking button, so the export's filename and header should say which |

Nothing on this page mutates a posting, exactly as `account-ledger` §6 states for `/ledgers`.

## 7. States

Missing/unknown code — `MissingRecord` ("Record not found... No account matches that reference"),
consistent with `04-states.md` §11 (tenant mismatch and genuine absence must stay indistinguishable
in production, unlike the prototype which cannot tell them apart anyway since it has no tenancy).
Empty leaf statement — `LedgerBook` already renders "No postings reached this account during Aug
2026 — balance is nil." Empty roll-up (a header with no postable descendants) — not handled in the
prototype; needs the standard empty-state treatment before build.

## 8. Responsive · Accessibility

Both branches: `lg` the roll-up/statement table scrolls horizontally with Account/Particulars
sticky · `md` `KpiRow`/`LedgerKpis` drop to 2 columns · `xs` card list, read-only. The roll-up
table needs the same `<caption>`-names-the-scope treatment as `account-ledger` §10; today it has
none. Level chips need text, not colour alone, to distinguish header from postable rows (already
true — they carry the word "header" or "postable").

## 9. Deviations from the prototype

- The prototype computes every figure client-side from seed data; production reads server figures,
  as already required for `/ledgers`.
- No filters, search, saved views or date range on either branch, unlike `/ledgers`. Given this
  route is meant to be the stable, linkable target of "Open full page" and "View ledger" actions
  elsewhere in the product, that is a real functional gap for the leaf branch specifically — a
  permalink to a statement with no way to change the period is of limited use. Whether it should
  inherit `/ledgers`' full toolbar, or stay deliberately minimal as a read-only citation target, is
  open (§10).
- The period is hard-coded to August 2026 in both branches' copy ("in Aug 2026", "01 Aug 2026")
  exactly as it is in `account-ledger` — not specific to this page, but repeated here.

## 10. Open questions

1. Should the leaf branch gain `/ledgers`' date range and filters, making this route effectively
   "`/ledgers` pre-selected by code," or should it stay a minimal, permanent-link statement and push
   filtering needs back onto `/ledgers`?
2. Does the header-branch roll-up need the same drill-down interactivity as `Chart of Accounts`
   (expand/collapse, indent), or is a flat descendant list sufficient because the tree itself lives
   on `/accounts`?
3. `account-ledger/README.md`'s own header table still reads "Route | `/ledgers` · record form
   `/finance/accounts/:code`" and its prototype-source row does not list `detail-pages.tsx`. That
   text is now superseded by this document but is outside this task's `ALLOWED` path (only
   `pages/README.md` may be edited among existing page documents) — flagged as `OBSERVED` for
   whoever next touches `account-ledger/README.md` to correct. The index in `pages/README.md` has
   been corrected as part of this task to point `/finance/accounts/:code` at this document instead.
