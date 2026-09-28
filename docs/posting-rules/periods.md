# PERIODS/monthly-v1 and PERIOD_CLOSED@1 — the MVP fiscal calendar

| | |
|---|---|
| **Rules** | `PERIODS/monthly-v1` (calendar), `PERIOD_CLOSED@1` (close, reopen, lock) |
| **Status** | APPROVED — Accounting seat, 2026-09-27 (M2-000) |
| **Implemented in** | M2 — migration 011 `fiscal_periods` + kernel period check |
| **Governed by** | [ADR-0012](../adr/ADR-0012-fiscal-period-locking.md) (lifecycle, two enforcement points, no bypass — this document decides only what ADR-0012 leaves open); [ADR-0006](../adr/ADR-0006-immutable-posted-transactions.md); [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rules 5, 9, 13; Invariant 5 |
| **Golden** | P07 (and every scenario's fixture) |

---

## 1. Model

Twelve **monthly** periods per fiscal year, per tenant, contiguous, non-overlapping, no gaps ([ADR-0012](../adr/ADR-0012-fiscal-period-locking.md)). No 13th adjustment period in the MVP; it would exist only for year-end closing entries, which are deferred (§7).

Every posting resolves to exactly one period from its business date. A date matching no period is rejected; there is no nearest-period fallback and no implicit period creation.

## 2. Fiscal year — July to June, decided

**Default fiscal-year start: 1 July.** Tenant setting `fiscal_year_start_month`, default `7`.

- **Why July.** Pakistan's *normal* tax year under the Income Tax Ordinance, 2001 (s.74) runs 1 July – 30 June, and the federal government's fiscal year is the same. A Pakistani trading business files on that year unless it holds a special tax year, and the legacy reference records the same default (`fiscal_year_start_month … DEFAULT 7`). Choosing January would make every filing straddle two of our fiscal years.
- **Another start month** (a company on a special tax year) is a tenant setting, fixed **before** the tenant's first period is created and immutable once any period exists. Changing it afterwards would move posted entries between years.
- **Year label: the calendar year in which the fiscal year ends.** 1 July 2026 – 30 June 2027 is **FY2027**, matching the FBR's "tax year 2027" convention for the same span. The label appears in document numbers: `JV-2027-000001`.
- **Period name:** the ISO month, `2026-07` … `2027-06`.

## 3. Creation

At tenant creation, in the same transaction as the tenant and its chart ([coa-standard.md](coa-standard.md) §6): the twelve periods of the fiscal year containing the creation date (tenant timezone), all `OPEN`.

- Months of the year already past are created `OPEN` too. A tenant set up in September may need to record July and August; it closes them when it has.
- `BHATTI1` and `BHATTI2` exist before migration 011; they need FY2027 created before M2 is demoable (Database seat, [README](README.md) §5).
- Period creation is master data, not a posting; it writes one audit record.

## 4. Status semantics

Exactly [ADR-0012](../adr/ADR-0012-fiscal-period-locking.md):

| Status | Postings | Leaves by |
|---|---|---|
| `OPEN` | Accepted | close → `CLOSED` (`period.close`) |
| `CLOSED` | Rejected (`PERIOD_CLOSED`) | reopen → `OPEN` (`period.reopen`, reason required); lock → `LOCKED` (`period.close`) |
| `LOCKED` | Rejected permanently (`PERIOD_LOCKED`) | Nothing. No transition out, for any role including migration |

"Postings" includes reversals, every future module, jobs, imports and scripts. No actor bypasses it (ADR-0012 "There is no system bypass").

### 4.1 Order — decided

| Transition | Allowed only when | Error |
|---|---|---|
| Close period P | every earlier period of the tenant is `CLOSED` or `LOCKED` | `PERIOD_CLOSE_OUT_OF_ORDER` |
| Reopen period P | P is `CLOSED` and **no later period** is `CLOSED` or `LOCKED` | `PERIOD_REOPEN_OUT_OF_ORDER`; `PERIOD_LOCKED` if P is locked |
| Lock period P | P is `CLOSED` and every earlier period is `LOCKED` | `PERIOD_LOCK_OUT_OF_ORDER`, `PERIOD_NOT_CLOSED` |

**Why ordered.** A closed month is an assertion that its closing balances are final, and each month's opening balance is the previous month's closing. Closing September while August is open asserts a September opening balance that August can still change. Reopening only the latest closed period keeps the reopen path narrow, as ADR-0012 intends: *"a close-process error found quickly"*.

## 5. Business-date validation

- **Future dates: tolerance 0 days** in the MVP. A posting dated after *today* in the tenant timezone is rejected `DATE_IN_FUTURE`, even if its period is open. Rule 13 requires a configured tolerance; zero is the conservative configuration, and widening it per tenant is a later setting.
- **Timezone:** the tenant's, default `Asia/Karachi` (PKT, UTC+5, no daylight saving). "Today" is computed on the server; the client's clock is never used.
- **Past dates:** any date in an `OPEN` period is accepted.

## 6. The next fiscal year — deferred, with a date

The MVP creates one fiscal year. Creating the next one is a Wave 2 remainder action (`period.close` holder, audited), and it must ship **before 1 July 2027**, or every tenant's postings dated on or after that day are rejected `PERIOD_NOT_FOUND`. The rejection is correct behaviour (no implicit creation), which is exactly why the deadline has to be tracked rather than discovered. Recorded for the board.

## 7. What close does in the MVP

`PERIOD_CLOSED@1`:

1. Takes the period row `FOR UPDATE`, so no posting can commit into it between the check and the transition ([ADR-0012](../adr/ADR-0012-fiscal-period-locking.md)).
2. Checks §4.1 order.
3. Sets `status = CLOSED`, `closed_at` (UTC), `closed_by`.
4. Writes an audit record in the same transaction, and emits `PERIOD_CLOSED` as a logged business event.

**It produces no journal entry.** An entry must have at least two non-zero lines; a monthly close in the MVP has nothing to post.

**Deferred, and stated so nobody assumes it happens:**

| Deferred | Consequence in the MVP |
|---|---|
| Year-end closing entries (income and expense to Retained Earnings) | Income and expense accounts accumulate for the whole fiscal year; Retained Earnings holds nothing. Harmless inside one fiscal year; required before FY2027 closes |
| Close checklist (reconciliations, suspense cleared, Invariant 9 green) | Close is a status change guarded only by order and the row lock |
| 13th adjustment period | None |
| Accruals, prepayments, depreciation runs | None |
| Balance-carry-forward | Not needed: balances are always `SUM(journal_lines)` ([ledger-and-trial-balance.md](ledger-and-trial-balance.md)) |

## 8. Reopen, lock and MFA

ADR-0012 requires MFA enrolment and step-up re-authentication for `period.close` and `period.reopen`. MFA is deferred to pre-production ([GAP-003](../COMPLIANCE_GAPS.md)), which accepts privileged permissions on **staging, with demo data only**, without MFA. Therefore:

- M2 implements all three transitions in the kernel and the database, so Invariant 5 and P07 are fully testable.
- On staging they run under GAP-003's scoped acceptance.
- **Production is blocked** on GAP-003 as it already is. GAP-003's closure list names step-up for `period.reopen`; ADR-0012 also names `period.close`. Reported to the Database/Security seat as an observation rather than edited here.

## 9. Errors

`PERIOD_NOT_FOUND` · `PERIOD_CLOSED` · `PERIOD_LOCKED` · `DATE_IN_FUTURE` · `PERIOD_CLOSE_OUT_OF_ORDER` · `PERIOD_REOPEN_OUT_OF_ORDER` · `PERIOD_LOCK_OUT_OF_ORDER` · `PERIOD_NOT_CLOSED` · `PERIOD_REOPEN_REASON_REQUIRED` · `FORBIDDEN`

## 10. Golden

**P07**: a voucher in August; July and August closed in order; a closed-period posting rejected; a replay after close returning the original; a reversal of the August voucher dated today in September, with August's trial balance unchanged; July locked; reopen of a locked period rejected; a locked-period posting rejected; a date in no period; a future date; an out-of-order close and lock.
