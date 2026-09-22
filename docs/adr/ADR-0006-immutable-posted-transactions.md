# ADR-0006: Immutable posted transactions, correction by reversal

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

The legacy system edited records in place after posting and hard-deleted transactions. The consequences are the design brief ([PRD.md §3](../PRD.md)): a trial balance that once tied and no longer does, with no way to establish when it stopped or what changed it; a `MUSER`/`MTIME` pair that records who touched a row last but not what it said before; reports that grew their own correction logic to paper over the drift.

An edit to a posted record is not a small act. It silently invalidates every artefact derived from the old value: a filed FBR return, a printed customer statement, a bank reconciliation, a stock valuation, a management account someone made a decision on. None of those are recalled when the row changes.

Rules 2, 3 and 4 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) are LEVEL 0 on exactly this point. This ADR states how they are made mechanically true.

## Decision

**Once `status = POSTED`, the record is frozen. Corrections are made by reversal plus re-entry. Hard delete does not exist for financial or operational records.**

### What is frozen

Any field that affects financial meaning: amount, account, date, party, currency, quantity, cost, tax code, reference. When in doubt, the field is financial (rule 2).

The only permitted transition on a posted record:

```
POSTED → REVERSED      by creating a reversal entry, never by editing
```

Non-financial metadata — an internal note, an attachment — may be appended if and only if the change is itself audited.

Records covered: journal entries and lines, stock movements, sales, purchases, receipts, payments, cheques, invoices, returns, adjustments, audit records, and any table they reference (rule 4).

Draft records that have never been posted may be edited and may be deleted, and that deletion is itself audited. `DRAFT` is the only mutable state a financial document ever has.

### The correction procedure

```
Original entry E, posted, discovered to be wrong
      │
      ├─ 1  Create reversal R for E
      │       same accounts, opposite debit/credit, exactly equal magnitudes
      │       reference: { reversalOf: E.id, reason: <required, audited> }
      │
      ├─ 2  Post R through postingEngine.post(...)   ← the normal path, ADR-0005
      │       E.status      → REVERSED
      │       E.reversed_by → R.id
      │       E.reversed_at → now (UTC)
      │
      └─ 3  Create the corrected entry C with the right figures. Post C.

E, R and C all remain visible forever. Nothing is hidden, nothing is tidied away.
```

R must **exactly** neutralise E's financial impact — every ledger, every subledger, every stock quantity, every cost effect (FinancialInvariantSuite Invariant 6). A reversal that "mostly" reverses is a second error.

A reversal is a posting like any other: it requires the `voucher.reverse` permission, it resolves a fiscal period, it gets its own document number, and it writes its own audit record in the same transaction.

### Reversal date policy

This is the part that gets decided wrongly under pressure, so it is stated plainly:

> **A reversal is posted into an open period. It is never back-dated into a closed period.**

```
E posted in a period that is still OPEN
    → R is posted in that same period. Net effect: as if E never happened.

E posted in a period that is now CLOSED or LOCKED
    → R is posted in the CURRENT OPEN period.
    → The prior-period effect is DISCLOSED — it appears in the current period's
      movement with the reversal reason and a reference back to E.
    → It is NOT back-dated. Not by an admin, not by a script, not by reopening
      the period "just for this one".
```

The reason is not bureaucratic. A closed period's numbers have been reported — to the owner, to the FBR, to a bank. Back-dating a reversal changes a number that has already been relied upon, and does so invisibly, because the report was correct when it was produced. Disclosing the correction in the current period keeps both truths intact: what was reported then, and what is true now.

Reopening a closed period is a separate, high-privilege, audited action requiring `period.reopen` (ADR-0012). It exists for a genuine close-process error found immediately, not as a route around this policy. A `LOCKED` period is never reopened at all.

### Three-layer enforcement

Each layer catches a different class of mistake, and all three are required:

```
1  Database trigger      catches everything, including psql, migrations
                         and any future writer
2  Application guard     gives a domain error with a usable message, before
                         the write is attempted
3  Invariant test        proves layers 1 and 2 still work, on every PR
```

**1 — Database trigger.** A `BEFORE UPDATE` trigger on each posted-record table rejects any change to a protected column where the existing row's `status = 'POSTED'`, allowing only the `POSTED → REVERSED` transition and the audited metadata fields:

```
BEFORE UPDATE ON journal_entries:
  IF OLD.status = 'POSTED' AND (
       NEW.amount     IS DISTINCT FROM OLD.amount     OR
       NEW.account_id IS DISTINCT FROM OLD.account_id OR
       NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR … )
  THEN RAISE EXCEPTION 'posted record is immutable (ADR-0006)';

BEFORE DELETE ON journal_entries, journal_lines, stock_movements, …:
  RAISE EXCEPTION 'hard delete is forbidden (ADR-0006, rule 4)';
```

Plus: `DELETE` is revoked from the application role on these tables, and `ON DELETE CASCADE` is forbidden on any financial relationship — financial foreign keys are `ON DELETE RESTRICT` (rule 4), so a cascade cannot delete a posted row by reaching it sideways.

