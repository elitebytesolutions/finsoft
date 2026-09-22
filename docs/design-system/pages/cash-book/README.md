# Cash Book

| | |
|---|---|
| **Route** | `/cash-book` |
| **Archetype** | D — Ledger / Statement (+ inline entry drawer) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · entry needs `voucher:create` |
| **Prototype source** | `ui-prototype/src/cashbook.tsx` (`CashBook`) |
| **Reference frame** | `ui-prototype/design/cashbook image .png` |
| **Posts to the ledger** | **yes** — cash receipts and payments raise a financial event |

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

1. Is there one cash account per branch, and does the page need a cash-account selector?
2. Does the cashier need a denomination breakdown for day close?
3. Is a negative cash balance blocked at entry or only flagged?
