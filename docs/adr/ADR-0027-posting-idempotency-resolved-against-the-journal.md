# ADR-0027: Posting idempotency is resolved against the journal, with one numbering savepoint

**Status:** Accepted — 2026-09-28
**Date:** 2026-09-28
**Deciders:** Architecture seat, Accounting seat ([ADR-0024](ADR-0024-operating-model.md))
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Supersedes:** [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) **in part: pipeline step 2, at ADR-0005:56, and nothing else.** It also clarifies ADR-0005:48 (*"The kernel never opens its own"*) without changing it. Line numbers are as-accepted; ADR-0005's permanent scope notice adds +21. The rest of ADR-0005 stays in force, including the field table (:39–:48), steps 1 and 3–11, and the `UNIQUE (tenant_id, idempotency_key)` in its Compliance section (:165), which is the index this record resolves against.

*Not the "ADR-0027" planned by the M3 design pack for module packaging and runtime (`docs/design/M3/README.md` §6, on `feature/M3-000b-design-pack`). That record is renumbered **ADR-0028** by orchestrator decision, 2026-09-28. This number was assigned here first.*

## Context

ADR-0005:56 specifies step 2 as *"idempotency: INSERT (tenant_id, idempotency_key) → on conflict, return prior result"*: a key recorded before the period check, then everything else. That reads as a key record that exists before the entry does.

M2-A (`feature/M2-A-accounting-core`) made `journal_entries` itself the idempotency record. Migration 012 carries `journal_entries_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key)` beside `request_fingerprint`, retained forever ([posting-rules README](../posting-rules/README.md) §4). There is no separate key table. A `journal_entries` row cannot exist before step 8 gives it an `entry_number`, which is `NOT NULL` and unique per tenant. **So step 2 as written cannot be implemented against the journal.** The write that detects a duplicate is the step-9 INSERT, and by then step 8 has consumed a number from the `document_sequences` row it holds `FOR UPDATE` (migration 013).

That opens a race. On a double-click, request B passes a step-2 lookup while A is uncommitted. B waits on the counter row and takes the next number once A commits. Only then does B's INSERT meet A's row. Without something to give the number back, B's caller commits a **gap** in the series, which README §4 forbids: *"A rejected or rolled-back posting consumes no number."* The M2-A draft caught SQLSTATE 23505 instead. That aborts the caller's transaction, and its follow-up query failed with 25P02: a kernel cannot answer "replay" from a transaction it has just poisoned.

Two alternatives were considered and rejected:

- **ADR-0005 as written: a separate idempotency-key table, inserted at step 2.** Duplicates would serialise before numbering, so no savepoint would be needed. But it adds a second tenant-owned table recording a fact `journal_entries` already records under a unique index, with its own migration, RLS and grants. It also needs a key → entry pointer written after step 9. That makes two records of one truth, and they can disagree.
- **Assign the number after the INSERT.** `entry_number` would have to be nullable or a placeholder, then `UPDATE`d on a posted row. The immutability trigger (ADR-0006) forbids that, and it should.

## Decision

