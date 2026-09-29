# REPORT/account-ledger@1 and REPORT/trial-balance@1

| | |
|---|---|
| **Rules** | `REPORT/account-ledger@1`, `REPORT/trial-balance@1` (and the customer ledger, M3) |
| **Status** | APPROVED — Accounting seat, 2026-09-27 (M2-000) |
| **Implemented in** | M2 — account ledger + trial balance; M3 — customer ledger |
| **Governed by** | [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rules 11, 19 and Invariant 2; [ADR-0006](../adr/ADR-0006-immutable-posted-transactions.md) ("report definitions filter by status centrally") |
| **Golden** | Every scenario's `trialBalance` checkpoints; P05, P06, P09 `customerLedger` |

Not a posting rule, but the definitions every golden checkpoint is written against, so they belong with the rules. A report that needs to adjust a number is reporting a bug ([IMPLEMENTATION.md](../IMPLEMENTATION.md) Wave 8).

---

## 1. Source and inclusion

- **Source:** `journal_lines` joined to `journal_entries`, read directly. **No cached balance exists in M2**; none is needed at MVP volumes, and a cache would need its own reconciliation job (rule 11). If one is ever added, it is written only by the kernel and reports never read it where it disagrees with the ledger.
- **Inclusion:** every journal entry, `POSTED` **and** `REVERSED`. The reversed original and its reversal are both real postings and net to zero. Excluding `REVERSED` entries while including their reversals double-counts the correction; excluding both hides history. The central filter is "all entries", and no report overrides it.
- **Dates:** by `occurred_at` (the business date), never `created_at`.
- **Tenant:** the caller's, by RLS. No report takes a tenant parameter.

## 2. Account ledger

For one account, a date range `[from, to]`, and optionally one party (for a control account):

```
opening balance   = Σ (debit − credit) of lines with occurred_at < from
each line         = date · entry number · source document number · narration ·
                    debit · credit · running balance · reversal marker
closing balance   = opening + Σ (debit − credit) in range
```

- **Order:** `occurred_at`, then the entry's `created_at`, then entry number. Stated because it has a visible consequence: a reversal dated at its original's date ([reversal.md](reversal.md) §4) sorts beside the original, and the running balance *within a day* can pass through a figure no end-of-day balance ever shows. P09 pins it.
- **Sign:** running balance is computed debit-positive; displayed as an amount with `Dr` or `Cr`. The account's normal balance does not change the arithmetic.
- **Reversal marker:** the original shows "reversed by RV-…", the reversal shows "reverses JE-… — reason". A "hide reversed" view removes both lines of a pair together, never one.

**Customer ledger (M3)** is the account ledger of `AR_CONTROL` filtered to one customer party. It is not a separate store; its balance and the Invariant 9 subledger figure are two independent computations that must agree ([customer-receipt.md](customer-receipt.md) §8).

## 3. Trial balance

As of a date `D` (MVP form):

```
for each POSTABLE account with at least one line dated ≤ D:
    net = Σ debit − Σ credit   (occurred_at ≤ D)
    net > 0  → Debit column = net,   Credit column = 0.0000
    net < 0  → Debit column = 0.0000, Credit column = |net|
    net = 0  → both 0.0000   (the row is shown: the account had activity)

Total debit  = Σ Debit column
Total credit = Σ Credit column
Total debit  = Total credit        exactly — Invariant 2
```

- The column follows the **sign of the balance**, not the account's normal balance: an overdrawn bank appears in the Credit column.
- Header accounts carry no lines; grouping rows under headers with subtotals is presentation and does not change the totals.
- Balances are **inception-to-date**. In the MVP there is one fiscal year and no year-end close, so inception-to-date and year-to-date coincide. When year-end close arrives, income and expense accounts will start each year at zero *because closing entries moved them*, not because the report filters by year.
- **Period-movement form** (for Invariant 2 per period): the same arithmetic over lines dated inside one period. It balances because every entry lies wholly inside one period.

**Invariant 2 as the suite checks it:** for every tenant and every period P, the movement form over P balances, and the as-of form at P's end date balances. Both exactly.

## 4. Rounding

None. Every figure is a sum of stored `numeric(19,4)` values. Presentation at 2 dp, if a screen chooses it, rounds each displayed figure half-up **for display only**; totals are summed at 4 dp and then displayed, never summed from displayed values.
