# Cheque posting & reversal

| | |
|---|---|
| **Route** | `/cheque-posting` |
| **Archetype** | A1 — Register with inspector |
| **Module / permission** | Accounting · `Cash, Bank & GL` · `voucher:create` to post, `voucher:reverse` to reverse |
| **Prototype source** | `ui-prototype/src/cheque-posting.tsx` (`ChequePosting`) |
| **Reference frames** | `design/checkpostingreversal screen.png`, `design/postreversal cheques .png` |
| **Posts to the ledger** | **yes** — this is where a cheque hits the bank |

## 1. Purpose

Move cheques from "in hand / issued" to "cleared in bank", and reverse that step when the bank
returns one. Every line on this screen is a bank posting.

## 2. Anatomy

```
PageHead    "Cheque Posting & Reversal" · [bank v] [date range v] [Export]
ModeSwitch  [ Post to bank ] [ Reverse posting ]
KpiRow      Cheques in hand · Due today · Posted today · Reversed this month
Filter      "Filter / Search" — bank · party · salesman · cheque no · due-date range · status
Table       "Cheque Entries"
            ☐ · Voucher No. · Cheque no · Date · Due date · Account / party · Bank · Salesman ·
            Debit (Rs) · Credit (Rs) · Remarks · Status · Actions
Footer      selected count · selected total · pager
BulkBar     n selected · [Post selected to bank]  (with a full preview step)
```

## 3. Components

`SegmentedControl` (mode) · `FilterBar` · `DataTable` with selection · `BulkActionBar` ·
`ConfirmDialog` (with an entry preview table) · `StatusBadge` · `KpiRow`.

## 4. Columns

Debit and credit are **separate** columns even here, because the same table shows received
(debit bank) and issued (credit bank) cheques.

| Column | Align | Notes |
|---|---|---|
| Voucher No. | left | the originating cheque voucher, linked |
| Cheque no | left | tabular |
| Date / Due date | left | due date in `danger` when past and still unposted |
| Account / party | left | links to the party |
| Bank | left | our bank account |
| Salesman | left | who collected it (received cheques) |
| Debit (Rs) / Credit (Rs) | right | `--money-debit` / `--money-credit` |
| Status | left | In hand `neutral` · In clearing `warn` · Cleared `good` · Dishonoured `danger` · Reversed `danger` |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Post to bank (single or selected) | primary | `voucher:create` | **yes — lists every cheque, the total, the bank account and the period** | Posts clearing entries; statuses move to Cleared |
| Reverse posting | danger | `voucher:reverse` | **yes, reason required** | Posts a reversing entry; the cheque returns to In hand and gains a `Reversed` history entry |
| Export | secondary | `Reports` | no | The filtered set |

Bulk posting is permitted here — unlike vouchers — **only because** the confirm dialog enumerates
every cheque and its amount, the action is a single uniform clearing entry per cheque, and the whole
batch shares one idempotency key. If the preview cannot be shown, the bulk action is not offered.

## 6. Financial rules

- Posting a received cheque: debit bank, credit cheques-in-hand. Issued: credit bank, debit
  cheques-issued. The module raises the event; the posting engine builds the lines.
- A cheque already cleared cannot be posted again — the row action is absent, not disabled-on-click.
- Reversal never deletes the clearing entry; it posts an opposite entry and both remain visible.
- Closed period: posting and reversal are both refused, with the date of the first open period
  offered in the dialog.

## 7. States

Empty ("No cheques awaiting posting"), filtered empty, partial failure of a batch — the dialog
reports per-cheque outcomes and leaves the successful ones posted; nothing is silently rolled back
without saying so.

## 8. Responsive · 9. Accessibility

`xl` hides Salesman and Remarks · `md` the filter panel collapses into a Filters sheet ·
`xs` read-only card list. Selection checkboxes are labelled with the cheque number and party; the
bulk preview is a real table inside the dialog so it can be read line by line.

## 10. Open questions

1. Is there an intermediate "sent for clearing" status before Cleared, and does it post?
2. Are clearing dates supplied by the bank statement import, or typed?
3. Does reversal require a dishonour reason from a controlled list (for reporting)?
