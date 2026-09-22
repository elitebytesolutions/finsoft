# Bank Book & reconciliation

| | |
|---|---|
| **Route** | `/bank-book` |
| **Archetype** | D — Ledger (+ reconciliation workspace) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · reconciling needs `bank:reconcile` |
| **Prototype source** | `ui-prototype/src/bank-book.tsx` (`BankBook`), `src/finance-pages.tsx` |
| **Reference frame** | `ui-prototype/design/bank book page .png` |
| **Posts to the ledger** | **yes, indirectly** — unmatched bank items (charges, profit, returns) are posted from here |

## 1. Purpose

Match the book against the bank. The accountant works two columns — book entries and statement
lines — until the difference is explained, then posts the items the bank knows about and the book
does not.

## 2. Anatomy

```
PageHead      "Bank book" · [account v] [period v] [Import statement] [Export] [Finish reconciliation]
KpiRow        Bank balance (statement) · Book balance · Uncleared cheques · Unexplained difference
Progress      "Reconciliation Progress"  matched n of m · progress bar · difference figure
Grid          [ Book entries — unmatched ]      [ Statement lines — unmatched ]
                ☐ date · ref · particulars ·      ☐ date · ref · description ·
                  debit · credit                     deposit · withdrawal
              [ Matched pairs ] collapsible
Issues        "Issues" — items the system could not match, with a suggested action each
```

## 3. Components

`KpiRow` · `ReconciliationGrid` (page-local: two selectable lists with a match action) ·
`ProgressBar` · `DataTable` · `ConfirmDialog` · `AiSuggestion` (G7) for suggested matches ·
`ImportDialog`.

## 4. Matching rules

- Selecting one or more items on each side enables **Match** (1:1, 1:many, many:1).
- A match is a **record**, not a posting: it marks the book item cleared and links the statement
  line. It changes no amount.
- A statement line with no book counterpart offers **Post as…** (bank charge, profit on deposit,
  cheque return, transfer) which opens a pre-filled voucher entry — confirmed, dated, and refused
  in a closed period like any other posting.
- Suggested matches from the system are `AiSuggestion` chips: they must be accepted by a human and
  can never auto-match.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Import statement | secondary | `bank:reconcile` | no | CSV/MT940; shows a preview before committing |
| Match | primary | `bank:reconcile` | no | Marks cleared; reversible until the reconciliation is finished |
| Unmatch | ghost | `bank:reconcile` | no | Available only while unfinished |
| Post as… | primary | `voucher:create` | **yes, with the entry preview** | Creates and posts a voucher; the new line appears on the book side already matched |
| Finish reconciliation | primary | `bank:reconcile` | **yes** — disabled while the difference is non-zero | Freezes the matches, records who and when, sets the account's `last reconciled` date |

## 6. Financial rules

- **Reconciliation never edits a posting.** Differences are resolved by posting new entries or by
  correcting the statement import.
- Finishing is blocked while the unexplained difference is non-zero; the difference figure sits in
  `--money-negative` until it is `0.00`. There is no "accept difference" control and no tolerance.
- A finished reconciliation is immutable; a later correction is a new reconciliation.

## 7. States

- Unbalanced: the difference is shown in the KPI row and above the finish button with its cause
  breakdown (uncleared cheques, deposits in transit, unposted charges).
- Import errors: line-level errors listed with row numbers; nothing is imported until the preview is
  accepted.
- Closed period: `Post as…` is disabled with the period reason; matching remains allowed.

## 8. Responsive · 9. Accessibility

`lg` the two lists stack with the statement side collapsible · below `md` the page is read-only with
a "reconcile on a desktop" notice. Each list is a labelled `listbox` with multi-select; the match
action states how many items on each side it will pair.

## 10. Deviations from the prototype

The prototype shows a single-column bank book with an issues panel. Production requires the
two-column matching workspace — reconciliation is the reason the page exists.

## 11. Open questions

1. Which statement formats must MVP import?
2. Are partial matches (one book item to part of a statement line) needed for lodgements?
3. Does finishing a reconciliation post anything, or only record state? (Assumed: records only.)
