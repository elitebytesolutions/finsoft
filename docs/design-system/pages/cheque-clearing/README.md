# Cheque clearing

| | |
|---|---|
| **Route** | `/cheque-clearing` |
| **Archetype** | G — Workbench |
| **Module / permission** | Accounting · `Cash, Bank & GL` · `voucher:create` |
| **Prototype source** | `ui-prototype/src/control-pages.tsx` (`ChequeClearing`) |
| **Posts to the ledger** | **yes** — clearing a cheque posts to bank |

## 1. Purpose

The daily cheque desk: what is in hand, what matures today, what is out for clearing and what came
back. It is the queue view of the same instruments that `/cheque-posting` handles as a register.

Division of labour: **this page decides what to act on today**; `/cheque-posting` is where batches
are posted and reversed; `/cheque-actions` handles failures.

## 2. Anatomy

```
PageHead   "Cheque clearing" · "Track cheques from receipt to clearing — present, clear or return
            dishonoured instruments." · [Cheque register] [Export]
KpiRow     Cheques in hand · In clearing · Clearing exposure (Rs) · Matured today
Panels     [ Maturing today ]    Cheque · Bank · Party · Dated · Amount · [Present]
           [ In clearing ]       Cheque · Bank · Party · Dated · Amount · [Clear] [Return]
           [ Returned ]          Cheque · Bank · Party · Dated · Amount · Reason · [Handle]
Table      "Cheque register" — full list with status filter
```

## 3. Components

`KpiRow` · `Panel` + `DataTable` per bucket · `ConfirmDialog` (entry preview) · `StatusBadge` ·
`ExportMenu`.

## 4. Status lifecycle

```
In hand ──present──> In clearing ──clear──> Cleared
                          │
                          └──return──> Dishonoured ──> (handled in /cheque-actions)
```

Each transition is a row action with a confirmation. `Present` is the only transition that does not
post; `Clear` and `Return` both post.

## 5. Actions

| Action | Kind | Permission | Confirm | Posts |
|---|---|---|---|---|
| Present | secondary | `voucher:create` | yes (count + total) | no — status only, records the presentment date |
| Clear | primary | `voucher:create` | **yes, with the entry preview** | debit bank / credit cheques-in-hand |
| Return | danger | `voucher:reverse` | **yes, reason required** | reversal + optional charges |
| Handle (returned) | link | — | no | Routes to `/cheque-actions` |

## 6. Financial rules

- Clearing exposure (value in clearing) is a KPI because it is the difference between book and bank
  that the reconciliation will have to explain.
- Nothing here edits a posted entry; returns are reversals.
- Closed period blocks Clear and Return; Present remains allowed because it posts nothing.

## 7. States

- Empty per panel, each with its own sentence ("Nothing matures today.").
- Overdue: a cheque past its due date and still in hand carries a `danger` chip and sorts first.
- KPI counts equal panel rows.

## 8. Responsive · 9. Accessibility

`md` panels stack · `xs` card list with one action per card.
Row actions are buttons with accessible names including the cheque number and amount.

## 10. Open questions

1. Is "presented" tracked per clearing house cycle, with an expected clearing date?
2. Should this page and `/cheque-posting` be merged once both are built? (Recommendation: keep the
   queue and the register separate, but share one instrument table component.)
