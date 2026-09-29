# Technical debt

Known, accepted shortcomings that are **not** LEVEL 0 compliance gaps.

**Authority: LEVEL 3.** Appended by ordinary pull request. Owner: Architecture
Guardian, with the relevant specialist guardian named per item.

**This is not [COMPLIANCE_GAPS.md](COMPLIANCE_GAPS.md).** That file is scoped to
partial enforcement of a [NON_NEGOTIABLE](NON_NEGOTIABLES.md) — GAP-001, where a
control exists but nothing makes it binding. An item belongs *here* when it is a
real shortcoming that violates no invariant: an unset parameter, a measurement
not yet taken, a redundancy that cannot be tidied because the record is frozen.

**Why a separate file rather than the wave registers.** A wave register closes
when its wave does. The `users` table-level `UPDATE` finding was raised during
the migration 004 review and is still open two waves later, discoverable only by
whoever remembers which register it landed in. Debt that outlives its wave needs
an address that does not move.

Each entry states **what**, **why it is accepted**, **who owns it**, and **what
would force it**. An entry with no forcing condition is a wish, not debt.

---

## TD-001 · `lock_timeout` is set nowhere — RESOLVED

**RESOLVED, M1-D.** [ADR-0020](adr/ADR-0020-audit-hash-chain-canonicalisation.md)
§5's sentence is no longer a stated protection with no mechanism: `lock_timeout`
is named and set. `AUDIT_LOCK_TIMEOUT_MS = 2000` (one exported constant,
`packages/database/src/audit/lock-timeout.ts`) is applied via
`SET LOCAL lock_timeout` immediately before `pg_advisory_xact_lock` at both call
sites — `packages/database/src/audit/writer.ts` (`recordAudit`) and
`packages/database/src/audit/anchor.ts` (`createAuditChainAnchor`). Because it
is `SET LOCAL` rather than scoped to the one statement, it bounds every lock
wait for the REST of that transaction too — the linkage trigger's own `FOR
SHARE` read and the self-referential FK's `KEY SHARE` waits, both of which
happen after the advisory lock is acquired and before commit. A wait that
exceeds it surfaces as Postgres `55P03`, mapped to a named, retryable
`AuditLockTimeoutError` (thrown from both the advisory-lock acquisition and the
INSERT itself, since either can be where the wait actually happens).
Value confirmed by the Database/Architecture seats at 2.5x the ARCHITECTURE §11
800ms posting P95 budget and well under the 15000ms `statement_timeout`.
Tested: `database/tests/audit-lock-timeout.spec.ts`.

**Original finding, for the record.** No `lock_timeout` was set anywhere in
the repository. The only bound in force was `statement_timeout`
(`packages/database/src/pool.ts:222`, `15_000` ms) — roughly nineteen times the
800 ms budget and sized for slow queries, not lock waits.

**Owner.** Database Guardian, with the Architecture Guardian on the value.

---

## TD-002 · The per-tenant audit lock serialises logins against postings

**What.** [ADR-0020](adr/ADR-0020-audit-hash-chain-canonicalisation.md) §5 takes
one advisory lock per tenant for the audit append. Every audited write in a
tenant contends on it — not only postings. A login writes an audit record; so
does a permission change, a session revocation and an import. On a busy tenant,
a login can queue behind a long-running posting for no reason either operation
cares about.

**Why it is accepted.** The alternative — a finer lock keyed by
`(tenant_id, entity)` — reintroduces the ordering problem that the terminal
single lock exists to remove, and the chain is per tenant by
[rule 9](NON_NEGOTIABLES.md), so the serialisation point cannot be narrower than
the chain without splitting the chain. ADR-0020 records a fallback design
(`UPDATE audit_chain_head … RETURNING`) if measurement demands it.

**Owner.** Database Guardian. Measurement deferred to Wave 2 by ADR-0020.

**What would force it.** A measured P95 regression against ARCHITECTURE §11's
800 ms budget, or the first tenant where audited non-posting writes are frequent
enough to queue.

---

## TD-003 · The pre-push hook typechecks generated Next.js output

**What.** `npm run typecheck` covers `apps/web`, whose `tsconfig` includes
`.next/types`. `.next/` is gitignored build output, so switching between
branches with different routes leaves stale generated types behind and the
pre-push hook fails on a file that is not in the repository. Observed switching
from a branch carrying `/delivery-challans` to one without it:

```
.next/types/validator.ts(221,52): error TS2344:
  Type '"/delivery-challans"' does not satisfy the constraint 'AppRoutes'.
