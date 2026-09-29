# Cash Book

| | |
|---|---|
| **Route** | `/cash-book` |
| **Archetype** | D — Ledger / Statement (+ inline entry drawer) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · entry needs `voucher:create` |
| **Prototype source** | `ui-prototype/src/cashbook.tsx` (`CashBook`) |
| **Reference frame** | `ui-prototype/design/cashbook image .png` |
| **Posts to the ledger** | **yes** — cash receipts and payments raise a financial event |

## API note — M2-S (2026-09-29, revised)

**This screen is repurposed for M2, not merely re-skinned.** The coordinator's direction: `/cash-book`
becomes **the read-only ledger of the Cash in Hand account** (role `CASH_DEFAULT`, seeded as code
`1110` in `COA/standard-v1` — `coa-standard.md` §2), fetched through the same
`GET /api/ledgers/:accountId` endpoint `account-ledger.md` uses, scoped permanently to that one
account. It is **not** an entry form. Cash movements are recorded the same way every other MVP
posting is: a Journal Voucher (`Dr`/`Cr` 1110) from `/vouchers/new`. The separate `/cash-transactions`
screen (`cash-transactions.tsx`, archetype A) is explicitly **out of this scope and stays a
prototype** — it is a different route and a different component from this one.

**Resolving the Cash in Hand account.** `coa-standard.md` §4: roles resolve server-side, never by
code or name, and are "not reassignable in the MVP." The ideal lookup is "the account holding role
`CASH_DEFAULT`" via `GET /api/accounts`, once that route exists (blocked — see below) — its
specified response shape (`docs/design/M2/api-contract.md` §5) includes a `role` field per account
precisely so a caller can do this instead of hardcoding a code. **Until `GET /api/accounts` is real,
this screen resolves the account by its **documented interim**: code `1110`, fetched via whatever
account-lookup-by-code path the wired Chart of Accounts screen ends up using once `GET /api/accounts`
lands — there is no separate "look up by code" endpoint, so in practice this screen finds `1110` by
filtering the same account list Chart of Accounts fetches.** This is called out explicitly, not
silently assumed: **if a tenant's chart ever diverges from `standard-v1`** (a Wave 10 tenant-specific
chart, `coa-standard.md` §1) **code `1110` is no longer guaranteed to be Cash in Hand**, and this
screen's account resolution must move to the role-based lookup before that happens. Recorded as open
question 1 below, superseding the prototype's own question about a cash-account *selector* — in M2
there is exactly one cash account, not a chooser.

**What the old "Cash Book Entry" form becomes:** removed. `Cash In` / `Cash Out` quick-entry panels,
"Quick Entry" mode switch, attachments drop zone, and the multi-account KPI trio (Main Cash
Drawer/Bank Account/Petty Cash — none of which exist in `COA/standard-v1`) are all gone. The anatomy
below replaces §2.

```
PageHead     "Cash Book" · "Cash in Hand (1110) — read-only" · [date range] [Export] [Post a voucher ->]
KpiRow (4)   Opening balance · Total receipts (debits) · Total payments (credits) · Closing balance
LedgerTable  Date · Voucher No. (links to /vouchers/:id) · Particulars · Receipt (Rs) · Payment (Rs) ·
             Balance (Rs) · Status
Footer       Page totals · closing balance · pager (server cursor, matching account-ledger.md)
```

`Receipt`/`Payment` are this page's names for the ledger's Debit/Credit columns, since "cash in"
reads more naturally than "debit" to the intended user — same underlying `debit`/`credit` fields,
same `--money-debit`/`--money-credit` tones (`01-foundations.md` §1.3: Dr/Cr tones are fixed
meanings, never repurposed). `Post a voucher` routes to `/vouchers/new`, since that is the actual way
to add a cash movement now.

