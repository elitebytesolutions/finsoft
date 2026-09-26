# Architecture Decision Records

**Authority:** LEVEL 1 — below [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) (LEVEL 0), alongside [ARCHITECTURE.md](../ARCHITECTURE.md).

An ADR records a decision that the codebase is built on: what was decided, why, what it costs, and how the decision is mechanically enforced. Everything in this directory binds every engineer and every coding agent working on FinSoft.

---

## The rules of this directory

1. **ADRs are LEVEL 1 authority.** They sit under the LEVEL 0 invariants in [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) and above tickets, sprint plans and personal preference. If a ticket asks you to do something an ADR forbids, the ADR wins — stop and flag the conflict.

2. **An agent may not reverse an ADR because it found another approach convenient.** "Microservices would be cleaner here", "FIFO is easier for this report", "let me just bypass RLS for the import job" are not decisions you are authorised to make. Convenience mid-ticket is not evidence.

3. **Superseding an ADR requires a new ADR, approved by the Architecture Guardian** — and by the Accounting Guardian as well where the decision touches accounting, costing, periods or money representation. The new ADR states what it supersedes and why the original trade-off no longer holds.

4. **ADRs are immutable once Accepted.** They are superseded, never edited. A decision that is wrong in hindsight stays on the record with `Status: Superseded by ADR-00NN` so the reasoning trail survives. Correcting typos or adding links is permitted; changing the decision, the rationale or the consequences is not.

   **Whether an edit is a permitted correction is a CATEGORICAL test, not a question of who owns the file.** Ownership does not appear in this rule, and asking "is this mine or the other guardian's?" produces different answers for identical edits on the same day. Ask instead:

   | | |
   |---|---|
   | Did any normative text change — a decision, a condition, a rationale, a consequence? | If yes, **not permitted**. Supersede it. |
   | Did the sentence state something **false about the document's own contents**? | If yes, **permitted**. The record mis-described itself. |
   | Is the text merely redundant, or would you be tidying? | **Not permitted.** Correct is correct. Record the redundancy as debt instead. |
   | Did the sentence describe a **shortfall in the implementation that this record itself booked as debt**, and has that debt since been delivered? | **Permitted**, in the narrow form below, and only in it. |

   A prose count that must agree with a numbered list — "four mechanical conditions accompany it" — is the commonest instance, and the fix is to **delete the count**, not correct it: the list is numbered, the reader can see how many there are, and each correction is a fresh chance to get it wrong. ADR-0021 failed that consistency obligation three times in one day before the count was removed.

   *This test was written on 2026-09-25 at the Database Guardian's direction, after the same categorical question was answered twice by ownership and once by category. Like the partial-supersession rule below, it is a record-keeping convention rather than an architecture decision.*

   **The fourth arm: debt this record booked, since delivered.** An ADR that reports its own implementation as weaker than the decision requires — and books the shortfall in its own Compliance section — opens a loop that something later has to close. When the work lands, the record's description of the gap goes false about the **code** while every normative word in it stays true. None of the first three arms fits: nothing normative changed, the document did not mis-describe *itself*, and leaving it is not tidying — it is a LEVEL 1 record advertising a weakness that no longer exists, which the next implementer will design around. [ADR-0016](ADR-0016-structured-logging-and-observability-package.md) control 2, its debt D8 and the `scid_` format are the first instance. It will recur every time debt recorded in an ADR is paid.

   The correction is permitted under **five** conditions, all of them:

   1. **This record booked it as debt itself.** The trigger is not "the code changed". An ADR's Context and Consequences are full of dated statements about the world as it was, and those are the *evidence for the decision* — `ADR-0016:189`'s "both kernels are currently `export {}`" must never be updated when a kernel gains code, because the acceptance of the transitive observability edge rests on it being true then. What qualifies is only the closed loop the record opened about itself: the honest claim, its own debt entry, and the delivery of that entry.
   2. **The delivery is named, with its mechanism.** Test, constraint, migration, by name — the same bar the Compliance section is held to. A bare "now closed" recreates the unenforced claim the debt entry existed to prevent.
   3. **The gap is put in the past tense, not erased.** The corrected passage says what was weak, until when, and what closed it. A record that says where it was unreliable is more trustworthy than one that reads as having been right all along, and passages written to be honest about a weakness are the last place to introduce a flattering silence. This is the treatment ADR-0020's Alternatives entry got: the retracted reason was kept and named as retracted, not deleted.
   4. **The debt entry is marked delivered and keeps its identifier — it is not deleted.** A list of not-built work containing built work is a false gate, the same defect as a stale "blocked meanwhile" notice, so the entry cannot simply stay as written. But the identifier is cited elsewhere (migrations, tests, wave registers name "D8"), and a register that shows a debt being paid is the evidence that it is maintained. So: dated `CLOSED`, under a heading that carries status. Deletion is correct only where the item was never debt in the first place.
   5. **Line numbering is preserved.** Same reason as the supersession scope notice: `ADR-00NN:LL` citations are written against the as-accepted numbering. Correct **in place**; do not insert or delete lines above a cited one. If the correction will not fit in the lines it replaces, that is a signal the edit has grown past a correction.

   The delivering agent proposes the correction and does not self-authorise it; the Architecture Guardian writes it. That is a matter of who holds the pen on a LEVEL 1 record, not of who owns the file — ownership still decides nothing about the **category**, which is what the table above rules on.

   *The fourth arm was added on 2026-09-25 by the Architecture Guardian, hours after §4's first three arms, on the second gap found in the test in one day: it was written for a document mis-describing itself, and the repository kept producing other shapes. Like §4 and the partial-supersession rule it is a record-keeping convention rather than an architecture decision, and takes the same path — written here, not given an ADR number. The Product Owner may direct otherwise.*

   **One further edit is permitted: a conflict notice.** When a defect is found in an Accepted ADR and its replacement is drafted but not yet Accepted, a notice may be added **at the head** of the Accepted record naming the defective provisions, the ADR that would replace it, and what is blocked meanwhile. This is permitted because the alternative is worse in both directions: marking it `Superseded` by a `Proposed` record would leave the decision with no ADR in force, and recording the defect only in the replacement leaves it invisible to the implementer, who opens the Accepted file. The notice annotates status only — it must not touch the decision, the rationale or the consequences, and the body below it stays exactly as accepted. Where the replacement supersedes the record **entirely**, the notice is removed when the supersession lands and the `Status:` line becomes `Superseded by ADR-00NN`. Where it supersedes **only named provisions**, the notice is replaced rather than removed — the partial case below.

   The lifecycle therefore has two more states than the diagram below shows, and two terminal shapes:

   ```
   total     Accepted → Accepted (conflict notice, pending) → Superseded by ADR-00NN
   partial   Accepted → Accepted (conflict notice, pending) → Accepted (supersession scope notice, permanent)
   ```

   **Partial supersession — the notice is replaced, not removed.** A replacement may supersede only named provisions and leave the rest of the record in force: [ADR-0021](ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md) over ADR-0003's bullets 28 and 110, [ADR-0022](ADR-0022-no-grace-window-on-refresh-rotation.md) over ADR-0009's grace window at :83, :138 and :162. Such a record **does not** become `Superseded by ADR-00NN` — most of it is still the decision in force, and marking the whole record superseded would leave those parts standing on nothing. Neither may the notice simply be deleted: the body below it still states the superseded provisions as unqualified rules, and the notice is the only thing in the file that says otherwise. Deleting it recreates, one step later, the exact failure the notice exists to prevent.

   On acceptance of the replacement, the pending conflict notice is therefore **replaced by a permanent supersession scope notice**, written by the Architecture Guardian, which:

   - states that the named provisions are **no longer in force**, and how each is to be read now;
   - names the superseding ADR as **Accepted**, with its date, and quotes each superseded provision verbatim;
   - **drops all "pending", "would supersede" and "blocked meanwhile" language.** Once the replacement lands nothing is blocked, and a stale block is a false gate;
   - leaves the record's `Status:` line at `Accepted`, and says so, so that no reader concludes the file is dead;
   - **occupies exactly the same number of lines as the notice it replaces.** A head insertion shifts every line below it, and `ADR-00NN:LL` citations in migrations, tests and other ADRs are written against the *as-accepted* numbering. The notice states that offset; changing the notice's length moves every citation in the repository a second time. Preserve the line count.

   Like the conflict notice it annotates status only — the decision, the rationale and the consequences below stay exactly as accepted.

   An Accepted record carrying either notice is **still in force**. Implement it, with the notice's exclusions.

   *The partial-supersession rule was added on 2026-09-25 by the Architecture Guardian, on the directory's second partial supersession. It is a record-keeping convention rather than an architecture decision, and takes the same path §4 itself took — written here, not given an ADR number. The Product Owner may direct otherwise.*

