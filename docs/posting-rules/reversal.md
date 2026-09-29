# REVERSAL@1 — reversing a posted entry

| | |
|---|---|
| **Rule** | `REVERSAL@1` |
| **Status** | APPROVED — Accounting seat, 2026-09-27 (M2-000) |
| **Implemented in** | M2 — kernel reversal engine (ARCHITECTURE §3 "Reversal Engine") |
| **Governed by** | [ADR-0006](../adr/ADR-0006-immutable-posted-transactions.md) (the procedure and the date policy — this document decides only what ADR-0006 leaves open); [ADR-0012](../adr/ADR-0012-fiscal-period-locking.md); [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rules 2, 3, 4, 5, 9; Invariant 6 |
| **Golden** | P06, P07, P08, P09 |

---

## 1. What a reversal is

A reversal is a **new journal entry R** that exactly neutralises a posted entry **E**. It is not a financial event of its own — the `FinancialEvent` set is closed and contains none — but a kernel operation that runs the same pipeline as every posting: idempotency, period resolution and check, numbering, balance assertion, insert, audit ([ADR-0006](../adr/ADR-0006-immutable-posted-transactions.md): *"Post R through `postingEngine.post(...)` — the normal path"*). R records `posting_rule = 'REVERSAL@1'` and the same `event` as E, so a report that groups by event nets the pair.

## 2. Entry

For every line of E, in E's order, R has one line with:

```
same account          same party dimension (customer)
same amount           debit and credit SWAPPED
```

```
E  (JE-2027-000001, SALE_POSTED/service@1, 2026-09-15)
   Dr 1200 AR control  [CUST-A]   10,000.0000
       Cr 4200 Service Revenue              10,000.0000

R  (RV-2027-000002, REVERSAL@1, reversal_of = JE-2027-000001)
   Dr 4200 Service Revenue        10,000.0000
       Cr 1200 AR control [CUST-A]          10,000.0000
```

**Amounts: no rounding boundary.** R copies E's *stored* amounts. It never re-runs E's posting rule, never recomputes from the source document, and never adds a line — not even a rounding line; if E contained a rounding line, R reverses that line like any other. A rule change after E was posted therefore cannot make R differ from E. R has exactly as many lines as E.

**Invariant 6, per account and per party:** for every account and every customer, `Σ(E.debit − E.credit) + Σ(R.debit − R.credit) = 0.0000`.

## 3. Preconditions

| # | Rule | Error |
|---|---|---|
| 1 | E exists in the caller's tenant | `ENTRY_NOT_FOUND` (same whether unknown or another tenant's) |
| 2 | E is `POSTED` — not already `REVERSED` | `ALREADY_REVERSED`, naming the existing reversal |
| 3 | E is not itself a reversal (`E.reversal_of is null`) | `REVERSAL_OF_REVERSAL` |
| 4 | If E has a source document, the reversal comes through that document's module (§5) | `REVERSAL_VIA_SOURCE_REQUIRED` |
| 5 | A reason: non-empty after trimming, ≤ 500 characters | `REVERSAL_REASON_REQUIRED` |
| 6 | The actor holds `voucher.reverse` (plus any document permission the module requires) | `FORBIDDEN` |
| 7 | R's date (§4) resolves to an `OPEN` period | `PERIOD_CLOSED`, `PERIOD_LOCKED`, `PERIOD_NOT_FOUND` |
| 8 | The source document's own preconditions (e.g. an invoice with live allocations — [service-sale.md](service-sale.md) §7) | the module's error |

## 4. The date of R — decided

[ADR-0006](../adr/ADR-0006-immutable-posted-transactions.md) fixes the policy (R goes into an open period, never back-dated into a closed one). The M2-000 decision is the exact date, so that R is deterministic and not a user choice:

```
E's period is OPEN                → R.occurred_at = E.occurred_at
E's period is CLOSED or LOCKED    → R.occurred_at = today (tenant timezone)
                                     and today's period must be OPEN, else rejected
```

**Why E's own date while its period is open.** ADR-0006: *"R is posted in that same period. Net effect: as if E never happened."* Using E's date makes that true for **every** report, not only period reports — an account ledger or trial balance for any date range, including one ending mid-period, shows the pair netting to zero from the day E took effect. A reversal dated "today" in the same period would leave E's effect visible on every day between E's date and today, which is not "as if E never happened".

**Why today, and not "the first open period", once E's period has closed.** "First open period after E" could be a month that is open only because nobody has closed it yet, and it would force an arbitrary day inside that month. Today is the date on which the correction is actually made and disclosed, it is always in the period the business is working in, and it is what ADR-0006 means by *"the CURRENT OPEN period"*. If today's own period is closed (an early close), the reversal is rejected with `PERIOD_CLOSED`; it is never redirected to some other open period.

**Disclosure.** When R is dated today for an E in a closed period, R's narration and the ledger both show `Reversal of JE-… (2026-08, CLOSED): <reason>`. The closed period's figures do not change — P07 asserts its trial balance is identical before and after R.

**One consequence, accepted.** Because R takes E's date while E's period is open, an account ledger ordered by business date can show an intra-day running balance on the "wrong" side — e.g. an invoice reversed after a receipt against it had also been reversed ([ledger-and-trial-balance.md](ledger-and-trial-balance.md) §2, P09). Every end-of-day balance is correct. The ordering is stated, not hidden.

