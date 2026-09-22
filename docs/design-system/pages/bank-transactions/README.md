# Bank Transactions

| | |
|---|---|
| **Route** | `/bank-transactions` |
| **Archetype** | D — Ledger / Statement |
| **Module / permission** | Accounting · `Cash, Bank & GL` |
| **Prototype source** | `ui-prototype/src/bank-transactions.tsx` (`BankTransactions`) |
| **Reference frames** | `design/bank transactions page .png`, `design/bank transactions.png` |
| **Posts to the ledger** | no — read surface; entry happens on the cheque and payment screens |

## 1. Purpose

The statement view of one bank account: deposits, withdrawals and running balance, with the
supporting document for each line one click away.

## 2. Anatomy

```
PageHead      "Bank Transactions" · [account picker] [01 Aug – 31 Aug v] [Export v] [Print]
AccountHeader bank mark · account title · masked number · branch · [Book balance] [Statement balance]
KpiRow        Opening · Deposits · Withdrawals · Closing · Uncleared
FilterBar     search · type · cleared status · amount band · reference
LedgerTable   Date · Chq / Ref No. · Particulars · Type · Withdrawal (Rs) · Deposit (Rs) · Balance (Rs) · Cleared · Doc
Footer        page totals · closing balance · pager
```

## 3. Components

`AccountHeader` · `KpiRow` · `LedgerTable` · `FilterBar` · `StatusBadge` · `ExportMenu` ·
`DocumentLink` cell (opens the voucher, cheque or payment behind the line).

## 4. Columns

| Column | Align | Format | Priority |
|---|---|---|---|
| Date | left | `01 Aug 2026` | 1 |
| Chq / Ref No. | left | cheque number or reference, links to the instrument | 1 |
| Particulars | left | narration + 9.5px counterparty | 1 |
| Type | left | chip: Deposit `good` · Withdrawal `warn` · Charges `neutral` · Transfer `info` | 2 |
| Withdrawal (Rs) | right | `--money-credit` (bank asset decreases) | 1 |
| Deposit (Rs) | right | `--money-debit` | 1 |
| Balance (Rs) | right | `--money-balance` | 1 |
| Cleared | left | Cleared `good` · In clearing `warn` · Uncleared `neutral` · Dishonoured `danger` | 2 |
| Doc | right | icon link to the source document / PDF | 3 |

## 5. Financial rules

- Withdrawal and deposit stay in **separate columns**; the balance is derived and coloured as such.
- Cleared status belongs to the **instrument**, not the posting: a posted but uncleared cheque still
  affects the book balance and is the reconciling item against the statement balance.
- The header shows **book** and **statement** balance side by side with their difference; if they
  differ and no uncleared item explains it, an `InlineWarning` says so and links to the bank book.
- Nothing on this page mutates a posting.

## 6. States

Empty, filtered-empty, error — standard. Missing statement balance shows "Not imported" rather than
zero.

## 7. Responsive · 8. Accessibility

`xl` hides Doc and Type · `md` the account header stacks · `sm`+ horizontal scroll with Date sticky;
Withdrawal, Deposit and Balance are never dropped. `<caption>` names the bank account and period.

## 9. Deviations from the prototype

The prototype renders one hard-coded account. Production requires the account picker and the dual
book/statement balance in the header.

## 10. Open questions

1. Is statement import (CSV / MT940) in MVP, and does it land here or in the bank book?
2. Do bank charges get auto-suggested as postings, and if so how is the suggestion marked?
