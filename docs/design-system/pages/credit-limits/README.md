# Credit limits & terms

| | |
|---|---|
| **Route** | `/credit-limits` |
| **Archetype** | A — Register (editable policy table) |
| **Module / permission** | Receivables · `Cash, Bank & GL` · editing needs `credit:manage` |
| **Prototype source** | `ui-prototype/src/credit-limits.tsx` (`CreditLimitsTerms`) |
| **Posts to the ledger** | no — it constrains what sales may post |

## 1. Purpose

Set and monitor how much credit each customer may take and on what terms. It is a policy screen
whose values are enforced at the point of sale.

## 2. Anatomy

```
PageHead   "Credit limits & terms" · "Set limits, payment terms and hold status per customer to
            control exposure and cash conversion." · [Export] [Bulk update]
KpiRow     Total credit exposure · Average utilization · At / over limit · Policy reviews due
Table      "Customer credit ledger"
           Customer · Limit · Outstanding · Available · Utilization · Terms · Hold · Review · Actions
Panel      "Risk highlights" — Customer · Exposure · Limit · Utilization · Action
```

## 3. Components

`KpiRow` · `DataTable` (inline-editable cells) · `UtilizationBar` (page-local) · `Toggle` (hold) ·
`StatusBadge` · `ConfirmDialog` · `Panel`.

## 4. Columns

| Column | Align | Format |
|---|---|---|
| Customer | left | name + code, links to the record |
| Limit | right | money, **editable** with `credit:manage` |
| Outstanding | right | money, read-only, server-computed |
| Available | right | limit − outstanding; `--money-negative` when over |
| Utilization | right | percentage + bar; `good` < 70, `warn` 70–99, `danger` ≥ 100 |
| Terms | left | `Net 30` etc., editable from a controlled list |
| Hold | left | toggle — `On hold` `danger` / `Open` `good` |
| Review | left | next policy review date; `warn` when due |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Edit limit / terms (inline) | inline | `credit:manage` | **yes when lowering below current outstanding** | Writes an audit record with old and new values |
| Place / release hold | toggle | `credit:manage` | **yes** — states the effect on new sales | Blocks new credit sales for that customer |
| Bulk update | secondary | `credit:manage` | yes, with a preview of affected customers | Applies a limit or term change to a selection |
| Export | secondary | `Reports` | no | Policy snapshot with as-at date |

## 6. Financial rules

- This screen posts nothing, but it **blocks postings elsewhere**: a credit sale that would exceed
  the limit, or any credit sale to a held customer, is refused at the sales voucher with the reason
  and the figures. There is no in-line override on the sales screen; an override is a change made
  here, by someone with `credit:manage`, and it is audited.
- Outstanding is server-computed; the limit is the only editable figure.
- Every change writes an append-only audit record — who, when, from what, to what, and why.

## 7. States

- Over-limit rows sort to the top by default and carry a `danger` chip.
- Empty: "No credit customers yet."
- A customer with a dishonoured cheque in the last 90 days carries an `info` chip linking to
  `/cheque-actions`.

## 8. Responsive · 9. Accessibility

`xl` hides Review · `md` the risk panel moves below · `xs` card list, read-only.
Inline-editable cells are real inputs with labels naming the customer and field; the utilization bar
has a text percentage beside it, never colour alone.

## 10. Open questions

1. Is a reason mandatory on every limit change, or only on increases?
2. Does a hold block cash sales as well as credit sales? (Assumed: credit only.)
3. Are limits per customer, per group, or per branch?
