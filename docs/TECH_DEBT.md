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

---

## TD-008 · `users.version` doubles as the permission-version signal

**What.** `008_create_rbac.sql`'s header already names this deliberately: it
bumps `users.version` — the SAME counter migration 002 uses as the row's
general optimistic lock — on every role/permission change, "not a misuse of
optimistic locking ... simply a coarser signal than a dedicated counter would
be." M1-X wires the consuming half: the JWT's `perm_ver` claim snapshots
`users.version` at mint time (login, refresh), and
`packages/auth/src/guard.ts`'s `verifyBearerToken` refuses a token whose claim
is behind the CURRENT `users.version` on every authenticated request
(`getAccountStateCached`, short-TTL Redis cache in front of Postgres).

Because the counter is shared, ANY write to a user's own row invalidates
every access token that predates it — not only a role or permission change.
Two production paths do this today with no permission implication whatsoever:
`updateOwnFullName` (`PATCH /api/auth/me`) bumps `version` as its own
optimistic lock, and every login's own write (`writeLoginSuccess`) bumps it
too. A user who edits their own display name, or who signs in a second time
from another device, invalidates their OWN currently-held access token the
moment the account-state cache next misses or is cleared — a 401 on their
very next request, with nothing about their permissions having changed at
all. Demonstrated deterministically (not by waiting out the cache's 15s TTL)
in `tests/integration/account-state-guard.spec.ts`'s "cache invalidation is
asserted explicitly" cases.

**Why it is accepted.** No new migration is added for this — 010–016 are
reserved for M2/M3's own numbering, and a permission-versioning schema change
is exactly the kind of change that needs Database seat review on its own
merits, not folded into an M1 integration fix. The false-positive 401 is
self-healing (a refresh, or a fresh login, mints a token against the current
version and succeeds — both proved in the tests above) and is bounded by the
same 15-minute access-token lifetime every other staleness case in this
system already accepts.

**Owner.** Database seat.

**What would force it — and the fix.** A dedicated `users.permission_version`
column, added in a future forward migration (after M3's own numbers are
assigned), with 008's `permission_version` cascade functions (the
`user_roles`/`role_permissions` triggers) repointed to bump the new column
instead of `version`. `login.ts`'s write and `getAccountState`/
`getAccountStateCached` would then read the dedicated column, and an ordinary
profile edit or a second login would stop invalidating other sessions'
tokens. **Due before role-management UI** ships — the false-positive rate is
proportional to how often a tenant's users change roles relative to how often
they edit their own profile or sign in from a second device, and a
role-management screen is what turns the first number from "rare" to
"routine."

---

## TD-009 · The customer ledger shows a reversal with no reason

**What.** `GET /api/customers/:id/ledger`'s `reverses.reason` field
(`packages/shared-types/src/customer.ts`) is `null` whenever a line reverses
another entry. `packages/reporting`'s account-ledger read (K5,
`packages/database/src/accounting/ledger.ts`'s `AccountLedgerLine`) carries
only the paired entry's id and number — never `journal_entries.reversal_reason`
— so `modules/customers/api/mappers.ts` has nothing to put there. The field
renders as absent in the response, not as an empty string standing in for a
real one, which is the honest shape for "not resolvable from this read," not
a guess.

**Why it is accepted.** Adding `reversal_reason` to the ledger read is a K5
change to `packages/reporting`/`packages/database`, reviewed as T3 kernel
work — out of scope for a module lane to widen unilaterally, and the field is
cosmetic (the reversal is fully identified by `entryId`/`entryNumber`; the
REASON is additionally available today via `GET /api/audit`, filtered to the
reversal entry, for a user who needs it).

**Owner.** Accounting seat.

**What would force it.** M4's customer ledger screen needing the reversal
reason inline, without a second request to the audit endpoint — at which
point the fix is adding `reversal_reason` to `AccountLedgerLine` and its
mapper, not a new query.

---

## TD-010 · K5's party ledger resolves exactly one AR_CONTROL account

**What.** `packages/reporting/src/party-ledger.ts`'s `controlAccountLedger`
resolves the `AR_CONTROL` (or `AP_CONTROL`) role to exactly one account via
`resolveAccountsByRole` and reads that one account's ledger, filtered by
party. `packages/reporting/src/subledger.ts`'s `customerSubledgerBalance` (the
balance-only read `GET /api/customers` and `GET /api/customers/:id` use) takes
a different path: it sums every journal line carrying `account_control = 'AR'`
for the party, with no join to a specific account id at all. The two would
diverge — the ledger showing one account's lines, the balance summing every
AR-control account's — if a tenant ever configured more than one account with
`control_kind = 'AR'`.

**Why it is accepted.** `accounts_tenant_active_role_key` (migration 010)
already makes at most one ACTIVE account hold the `AR_CONTROL` **role** per
tenant, and the MVP standard-v1 chart of accounts seeds exactly one AR-control
account with no UI or endpoint to create a second. A tenant could still mark a
second account `control_kind = 'AR'` without giving it the `AR_CONTROL` role
(roles and control-kind are independent columns, coa-standard.md), which is
the one configuration this divergence needs — reachable only through a chart
edit no MVP surface performs.

**Owner.** Accounting seat.

**What would force it.** Wave 2's chart-of-accounts editing UI, or any tenant
onboarding that seeds a second AR-control account (a second AR bank fee
account, for instance) — at which point `controlAccountLedger` should sum
every AR-control account for the party, matching `customerSubledgerBalance`'s
own query shape, rather than resolving a single role.