**Everything `account-ledger.md`'s API note already establishes applies here too** — server-computed
running balance, `occurred_at`-then-`created_at`-then-entry-number order, reversal markers on both
sides of a pair, posted+reversed inclusion, no client-side pagination/filtering of server data,
`report.financial` permission (the ledger endpoint's real code, not the prototype's `voucher:create`)
— because this is that same endpoint, just permanently scoped to one account with no account switcher
at all (there is nothing to switch to).

## 1. Purpose

The cashier's daily book: opening cash, every receipt and payment in order, closing cash, and a
fast way to record the next one without leaving the page.

## 2. Anatomy

```
PageHead      "Cash Book Entry" · description · [date v] [Print] [Export] [+ Cash In] [+ Cash Out]
KpiRow        Opening cash · Cash in (today) · Cash out (today) · Closing cash
QuickEntry    Two tinted panels side by side: Cash In (green) | Cash Out (amber)
              account · counterparty · amount · narration · [Save draft] [Save & post]
LedgerTable   Date · Voucher No. · Particulars · Counterparty · Receipt (Rs) · Payment (Rs) ·
              Balance (Rs) · Status · Actions
Footer        Day totals · closing balance · pager
```

## 3. Components

`KpiRow` · `LedgerTable` (D2 with Receipt/Payment in place of Debit/Credit) · `FormSection`
(the two entry panels) · `AccountPicker` · `PartyPicker` · `MoneyInput` · `ConfirmDialog` ·
`DateField`.

## 4. Data

| Column | Align | Format |
|---|---|---|
| Date | left | `01 Aug 2026` |
| Voucher No. | left | server-issued, links to the voucher |
| Particulars | left | narration + 9.5px contra account |
| Counterparty | left | party name, links to the party record |
| Receipt (Rs) | right | `--money-debit` (cash increases are debits to cash) |
| Payment (Rs) | right | `--money-credit` |
| Balance (Rs) | right | `--money-balance`, running |
| Status | left | Posted `good` · Draft `warn` |

KPIs are for the selected **day**, and the day is stated on each card.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Cash In / Cash Out | primary / secondary | `voucher:create` | — | Focuses the matching entry panel |
| Save draft | secondary | `voucher:create` | no | Draft voucher, no ledger effect |
| Save & post | primary | `voucher:create` | **yes** | Raises a cash receipt/payment event; toast carries the voucher number |
| Print day book | secondary | `Cash, Bank & GL` | no | `PrintDocument` for the selected day |

## 6. States

Closed period → both entry panels are disabled with the period banner, the ledger remains readable.
Empty day → "No cash movements on 12 Sep 2026" and the opening balance still shows.

## 7. Financial rules on this page

- Cash In debits the cash account; Cash Out credits it. The panel colours are a mnemonic, **not**
  the Dr/Cr semantics — the columns carry that.
- The module never writes journal lines: it raises the event and the posting engine builds them.
- Posting is idempotent — the entry panel holds one key per form instance.
- Closing cash is server-computed; a physical cash count variance is recorded as its own voucher,
  never by editing a balance.

## 8. Responsive · 9. Accessibility

`md` the two entry panels stack · `sm` entry moves into a drawer opened by the Cash In/Out buttons.
Each entry panel is a `<form>` with its own error summary; the two panels have distinct accessible
names so a screen reader never confuses them.

## 10. Deviations from the prototype

The prototype's `cb-*` panels are two local forms; production uses one `FormSection` component with
a direction prop. The prototype's balance is client-derived; production reads it from the server.

## 11. Open questions

1. **Superseded by the API note above.** In M2 there is exactly one cash account (`1110`, resolved
   today by code, interim) and no selector. Once `GET /api/accounts` exposes `role`, this screen must
   resolve by `role = CASH_DEFAULT` instead of the hardcoded code, so a Wave 10 tenant-specific chart
   does not silently point this screen at the wrong account.
2. Does the cashier need a denomination breakdown for day close? Not applicable in M2 — there is no
   day-close action on this page at all now that it is read-only.
3. Not applicable in M2 — cash entry is a Journal Voucher, validated by the JV posting rule
   (`journal-voucher.md` §3), not by this page.
