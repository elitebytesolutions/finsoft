# Accounts payable

| | |
|---|---|
| **Route** | `/payables` |
| **Archetype** | A — Register (balances + ageing + invoices) |
| **Module / permission** | Accounting · `Cash, Bank & GL` |
| **Prototype source** | `ui-prototype/src/finance-pages.tsx` (`AccountsPayable`) |
| **Posts to the ledger** | no — payments are posted from `/payments` |

## 1. Purpose

Know exactly what the business owes and when. The mirror of [receivables](../receivables/), and it
deliberately uses the same anatomy so the two read identically.

## 2. Anatomy

```
PageHead   "Accounts payable" · "Supplier invoices awaiting settlement — know exactly what is owed
            and when." · [as-at v] [Export] [Payment run]
KpiRow     Total payable · Due this week · In drafts · Over 90 days
Grid       [ Supplier balances ]             [ Ageing summary ]
             Supplier · City · Posted invoices  buckets
             · Outstanding · [Open]
Table      "Supplier invoices"
           Purchase · Date · Supplier · Product · Qty · Amount · Due · Status · Actions
Panel      "Tax & advances" — WHT deducted, advances paid, adjustments pending
```

## 3. Components

`KpiRow` · `DataTable` · `AgeingChart` · `StatusBadge` · `ExportMenu` · `PartyLink` ·
`Panel` (tax & advances).

## 4. Formatting notes

Same buckets, same as-at rules, same colour semantics as receivables. `In drafts` is its own KPI
because an unposted purchase invoice is a **liability the business has incurred but not recorded** —
the figure exists to make that gap visible, and it is labelled "not yet posted".

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Record payment | primary (row) | `payment:create` | — | `/payments` pre-filled with supplier and invoice |
| Payment run | primary | `payment:create` | — | Selects due invoices and hands them to `/payments` as an allocation set; **it does not post** |
| Open supplier | link | `Masters` | no | `/vendors/:code` |
| Export | secondary | `Reports` | no | Filtered set with as-at date |

## 6. Financial rules

- Nothing posts here.
- Withholding tax deducted at payment (u/s 153) is shown as a separate figure, never netted into the
  outstanding balance silently.
- Advances to suppliers appear as negative outstanding in brackets and are listed in the tax &
  advances panel with the documents they can be adjusted against.
- Drafts are excluded from the payable total and counted separately.

## 7. States

Empty, filtered empty, error — standard. A supplier with a negative balance (advance) carries an
`info` chip explaining it rather than showing a confusing bracketed figure alone.

## 8. Responsive · 9. Accessibility

Identical to receivables — the two pages share layout so users move between them without relearning.

## 10. Open questions

1. Does the payment run need approval before it reaches `/payments`?
2. Are early-settlement discounts modelled in MVP?
3. Should advances be a separate tab rather than a panel?