**2 — Application guard.** Repository and domain guards in `packages/accounting-kernel` and `packages/inventory-kernel` refuse to construct an update command against a posted aggregate, and refuse `delete` on any covered entity. Their job is a clear domain error naming the record and pointing at reversal — not security, which is layer 1's job.

**3 — Invariant test.** FinancialInvariantSuite Invariant 4 (a posted transaction cannot be modified) and Invariant 6 (a reversal exactly neutralises the original) run on every PR, exercising the real database so the trigger itself is under test.

## Consequences

### Positive

- History is reconstructable. Every figure ever reported can be reproduced as of the date it was reported, from the ledger alone (rule 9, [PRD.md §10](../PRD.md) criterion 3).
- A correction is visible as a correction. Nobody has to infer from a changed row that something went wrong; R carries a required reason.
- Removes an entire class of incident: there is no `UPDATE` statement that can quietly change a filed number, because the database refuses it.
- Auditors get evidence from the system alone — original, reversal and re-entry, all linked, all timestamped, all attributed.
- Concurrency is simpler: posted rows never change, so cached balances and derived reports only ever need to account for new rows, not mutated ones.

### Negative / accepted costs

- More rows. A corrected transaction is three documents where a naive system has one. Accepted; storage is cheaper than doubt.
- Users must learn that "edit" is not available after posting, and the UI has to make reversal obvious and low-friction so the rule does not feel punitive.
- Reports must handle reversed entries explicitly — a ledger shows E, R and C, and a naive `SUM` that ignores status is wrong in a new way. Report definitions in `packages/reporting` filter by status centrally.
- A typo in a posted document (a misspelled narration, a wrong internal note) is corrected either as audited metadata or by reversal — there is no cheap path for cosmetic errors on financial fields.
- Prior-period corrections land in the current period, which requires disclosure in management reporting and can surprise a reader who expects the old period to restate. That is the intended trade.
- Data-fix requests from the business have no technical shortcut. Every one goes through the reversal process, which takes longer and is correct.

## Alternatives considered

**Edit posted records, with an audit log capturing the before/after.** Rejected. The audit log would record the change, but every downstream artefact derived from the old value remains wrong with nothing to flag it, and the ledger no longer ties to what was reported. An audit trail of mutations is not the same as an immutable ledger.

**Soft delete (`deleted_at`) on posted records.** Rejected. A soft-deleted posting is a posting that vanishes from every report without a balancing entry, which breaks the trial balance silently. Removing financial effect requires a reversal that is itself a posting.

**Versioned rows — keep every revision, report against the latest.** Rejected. It preserves history but still means a reported figure changes retroactively, with no disclosure at the point where someone relied on it. It also multiplies the complexity of every join and every invariant check for no gain over reversal.

**Allow back-dating a reversal into a closed period when a supervisor approves.** Rejected, and specifically rejected as a "with sufficient permission" exception. A closed period's figures have been reported; permission does not un-report them. The reopen path (ADR-0012) exists for close-process errors and is audited, deliberately narrow, and not a substitute for disclosure.

**Allow hard delete of same-day mistakes before the period closes.** Rejected. "Same day" is not a property the database can verify against a document that was already printed, emailed or pushed to the FBR. Drafts are deletable; posted records are not.

## Compliance

- Database triggers on every posted-record table rejecting protected-column `UPDATE` where `status = 'POSTED'`, and rejecting `DELETE` unconditionally.
- `DELETE` privilege revoked from the application role on all financial and operational tables; asserted by a schema test over `information_schema.role_table_grants`.
- Schema test: no financial foreign key uses `ON DELETE CASCADE`; all use `ON DELETE RESTRICT` (rule 4).
- Schema test: `audit_log` grants `INSERT` only, with a trigger rejecting `UPDATE`/`DELETE` (rule 9).
- FinancialInvariantSuite Invariant 4 — a posted transaction cannot be modified. Exercised against the real database, so the trigger is the thing under test.
- FinancialInvariantSuite Invariant 6 — a reversal exactly neutralises the original's impact across GL, subledgers, stock quantity and cost.
- Test: a reversal of an entry in a closed period is asserted to post into the current open period, and an attempt to back-date it is asserted to be rejected by both the posting engine and the database (rule 5, ADR-0012).
- Lint rule: `.delete(` / `DELETE FROM` against covered tables is forbidden outside migrations; drafts are removed through an audited `deleteDraft` helper only.
- Every reversal requires `voucher.reverse`, a non-empty reason, and writes an audit record in the same transaction; asserted by an integration test.

## Related

- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — reversals post through the same engine as everything else
- [ADR-0012](ADR-0012-fiscal-period-locking.md) — which periods can receive a reversal, and the `period.reopen` permission
- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — stock movements are append-only for the same reason
- [ADR-0007](ADR-0007-weighted-average-costing.md) — why cost is never recomputed retroactively
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 2, 3, 4, 5, 9; §4 what to do when you hit a violation
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §3 reversal engine, §9 audit architecture
- [../PRD.md](../PRD.md) — §3 legacy failures being replaced