```

The fix is `rm -rf apps/web/.next`, which is not discoverable from the error.

**Why it is accepted.** It fails safe — a false failure that blocks a push,
never a false pass — and it costs one command. Excluding `.next/types` from the
typecheck would remove a real check on route correctness.

**Owner.** DevOps Guardian.

**What would force it.** A second person hitting it, or CI hitting it (CI builds
clean, so it does not today).

---

## TD-004 · ADR-0021 states one rule three times

**What.** [ADR-0021](adr/ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md)
states condition 5's scope at `:68`, `:70` and `:80`, and the production-minter
gate in two independent wordings at `:70` and `:80`. Introduced by the condition-6
amendment, which added paragraphs above the original without merging it.

**Why it is accepted — and why it must NOT be fixed.** The record is Accepted and
the text is accurate, merely redundant.
[README](adr/README.md) §4 permits correcting text that is *false about the
document's own contents*; it forbids tidying. That rule exists precisely so that
LEVEL 1 records are not quietly rewritten. Had this been caught during the
amendment it should have been merged; that window closed at acceptance.

**Owner.** Database Guardian.

**What would force it.** ADR-0021 being superseded for any other reason — merge
the three statements then. **Meanwhile: anyone editing one of the three must
check the other two.** That sentence is the entire value of this entry.

---

## TD-005 · `users` grants table-level `UPDATE` to `finsoft_app`

**What.** Migration 002 grants `SELECT, INSERT, UPDATE` on `users` with no
`REVOKE` and no column scoping. Table-level `UPDATE` supersedes any column list,
so `users.id`, `users.tenant_id`, `users.created_at` and `users.created_by` are
all application-writable today — the authorship root of the entire system.

Raised during the migration 004 review and again during 005. Migrations 004 and
005 both carry the `REVOKE`-then-column-grant pattern that closes it; `users`
predates the lesson.

**Why it is accepted.** 002 is released, so this is a forward migration, not an
edit. Nothing currently writes those columns.

**Owner.** Database Guardian.

**What would force it.** The first code path that updates a `users` row —
W1-002's login flow updates `last_login_at`, so this is live now, not later.

---

## TD-006 · Test-only hooks on production auth signatures

**What.** Two production functions in `packages/database/src/auth/` take an
optional test-only parameter. `withLoginAttempt()` in `login.ts` takes
`LoginTestHooks.beforeWrite`, and `login()` in `packages/auth/src/login.ts`
passes it through. The refresh spend in `refresh.ts` takes
`RefreshTestHooks.beforeSpend`, re-exported from `auth/index.ts`. Each hook is
inert unless it is passed, and each exists so an integration test can mutate
state on a separate connection at an exact race window. `beforeWrite` runs
between login's two transactions, with none open
(`tests/integration/login-toctou.spec.ts`). `beforeSpend` runs **inside** the
refresh transaction, between the candidate read and the atomic spend, with a
connection held. Nothing stops a production caller from passing one. A hook is
an arbitrary `async` callback that runs between the read and the write of an
authentication path.

**Why it is accepted.** [ADR-0025](adr/ADR-0025-login-read-and-write-transactions.md)
names it an accepted cost. The TOCTOU window it tests is the property ADR-0025
exists to close, and no other seam can reach that window deterministically
today. Neither hook receives a connection, a `TenantTx` or a tenant id, so
neither can widen what the write decides. `beforeSpend` holds the refresh
transaction open for as long as it runs, which is harmless in a test and one
more reason no production caller may pass it.

**Owner.** Database Guardian, with the Security seat.

**What would force it.** A better seam: for example, an injectable clock or
barrier at the `packages/database` boundary, or a test-build-only export.
Either can reach the window without widening a production signature. Also
forced sooner if a third hook is proposed, or if any non-test caller passes
one. Until then, **do not copy the pattern.** A new hook needs a line here.

---

## TD-007 · `audit_log` is not partitioned

**What.** [Migration 009](../database/migrations/009_create_audit_log.sql)
creates `audit_log` as a single, unpartitioned table. Rule 4 forbids `DELETE`
and this table grants none, so the only rule-4-compatible retention mechanism
is `DETACH PARTITION` — and `DETACH` removes rows, which is exactly what §6 of
[ADR-0020](adr/ADR-0020-audit-hash-chain-canonicalisation.md) defines as
tampering evidence ("a seq gap is what the verifier reads as evidence of a
deleted row"). Partitioning this table for retention and verifying its chain
are in tension until a further ADR resolves it.

**Why it is accepted.** `RANGE (occurred_at)` — the key ADR-0020 §5's own
deferred-fallback text names — is measured incompatible with this table's own
gap-freedom guarantee: PostgreSQL requires the partition key in every unique
index of a partitioned table, which would force `occurred_at` into
`audit_log_tenant_seq_key` and admit two rows at the same `seq` with different
`occurred_at` values as "not a duplicate." `HASH (tenant_id)` avoids that, but
needs the primary key to become `(tenant_id, id)` — an ADR-0021 §1 amendment,
since that section currently grants this table's surrogate-key exemption on
the footing of `(tenant_id, id)` UNIQUE existing ALONGSIDE a single-column
`id` PRIMARY KEY, not instead of it. And retention specifically needs a further
ADR defining SEALED CHAIN SEGMENTS — a closing manifest (final hash, row count,
detachment record) a segment-aware verifier checks instead of reading a
detached range's absence as a gap. None of that exists yet, so no partition of
this table may be detached even after `HASH (tenant_id)` lands.

**Owner.** Database Guardian, with the Architecture Guardian on the
ADR-0021 §1 amendment and the sealed-chain-segment ADR.

**What would force it.** Whichever of these is reached first: roughly 50
million rows in `audit_log`, roughly 50 GB of table size, or any single
tenant reaching 10 million rows. Recorded with the same thresholds in
migration 009's own partitioning comment, so the trigger condition is not
only here.

_Renumbered from TD-006 to TD-007: the audit lane's original TD-006 entry for
this item was silently dropped when develop's own TD-006 (test-only auth
hooks, ADR-0025) was merged into the audit branch — both lanes claimed TD-006
independently and only one survived. Recovered from the audit branch's
pre-merge history (commit c65615e) rather than re-derived, so the wording
matches what the Database Guardian originally reviewed._
