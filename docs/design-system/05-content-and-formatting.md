# Content & formatting

Formatting is part of correctness. Every rule here is implemented **once**, in
`packages/ui` formatters backed by `packages/shared-types`, and imported everywhere.
The prototype's `ui-prototype/src/format.ts` is the ancestor of this module.

---

## 1. Money

| Rule | |
|---|---|
| Locale | `en-PK`, grouping every 3 digits |
| Symbol | `Rs` prefix with a hard space: `Rs 3,458,000.00` |
| Decimals | Exactly 2 for PKR — always shown, never trimmed |
| Alignment | Right, tabular figures |
| Column unit | In the header — `Debit (Rs)` — not repeated per cell |
| Zero | Em dash `—` in `--money-zero` on ledger, voucher and movement tables; `Rs 0.00` on KPIs and totals |
| Negative | `(1,250.00)` in brackets, `--money-negative` colour. Never a leading minus on an accounting surface |
| Sign | Dr/Cr is carried by the **column**, never by a sign |
| Rounding | Display rounding only at the presentation layer; never round a value before sending it |
| Abbreviation | Permitted only in chart axis labels |
| Amount in words | On every printable document: `Rupees Eight Hundred Ninety One and Paisa Fifty Five Only` |

Multi-currency is out of MVP scope. When it lands, every amount gains a currency code adornment
and a second column for base-currency equivalent — no silent conversion.

## 2. Quantities

Right-aligned, decimals per the product's UoM (typically 0), unit in the header (`Qty (Strips)`).
Bonus quantity is a separate column, never folded into quantity.
Negative stock renders in `--money-negative` with a `danger` badge.

## 3. Rates, percentages, ratios

Rates carry 2–4 decimals per configuration. Percentages: one decimal, `%` suffix, right-aligned
(`17.0%`). Deltas carry an explicit sign and an arrow: `▲ +2.5%`, `▼ -1.2%`.

## 4. Dates and periods

| Context | Format |
|---|---|
| Table cell | `01 Aug 2026` |
| Date + time | `01 Sep 2026, 10:27 AM` |
| Range | `01 Aug 2026 – 31 Aug 2026` (en dash, spaced) |
| Fiscal period | `Aug 2026` with status chip |
| Relative | Only for activity feeds within 24h ("2 hours ago"); everything else is absolute |
| Input | Date picker only. Typed input accepts `DD-MM-YYYY` and echoes the canonical form |

Never `01/08/2026` — ambiguous between conventions.
Timestamps are rendered in the tenant's timezone and the timezone is stated on exports.

## 5. Document numbers

Monospace-ish tabular, always shown in full, always a link to the document.
Format is server-issued per document type (`JV-2026-0419`, `SV-2026-000123`, `PO-78956`).
The UI shows `Auto` in the number field until the server assigns one. The UI never generates,
increments or predicts a number.

## 6. Accounts

Always `code — name` in pickers and headers (`1110-01 — Cash in Hand`). In tables, code and name
are separate columns when both are needed. Account type and nature (`Asset · Current Asset · Debit`)
sit in the account header as a meta line.

## 7. Status vocabulary

One word per state, product-wide. Do not invent synonyms.

`Draft` · `Pending approval` · `Submitted` · `Posted` · `Reversed` · `Cancelled` ·
`Active` · `Inactive` · `Open` · `Closed` · `Partially paid` · `Paid` · `Overdue` ·
`In clearing` · `Cleared` · `Dishonoured` · `Void` · `Received` · `Issued` · `Transferred`.

## 8. Voice

Plain, specific, unhurried. Second person. No exclamation marks on financial surfaces.
Verbs in buttons (`Post voucher`, not `Submit`). Never blame the user, never apologise twice.

| Instead of | Write |
|---|---|
| "Oops! Something went wrong." | "We could not post this voucher. Nothing was saved." |
| "Invalid input" | "Debits and credits differ by Rs 1,250.00." |
| "You don't have access" | "The Salesman role cannot post vouchers." |
| "Are you sure?" | "Post 4 lines totalling Rs 891.55 to Sep 2026? Posted entries cannot be edited." |

## 9. Numbers in prose

Spell out zero to nine in prose; use figures for anything monetary, any quantity, any date.
Counts in headings use figures with the noun: `Ledger Transactions (15)`.

## 10. Localisation readiness

All strings come from a message catalogue with keys; no concatenated sentences; plurals via ICU
message format. English (Pakistan) is the only shipped locale in MVP; Urdu is anticipated, so
layouts must tolerate 30% text expansion and future RTL mirroring of the shell.