```
Proposed → Accepted → Superseded by ADR-00NN
                    ↘ Deprecated (decision no longer applies, nothing replaces it)
```

5. **A discovered violation of an ADR in existing code is reported, not silently fixed** under an unrelated ticket. Follow §4 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md).

---

## Index

| # | Title | Status | Summary |
|---|-------|--------|---------|
| [0001](ADR-0001-modular-monolith.md) | Modular monolith with Next.js, NestJS and TypeScript | Accepted | One deployable, one database transaction, because a sale must post stock, COGS, revenue, tax, receivable, journal and audit atomically. |
| [0002](ADR-0002-postgresql-and-redis.md) | PostgreSQL as system of record, Redis for cache and queues | Accepted | PostgreSQL holds all truth; Redis holds only what can be thrown away and rebuilt. |
| [0003](ADR-0003-shared-database-multi-tenancy.md) | Shared database, shared schema, `tenant_id` discriminator | Accepted — superseded in part by [0021](ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md) | One schema for all tenants, with cheap operations bought at the price of a harder isolation guarantee — made acceptable by ADR-0004. Decision bullet 28 and Compliance bullet 110 on unique constraints are superseded by ADR-0021; the rest is in force, and a permanent scope notice at the head says which is which. |
| [0004](ADR-0004-postgresql-row-level-security.md) | PostgreSQL Row Level Security as the isolation backstop | Accepted | RLS enabled and forced on every tenant-owned table, with the app role subject to it, beneath three application layers. |
| [0005](ADR-0005-central-double-entry-posting-engine.md) | One central double-entry posting engine | Accepted | Modules raise typed financial events; `packages/accounting-kernel` is the only code that builds journal lines. |
| [0006](ADR-0006-immutable-posted-transactions.md) | Immutable posted transactions, correction by reversal | Accepted | Posted rows are frozen; mistakes are corrected by reversal plus re-entry, never by `UPDATE` or `DELETE`. |
| [0007](ADR-0007-weighted-average-costing.md) | Weighted average as the single costing algorithm | Accepted — conflict, see [0015](ADR-0015-inventory-valuation-is-carried-value.md) | One valuation method system-wide, COGS fixed at the outward movement and stored on the movement row. |
| [0008](ADR-0008-inventory-movement-ledger-and-fefo.md) | Inventory movement ledger and FEFO batch selection | Accepted — conflict, see [0018](ADR-0018-stock-state-scopes-and-locking.md) | The movement ledger is the sole source of quantity; all writes go through the inventory kernel; FEFO decides which batch. The balance row shape, lock ordering and §4's negative-stock policy are pending ADR-0018. |
| [0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) | Short-lived JWT access tokens with rotating refresh tokens | Accepted — superseded in part by [0022](ADR-0022-no-grace-window-on-refresh-rotation.md) | Signed `tenant_id` claim, refresh rotation with reuse detection, server-side revocation, MFA for privileged roles. The grace window at lines 83, 138 and 162 is superseded by ADR-0022; the rest is in force, and a permanent scope notice at the head says which is which. |
| [0010](ADR-0010-transactional-outbox.md) | Transactional outbox for all external side effects | Superseded by [0019](ADR-0019-transactional-outbox.md) | Emails, PDFs, FBR pushes, webhooks and cache invalidation are rows written in the posting transaction and dispatched afterwards. |
| [0011](ADR-0011-money-representation.md) | Money as `numeric` with decimal arithmetic | Accepted | `numeric(19,4)` and `numeric(19,6)`, strings in JSON, a decimal library in TypeScript, half-up rounding once, PKR base. |
| [0012](ADR-0012-fiscal-period-locking.md) | Fiscal period locking with no system bypass | Accepted | `OPEN → CLOSED → LOCKED`, enforced at the posting engine and the database, with no exemption for jobs, imports or scripts. |
| [0013](ADR-0013-kysely-and-sql-migrations.md) | Kysely as the query builder, with hand-written SQL migrations | Proposed | A typed query builder with no schema opinion; migrations stay reviewable SQL, so the database keeps ownership of the compliance surface. |
| [0014](ADR-0014-decimal-js.md) | decimal.js as the single decimal implementation | Proposed | Closes the library choice ADR-0011 deferred; a frozen cloned constructor, half-up away from zero, matching PostgreSQL. |
| [0015](ADR-0015-inventory-valuation-is-carried-value.md) | Inventory valuation is the carried value, not a recomputation | Proposed | WOULD supersede ADR-0007 once accepted; the two statuses change together. The subledger valuation is the sum of stored movement amounts, never quantity x average; the one residual case posts to the rounding account. |
| [0016](ADR-0016-structured-logging-and-observability-package.md) | Structured logging in a dedicated observability package | Accepted | A tenth package beneath everything that logs; pino to stdout as JSON; redaction at one choke point; `sessionCorrelationId` instead of the session id; operational logs are not the audit trail. Debt **D8 closed 2026-09-25** — the guard now refuses a bare UUID; control 2, `:176` and the debt entry corrected in place under §4's fourth arm. |
| [0018](ADR-0018-stock-state-scopes-and-locking.md) | Stock state scopes, lock targets and lock ordering | Proposed | Supersedes ADR-0008 on the balance row shape, the lock protocol and the negative-stock policy. Quantity per tenant/product/location/batch, value per costing scope; coarse-before-fine. **Wave 5 entry gate.** |
| [0019](ADR-0019-transactional-outbox.md) | Transactional outbox for all external side effects | Accepted | Supersedes [0010](ADR-0010-transactional-outbox.md). Same decision, four corrected claims: `correlation_id` is `uuid`; the dispatch index leads with `tenant_id`; **replay is a new row, not a reset**; and consumer deduplication keys on `(tenant_id, topic, effect_key)`, never `outbox.id`. **Blocks `004_create_outbox.sql`; unsigned.** |
| [0017](ADR-0017-stock-availability-enforced-at-posting.md) | Stock availability enforced at posting; negative stock prevented, not costed | Proposed | Availability is checked inside the posting transaction under the ADR-0018 locks, not before saving. Negative balances are an exception state with a monitored report, not a costing mode. |
| [0021](ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md) | When a unique index on a tenant-owned table may omit `tenant_id` | Accepted | Supersedes [0003](ADR-0003-shared-database-multi-tenancy.md) bullets 28 and 110 only. Surrogate primary keys exempt at LEVEL 1; every other global unique index needs a pre-tenant lookup plus the six conditions in §2, one of them a review gate. Unique index enforcement is not subject to RLS. **Unblocks `005_create_sessions.sql`**; signed by the Database Guardian and the Product Owner, 2026-09-25. |
| [0022](ADR-0022-no-grace-window-on-refresh-rotation.md) | Refresh rotation has no grace window | Accepted | Supersedes [0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) lines 83, 138 and 162 only. The window is un-implementable under hash-at-rest and accepts a thief's replay; the client coordinates one in-flight refresh and the loser retries explicitly. **Unblocks `005_create_sessions.sql` and the refresh endpoint**; signed by the Product Owner, 2026-09-25, Database Guardian no objection. |
| [0023](ADR-0023-pre-tenant-authentication-reads.md) | Reading before a tenant is known — authentication's one exception | Proposed | Login takes a tenant code at the form and reads `users` under ordinary RLS, so the password-hash table never carries a cross-tenant policy; only `refresh_tokens` keeps a `SECURITY DEFINER` resolver, owned by a `NOBYPASSRLS` role, returning `(tenant_id, token_id)` and no state. Splits throttling from lockout, superseding [0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) lines 121 and 123. **Blocks `packages/auth`, the auth endpoints and migration 006.** |

---

## Reconciliation

[RECONCILIATION-2026-09.md](RECONCILIATION-2026-09.md) — every claim in ADR-0013, 0014 and 0016 checked against what the repository enforces. Ten mechanisms built, thirteen overstated claims corrected, nine deferrals recorded with reasons. Read it before reviewing any of the three: the corrections change what each record claims, so the version accepted must be the reconciled one.

---

## Writing a new ADR

Copy the shape used by the records here:

```
# ADR-000N: Title

**Status:** Proposed | Accepted | Superseded by ADR-00NN
**Date:** YYYY-MM-DD
**Deciders:** Product Owner, Architecture Guardian[, Accounting Guardian]
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context
## Decision
## Consequences
### Positive
### Negative / accepted costs
## Alternatives considered
## Compliance
## Related
```

The **Compliance** section is not optional and is not prose. It names the test, constraint, trigger, CI check or lint rule that makes the decision mechanically true. A decision nothing enforces is a preference, and preferences do not get ADR numbers.

---

## Related documents

- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — LEVEL 0 invariants
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — system structure, module boundaries, dependency rules
- [../PRD.md](../PRD.md) — product scope
- [../IMPLEMENTATION.md](../IMPLEMENTATION.md) — waves, task contracts, CI gates
