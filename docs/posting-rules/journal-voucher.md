# JOURNAL_VOUCHER_POSTED@1 — manual journal voucher

| | |
|---|---|
| **Rule** | `JOURNAL_VOUCHER_POSTED@1` |
| **Status** | APPROVED — Accounting seat, 2026-09-27 (M2-000) |
| **Implemented in** | M2 — `postingEngine` |
| **Governed by** | [ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md) ("the one event whose payload carries accounts explicitly … It is not a back door"); [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rules 1, 5, 9, 12, 13, 14, 22 |
| **Golden** | P01, P02, P03, P07, P08, P09 |

---

## 1. Event and trigger

**Event:** `JOURNAL_VOUCHER_POSTED`.

**Trigger:** a user holding `voucher.post` submits a manual journal voucher. In the MVP the voucher is **submitted and posted in one request**: there is no JV draft table and no approval step (subject to [PO-Q2](#9-product-owner-question)). The journal entry *is* the voucher.

**Not a trigger:** anything automated. No job, import, integration or AI raises this event. An AI may *suggest* a voucher; a human submits it through the normal authorised path (rule 22).

## 2. Payload

```ts
{
  event: 'JOURNAL_VOUCHER_POSTED',
  referenceType: 'journal_voucher',
  referenceId: <uuid generated server-side for this voucher>,
  occurredAt: '2026-09-05',            // business date, tenant timezone
  idempotencyKey: '<client uuid>',
  actor,                                // the authenticated user
  payload: {
    narration: 'September rent and utilities paid from bank',   // required
    reference: 'Landlord receipt 0912',                          // optional, ≤ 100 chars
    lines: [
      { accountId, debit: '45000.0000', memo?: 'September rent' },
      { accountId, credit: '55000.0000' },
      …
    ],
  },
}
```

A line carries **exactly one** of `debit` or `credit`. The other key is absent, not `"0.0000"` — the absence is what "one side per line" means in the payload. The kernel stores both columns, the absent side as `0.0000`. Lines carry **no party**: every account a JV may reach is a non-control account ([coa-standard.md](coa-standard.md) §3), and a party on a non-control line is forbidden ([README](README.md) §4.1).

## 3. Preconditions and validation

Any failure rejects the whole voucher. Nothing is written and no number is consumed. Rows are grouped by meaning; **execution follows [ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md)'s pipeline**: payload shape (rows 1–6) → idempotency → date and period (13–14) → accounts (7–11) → balance (12). Which error wins when several rules fail at once is not part of the contract; every golden case violates exactly one.

| # | Rule | Error |
|---|---|---|
| 1 | Payload is schema-valid: amounts are strings; no unknown keys | `PAYLOAD_INVALID`, `AMOUNT_NOT_STRING` |
| 2 | `narration` non-empty after trimming, ≤ 500 characters | `NARRATION_REQUIRED`, `NARRATION_TOO_LONG` |
| 3 | At least **2** lines, at most **200** | `JV_TOO_FEW_LINES`, `JV_TOO_MANY_LINES` |
| 4 | Each amount: decimal notation, ≤ 4 dp, not negative, within `numeric(19,4)` | `AMOUNT_SCALE`, `AMOUNT_NEGATIVE`, `AMOUNT_OUT_OF_RANGE` |
| 5 | Each line has exactly one of `debit` / `credit` | `JV_LINE_BOTH_SIDES`, `JV_LINE_NO_SIDE` |
| 6 | **No zero line**: the one side present is > 0 | `JV_ZERO_LINE` |
| 7 | Each account exists **in the caller's tenant** | `ACCOUNT_NOT_FOUND` — the same error whether the id is unknown or belongs to another tenant; existence elsewhere is never revealed |
| 8 | Each account is `POSTABLE` (not a header) and active | `ACCOUNT_NOT_POSTABLE`, `ACCOUNT_INACTIVE` |
| 9 | No account is a control account (AR, AP, Inventory) | `ACCOUNT_CONTROL_MANUAL_FORBIDDEN` |
| 10 | No account is restricted (Retained Earnings, COGS, Rounding) | `ACCOUNT_RESTRICTED` |
| 11 | No account appears on both the debit side and the credit side | `JV_SAME_ACCOUNT_BOTH_SIDES` |
| 12 | **`Σ debit = Σ credit` exactly, at 4 dp** | `JV_UNBALANCED` — the error carries both totals and the difference |
| 13 | `occurredAt` ≤ today (tenant timezone) | `DATE_IN_FUTURE` |
| 14 | `occurredAt` resolves to a fiscal period, and that period is `OPEN` | `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`, `PERIOD_LOCKED` |

Because idempotency runs straight after shape validation ([README](README.md) §4), a replay returns the original voucher even if its period has since closed or one of its accounts has since been deactivated. A replay is not a new posting.

### Why these rules

- **Balanced exactly, never completed.** An unbalanced voucher is the user's error to see, with the difference named. The kernel does not add a line to Suspense or Rounding to make it balance — that is the "auto-correct" the Accounting Guardian refuses outright, and it would turn a typo into a posted misstatement.
- **Two lines minimum; no zero line; one side per line.** [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rule 1 verbatim. A voucher with one non-zero line cannot balance; a zero line is noise that makes the ledger lie about activity.
- **Control accounts are closed to manual JV.** Decided, not deferred: see [coa-standard.md](coa-standard.md) §3. In short — a JV to AR control changes the GL without a customer document, which breaks Invariant 9 immediately, or, with a customer attached, creates a customer balance no receipt can be allocated against. Customer balances move only through customer documents and their reversals. In M2 this has a useful side-effect: with no customer module yet, **nothing can reach AR control at all**, so Invariant 9 cannot be violated before it is enforceable.
- **Same account on both sides rejected.** `Dr 1110 / Cr 1110` has no financial meaning and is how a "balancing" line is smuggled in. Several lines to the same account on the *same* side are allowed — a rent voucher may split one account across two memos.
- **200 lines** is a technical bound on one transaction, not an accounting rule; a larger batch is several vouchers.
- **Future dates are rejected** (tolerance 0 days in the MVP, [periods.md](periods.md) §5). A voucher dated tomorrow is a pre-posting of something that has not happened.

## 4. Entry

The lines as submitted, with account ids as given — the only rule that does not resolve roles.

```
For each payload line:
    Dr <accountId>   debit      (credit column 0.0000)
 or Cr <accountId>   credit     (debit column 0.0000)

Σ debit = Σ credit   exactly
```

Example — the P02 multi-line voucher:

```
Dr 6200 Rent                         45,000.0000
Dr 6300 Office Expenses               1,249.5000
Dr 6400 Utilities                     8,750.5000
    Cr 1120 Bank — Current Account            55,000.0000
                                     ───────────  ───────────
                                     55,000.0000  55,000.0000
```

## 5. Amounts

No computation, therefore **no rounding boundary**. Each amount is the user's, validated at 4 dp. The balance check sums the stored-scale values with `Money.sum` and compares with `Money.equals` — no tolerance.

## 6. Numbering, date and audit

- **Number:** series `JV`, per tenant, per fiscal year of `occurredAt`: `JV-2027-000001`. Assigned after validation; rejected vouchers consume none ([README](README.md) §4).
- **Dates:** `occurred_at` is the business date the user chose and the server validated. `created_at` is server UTC. The period is resolved by the server; the client never names a period.
- **Source:** `source_type = 'journal_voucher'`, `source_id` = the voucher's server-generated id. Because the voucher is the entry, the source-uniqueness constraint is trivially satisfied here; duplicate protection for a JV is **the idempotency key alone**.
- **Audit:** one record, same transaction, carrying the full line set and narration.

## 7. Idempotency

- Required key, per [README](README.md) §4. Three identical submissions produce one voucher and one number (P08).
- **Identical content under a different key is a different voucher.** Two genuine rent payments of the same amount on the same day are two vouchers. The system does not de-duplicate by content; it cannot know intent, and guessing would silently drop a real transaction. (P08 step 5 pins this.)
- Same key, different content → `IDEMPOTENCY_KEY_REUSED`.

## 8. Reversal

A posted JV is corrected only by reversal ([reversal.md](reversal.md)) — through the journal, by a user holding `voucher.reverse`, with a reason. It is the one entry type reversible directly from the journal, because it has no source document of its own. There is no edit and no delete.

## 9. Product Owner question

**PO-Q2 — does a manual journal voucher need a second person to approve it before it posts?**

| | |
|---|---|
| **Option A** — single step (this rule as written) | A user with `voucher.post` posts. Every voucher is audited with its author, and any error is corrected by visible reversal. No extra screen, no date impact on M2 |
| **Option B** — maker–checker now | The creator saves a JV draft; a different user with `voucher.approve` posts it. Adds a JV draft table, an approval screen and a same-user check — roughly 2–3 days on M2, and the demo needs two users per tenant |
| **Council** | **A for the MVP.** Maker–checker is a configurable control ([PRD.md](../PRD.md) §4.2 "approval where configured") and belongs with Wave 2's remaining scope; the MVP's controls are the audit trail and reversal |

## 10. Edge cases

| Case | Behaviour |
|---|---|
| Voucher dated in a closed period | `PERIOD_CLOSED`, naming the period and the current open period. Never redirected automatically — the user chooses a date |
| Voucher dated on the last day of an open period after close has begun | The close takes the period row `FOR UPDATE` ([ADR-0012](../adr/ADR-0012-fiscal-period-locking.md)); the voucher either commits before the close or is rejected after it |
| Voucher dated in the next fiscal year before that year's periods exist | `PERIOD_NOT_FOUND` ([periods.md](periods.md) §6) |
| Account deactivated between form load and submit | `ACCOUNT_INACTIVE`; nothing posted |
| Multi-currency | Not supported. PKR only; the voucher has no currency field |
| Attachments | Not in the MVP |

## 11. Errors

`PAYLOAD_INVALID` · `AMOUNT_NOT_STRING` · `NARRATION_REQUIRED` · `NARRATION_TOO_LONG` · `JV_TOO_FEW_LINES` · `JV_TOO_MANY_LINES` · `AMOUNT_SCALE` · `AMOUNT_NEGATIVE` · `AMOUNT_OUT_OF_RANGE` · `JV_LINE_BOTH_SIDES` · `JV_LINE_NO_SIDE` · `JV_ZERO_LINE` · `ACCOUNT_NOT_FOUND` · `ACCOUNT_NOT_POSTABLE` · `ACCOUNT_INACTIVE` · `ACCOUNT_CONTROL_MANUAL_FORBIDDEN` · `ACCOUNT_RESTRICTED` · `JV_SAME_ACCOUNT_BOTH_SIDES` · `JV_UNBALANCED` · `DATE_IN_FUTURE` · `PERIOD_NOT_FOUND` · `PERIOD_CLOSED` · `PERIOD_LOCKED` · `IDEMPOTENCY_KEY_REUSED`

## 12. Golden

- **P01** — two-line voucher, TB.
- **P02** — four-line voucher with fractional amounts, TB.
- **P03** — every rejection in §3, then a valid voucher numbered `JV-2027-000001`, proving no rejection consumed a number.
- **P07** — period rejections; replay after close.
- **P08** — idempotent retry; key reuse; same content under a new key.