1. **The journal is the idempotency record.** Idempotency is resolved against the `(tenant_id, idempotency_key)` unique index on `journal_entries`. No other table records a posting key.
2. **Step 2 is a lookup, not an insert.** Before the period gate, the kernel reads `journal_entries` by `(tenant_id, idempotency_key)`. If the fingerprint is the same, it is a **replay**: it returns the prior result, marked `REPLAYED`, and writes no entry, number or audit record. If the fingerprint differs, it is `IDEMPOTENCY_KEY_REUSED` and nothing posts. Then it reads by `(tenant_id, source_type, source_id)`: a match is `SOURCE_ALREADY_POSTED`. A replay returns the prior result even after that result's period has closed, because a replay is not a posting.
3. **Numbering and the entry INSERT sit inside one named kernel savepoint.** The kernel issues `SAVEPOINT finsoft_posting_number` immediately before step 8. The step-9 INSERT is `ON CONFLICT DO NOTHING`. If it writes the row, the kernel issues `RELEASE SAVEPOINT`. If it writes nothing, the kernel issues `ROLLBACK TO SAVEPOINT`, which returns the number to the counter, then `RELEASE`. It then re-runs statement 2's lookup and answers exactly as it would have if the winner had been visible at step 2. If neither the key nor the source matches, that is a `KernelInvariantError`, never a silent success. No exception is raised or caught for the conflict.
4. **That savepoint is the only transaction control the kernel issues.** ADR-0005:48 stands: the caller owns `tx`, and the kernel never opens, commits or rolls back a transaction. Inside `tx`, the kernel may issue exactly three statements, all naming `finsoft_posting_number`: `SAVEPOINT`, `RELEASE SAVEPOINT` and `ROLLBACK TO SAVEPOINT`. At most one is open at a time, and it is never nested. Nothing in `packages/accounting-kernel` issues `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `ABORT`, `SET TRANSACTION`, `PREPARE TRANSACTION`, any other savepoint name, or a query-builder transaction or savepoint API. The name `finsoft_posting_number` is reserved to the kernel, and callers must not use it.
5. **Step order in the kernel is fixed:** shape → idempotency lookup → period → accounts (rule, accounts, parties, lines) → balance → number → insert (entry, then its lines) → audit. This is ADR-0005's order with step 2's mechanism replaced. Only shape validation runs before the idempotency lookup. After the insert, only the entry's lines, its read-back and the audit write run. Posting and reversal share this one pipeline.

## Consequences

**Positive**

- **No number gap on a lost race.** The concurrent loser rolls back to the savepoint before it commits anything. This is mutation-proven: a mutant that leaked the number survived while the suite ran on a one-connection pool, and the suite now races on real backends so the mutant fails (Compliance 3).
- One record of each key's truth. No pointer can disagree with the entry it points at.
- The replay path raises no exception. The caller's transaction stays usable, and a replay is an ordinary return.
- Reversals get the same guarantee without further code, because they run the same pipeline.

**Negative / accepted costs**

- The kernel is no longer free of transaction control. One subtransaction is now part of its public behaviour, and it holds a reserved savepoint name.
- The loser of a race runs steps 3–7 and waits on the counter row before it learns it lost. That wait is bounded by the winner's transaction. This is accepted: duplicates are rare, and correctness does not depend on how long the loser waits.
- The step-2 SELECT takes no lock. Correctness under concurrency rests entirely on the unique index plus `ON CONFLICT`. Removing either one reopens double-posting, which is why Compliance names both.
- `ON CONFLICT DO NOTHING` has no conflict target, because PostgreSQL accepts one arbiter per clause and both the key and the source must arbitrate. So it also absorbs conflicts on `entry_number` and `reversal_of`. Statement 3's re-lookup must name the winner or raise. It must never return success for a conflict it cannot name.

## Compliance

All references are to `feature/M2-A-accounting-core`.

| # | Mechanism |
|---|---|
| 1 | Migration 012 `journal_entries_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key)`. `tests/accounting/posting-invariants.ts`, Invariant 8: *"three sequential identical requests: one entry, one number, one posting audit record"* |
| 2 | `lookUpPriorRequest` in `packages/accounting-kernel/src/posting-engine.ts` runs before `resolveOpenPeriod`. The same Invariant 8 test asserts `IDEMPOTENCY_KEY_REUSED` on changed content. Golden `posting-p08-idempotent-retry.json` covers key reuse and source uniqueness. Golden `posting-p07-closed-period.json` covers a replay after close, which returns `REPLAYED` |
| 3 | `openNumberingSavepoint` / `releaseNumberingSavepoint` / `rollbackNumberingSavepoint` and `insertJournalEntryIfAbsent` (`onConflict … doNothing`) in `packages/accounting-kernel/src/queries/journal-writes.ts`, called at steps 8–9 of `runPostingPipeline`. Invariant 8: *"a genuinely concurrent duplicate replays, and consumes no number (no gap)"* forces the race and asserts that the next voucher takes A's number + 1. *"a concurrent request reusing the key with different content is refused"* covers the refusal. `tests/accounting/financial-invariant-suite.spec.ts` runs these on a four-connection pool, and its header records the leaking mutant that survived on a pool of one |
| 4 | **Partly enforced today.** ESLint confines `sql` tags and query builders in the kernel to `src/queries/**` (`tests/security/lint-boundaries.spec.ts`, *"catches an sql`` tag in kernel business logic"*). Nothing restricts statement text inside `src/queries/**`, and that spec currently *accepts* `` sql`SAVEPOINT s` `` in `journal-writes.ts`. **Condition K1, which binds the M2-A merge, not this record:** an ESLint rule on `packages/accounting-kernel/src/**` rejects (a) any `sql` template whose text matches a transaction-control keyword, unless it is one of the three exact `finsoft_posting_number` statements in `queries/journal-writes.ts`; and (b) any `.transaction(`, `.startTransaction(`, `.savepoint(`, `.rollbackToSavepoint(` or `.releaseSavepoint(` call. `lint-boundaries.spec.ts` gains a positive case and negative cases, and the `SAVEPOINT s` case flips to rejected |
| 5 | `runPostingPipeline` is the single path for `post` and `reverse`, and the steps sit in that order in one function. The order-dependent behaviour is tested by 2 (lookup before period) and 3 (number after balance and before insert). A change to the order needs the Architecture and Accounting seats (ADR-0005 §Governance, CODEOWNERS on the kernel) |

## Signatures

| Seat | Verdict |
|---|---|
| **Architecture seat** | ✅ **APPROVED, 2026-09-28.** Author. The ruling was given in the M2-A review, after reading `posting-engine.ts`, `queries/journal-writes.ts` and the Invariant 8 concurrency tests on `feature/M2-A-accounting-core`. Condition K1 binds the M2-A merge, not this record. |
| **Accounting seat** | ✅ **APPROVED in its M2-A Council review 2026-09-28 (savepoint approach is accounting-equivalent).** |