## 5. Reversing a document versus reversing a journal entry — decided

| E's source | How it is reversed |
|---|---|
| `journal_voucher` (manual JV) | Directly, from the journal, by a user with `voucher.reverse` |
| A source document (`sales_invoice`, `customer_receipt`, and every later module document) | **Only through that document's module** — "reverse invoice", "reverse receipt". The module, in one transaction: checks its own preconditions, asks the kernel to reverse E, sets the document's status `POSTED → REVERSED`, and undoes its subledger effects (allocations voided, and from Wave 5 stock movements reversed through the inventory kernel) |
| A reversal R | Never. §6 |

**Why.** Invariant 6 requires R to neutralise *every* ledger, not only the GL. The kernel can reverse journal lines; it cannot know what a receipt's allocations or a sale's stock movements were. A GL-only reversal of an invoice would leave the invoice `POSTED` with an outstanding balance the GL no longer has — an Invariant 9 break created by the reversal itself. The kernel therefore refuses a direct reversal of a document-sourced entry with `REVERSAL_VIA_SOURCE_REQUIRED`, and the call path through the module is the only one. Its exact API shape is the Architecture seat's.

**Document status.** A reversed document keeps its number, its lines and its date; its status becomes `REVERSED`, with `reversed_at`, `reversed_by` and the reason. It is never deleted and never returns to `DRAFT`. A corrected invoice is a **new** document with a new number (ADR-0006 step 3).

## 6. Reversal of a reversal — decided: rejected

R cannot be reversed. To reinstate the effect of E after it was reversed, post a new, corrected entry C (a new JV or a new document).

- **Why.** Reversing R would re-create E's effect with no document behind it: for an invoice, AR and revenue would come back while the invoice stays `REVERSED`. Allowing it would also require E's status to move `REVERSED → POSTED`, which ADR-0006 does not permit — `POSTED → REVERSED` is the only transition. Depth-one chains keep every entry's meaning answerable from the entry itself.
- **Enforced** by precondition 3 and by `UNIQUE (reversal_of)` (one R per E), plus source uniqueness on `(tenant_id, 'reversal', E.id)`.

## 7. Idempotency

- Required key, per [README](README.md) §4. A replay returns R.
- `source_type = 'reversal'`, `source_id = E.id` — the uniqueness constraint makes "one reversal per entry, ever" a database fact.
- A second reversal of E under a new key → `ALREADY_REVERSED` (P06).

## 8. Numbering, status and audit

- R is numbered in series `RV`, fiscal year of R's date: `RV-2027-000001`.
- E: `status POSTED → REVERSED`, `reversed_by = R.id`, `reversed_at = now()` (UTC). This is the only update ever applied to a posted entry, and the immutability trigger permits nothing else ([ADR-0006](../adr/ADR-0006-immutable-posted-transactions.md)).
- R: `status POSTED`, `reversal_of = E.id`, `reversal_reason`.
- Audit, same transaction: the insert of R (with reason and E's id) and E's status transition. When a module reverses a document, it also audits the document's transition.

## 9. Reports

Both E and R stay in every ledger and in the trial balance, forever. The ledger sums every entry regardless of status — E contributes, R contributes the opposite, the pair nets to zero. A report that **excluded** `REVERSED` entries while including R would count the correction twice ([ledger-and-trial-balance.md](ledger-and-trial-balance.md) §1). A "hide reversed" view is presentation only and hides E and R together.

## 10. Edge cases

| Case | Behaviour |
|---|---|
| Partial reversal | Not supported. A reversal is always the whole entry. A partial correction is a full reversal plus a new entry |
| E in a closed period, today's period closed too | Rejected `PERIOD_CLOSED`. Open today's period, or wait; never back-dated |
| E in the previous fiscal year | Same rule: E's period is closed (or will be), so R takes today's date in the current year. Not reachable in the MVP, which has one fiscal year |
| E in a period that was closed and then reopened | The rule looks only at the status of E's period at the moment of reversal: reopened means `OPEN`, so R takes E's date |
| Concurrent reversal of the same E | The second waits on the uniqueness constraint, then returns the first's R if it had the same key, or `ALREADY_REVERSED` |
| Reversal requested by a job or an AI | Not possible. Reversal is a user action with `voucher.reverse` (rule 22) |

## 11. Errors

`ENTRY_NOT_FOUND` · `ALREADY_REVERSED` · `REVERSAL_OF_REVERSAL` · `REVERSAL_VIA_SOURCE_REQUIRED` · `REVERSAL_REASON_REQUIRED` · `FORBIDDEN` · `PERIOD_CLOSED` · `PERIOD_LOCKED` · `PERIOD_NOT_FOUND` · `IDEMPOTENCY_KEY_REUSED`

## 12. Golden

- **P06** — receipt reversal, invoice reversal, `INVOICE_HAS_LIVE_ALLOCATIONS`, `REVERSAL_VIA_SOURCE_REQUIRED`, `REVERSAL_OF_REVERSAL`, `ALREADY_REVERSED`, `REVERSAL_REASON_REQUIRED`, replay; TB to zero.
- **P07** — reversal of an entry in a closed period, dated today; the closed period's TB unchanged.
- **P09** — reversals inside the full journey; the ledger ordering consequence in §4.
