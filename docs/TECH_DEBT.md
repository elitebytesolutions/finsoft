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

## TD-009 · `deriveReferenceId` is a posting-identity rule living in an `apps/api` controller

**What.** `POST /api/journals` (`apps/api/src/accounting/journals.controller.ts`)
mints the `referenceId` `postingEngine.post` requires for a manual journal
voucher. `journal-voucher.md` §2 says this id is "generated server-side for
this voucher" — but a retry of the SAME voucher (identical `Idempotency-Key`)
is a separate HTTP request, and `referenceId` is one of the inputs
`computeRequestFingerprint` hashes (README §4). A fresh `randomUUID()` per
call therefore makes every retry look like a NEW request reusing the key
(`IDEMPOTENCY_KEY_REUSED`) rather than a replay — found by this lane's own
integration tests before it shipped (three-identical-requests case).
`deriveReferenceId` fixes it by hashing `(tenantId, idempotencyKey)`
deterministically (`sha256`, formatted as a uuid), so retries of one
submission always mint the same id.

That fix is correct, but it is a rule about what makes two postings "the same
voucher" — squarely a posting-identity concern, which is otherwise entirely
the kernel's (`packages/accounting-kernel`, ADR-0005/ADR-0027). It sits in
`apps/api` only because this lane's ALLOWED paths stop at "importing the
kernel's index" and do not include
`packages/accounting-kernel/src/**` for a change to the rule itself.

**Why it is accepted.** The fix is correct and tested (`tests/integration/
accounting-api.spec.ts`, "is idempotent: three identical requests produce one
entry, one number"), and every `POST /api/journals` request goes through
this exact function — there is no path that bypasses it. Moving the logic is
a kernel change requiring Accounting-seat review, not something this HTTP
lane should decide unilaterally.

**Owner.** Accounting seat (kernel).

**What would force it — and the fix.** Give `postingEngine.post` (or the
journal-voucher rule specifically) the option to derive `referenceId` itself
from `(tenantId, idempotencyKey)` when the caller is `JOURNAL_VOUCHER_POSTED`
and no source document already provides one — the same computation, moved to
`packages/accounting-kernel/src/rules/journal-voucher.ts` or
`posting-engine.ts`, with `apps/api` no longer minting an id at all. Due
before a second caller of `postingEngine.post` for a client-triggered,
document-less event needs the same derivation and either duplicates this
function or imports it from `apps/api` (which dependency-cruiser would
correctly refuse, `apps/api` not being an allowed import for a module or
another lane).

---

## TD-010 · The customer ledger shows a reversal with no reason

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

## TD-011 · K5's party ledger resolves exactly one AR_CONTROL account

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

**Update, 2026-09-29 (Accounting seat, M2-C).** The Product Owner brought chart create/edit into the MVP. It does **not** force this item: [coa-standard.md](posting-rules/coa-standard.md) §8.1 forbids users from creating control accounts, and §8.7 asks migration 018 for R2 (the create path cannot write `control_kind`) and R7 (at most one `AR` and one `AP` control account per tenant, structurally). Once R7 lands, the divergent configuration cannot be stored, and this item can close on the Database seat's evidence.

**Update, 2026-09-29 (M2-C implementation).** R7 has landed: migration 018 adds `accounts_tenant_ar_ap_control_key`, a unique index on `(tenant_id, control_kind) WHERE control_kind IN ('AR', 'AP')`, binding every role including `finsoft_migration` — a second `AR`- or `AP`-control account cannot be stored by any path. R2 (the application-layer narrowing of the create path's own INSERT privilege) is **not** landed — see TD-016 — but R7 alone already closes the structural gap this item names: the divergent configuration `controlAccountLedger` worries about cannot exist in the database regardless of which path attempted to write it. Recommend closing this item on the Database seat's sign-off of migration 018's `accounts_tenant_ar_ap_control_key`.

---

## TD-012 · Superseded draft revisions are kept and never read

**What.** `sales_invoice_lines` and `customer_receipt_draft_allocations` are
insert-only and revisioned (`modules/receivables`, migrations 016-017): every
draft save inserts a whole new revision and bumps
`sales_invoices.lines_revision` / `customer_receipts.proposals_revision`.
Every revision before the current one stays in the table forever, with no
`DELETE` grant and nothing that ever reads it again.

**Why it is accepted.** Named in
[docs/design/M3/README.md](design/M3/README.md) §10 as the cost of keeping
both tables insert-only with no money in `jsonb` (rule 6) and no `DELETE`
grant (rule 4) — a repository that could delete or overwrite a line revision
would be the one financial-record code path in the system that can, which is
a bigger risk than a few stale rows.

**Owner.** Architecture seat.

**What would force it.** Draft storage becoming measurable at real tenant
volumes — a tenant whose users repeatedly edit large draft invoices or
receipts before posting or cancelling. At that point a periodic archival job
(never a delete, per rule 4) for superseded revisions is the fix, not a
change to the insert-only shape.

---

## TD-013 · Receipt drafts and receipt posting share `payment.receive`

**What.** `POST /api/receipts` (draft), `PATCH /api/receipts/:id`,
`POST /api/receipts/:id/post` and `POST /api/receipts/:id/cancel`
(`modules/receivables`, `apps/api/src/receivables/receipts.controller.ts`)
all require only `payment.receive`. Invoices already split `invoice.create`
from `invoice.post`; the matching split for receipts (a `payment.post`
code) does not exist in the MVP catalogue
(`packages/permissions/src/catalog.ts`).

**Why it is accepted.** Named in
[docs/design/M3/README.md](design/M3/README.md) §10 and
[api-contract.md](design/M3/api-contract.md) §2: adding a catalogue code
needs seeding existing tenants' system roles, a catalogue-wide task, not a
single lane's addition. Per this lane's own task contract: "If a needed code
is missing, STOP and report; do not invent one."

**Owner.** Architecture seat / Security seat (catalogue changes are joint).

**What would force it.** The first tenant that wants a clerk to prepare
receipts that someone else posts (maker-checker), matching PO-Q2's precedent
from M2 for journal vouchers (`voucher.post` / `voucher.reverse` already
split that way) — at which point `payment.post` is added to the catalogue,
seeded into the Accountant role, and `POST /api/receipts/:id/post` switches
to requiring it instead of `payment.receive`.

---

## TD-014 · `journalEntry` is `null` on a plain GET of an already-posted invoice or receipt

**What.** `GET /api/invoices/:id` and `GET /api/receipts/:id`
(`modules/receivables/application/get-invoice.ts`,
`get-receipt.ts`) always return `journalEntry: null`, even for a `POSTED` or
`REVERSED` document. The field is populated correctly on the **response of
the mutation itself** — `POST /api/invoices/:id/post`,
`POST /api/invoices/:id/reverse` and the receipt equivalents pass the entry
straight through from `postingEngine.post` / `reversalEngine.reverseForSource`'s
own result (`apps/api/src/receivables/invoices.controller.ts` /
`receipts.controller.ts`) — but a later plain read has nothing to resolve it
from.

**Why it is accepted.** `modules.md` §7 is explicit that the journal entry's
id is deliberately **not** stored a second time on the document ("a second
pointer would be a copy that can disagree"), and it is found only through
the kernel's `UNIQUE (tenant_id, source_type, source_id)` — a lookup no K1-K7
capability exposes to a module for reading (as opposed to posting/reversing).
Building one (most plausibly by filtering `@finsoft/reporting`'s
`controlAccountLedger` for the matching `sourceId`, which already returns
`entryId`/`entryNumber` per line) is a kernel/reporting-surface change, T3
review, outside this lane's `packages/accounting-kernel/src/**` (K2-K4 and
the two rules only) boundary.

**Owner.** Accounting seat / Architecture seat.

**What would force it.** M4's invoice/receipt detail screen, which needs
`journalEntry` linked from a page load, not only from the post/reverse
response it happened to be on. The fix is a K-numbered kernel or
`@finsoft/reporting` export ("find the entry for this source"), reviewed the
same way K5 was, not a second pointer column on the document.

**Partial progress, second follow-up commit (K4, Council review of
efb7e3f).** The RELATED but narrower gap — the source document's own number
(not the full `{id, number}` entry) appearing on a customer's LEDGER line —
is now closed: `journal_entries.reference` is threaded through
`packages/database`'s ledger query, `packages/reporting`'s
`AccountLedgerLine.sourceNumber`, and `modules/customers`'
`CustomerLedgerLine.sourceNumber`, proven by
`tests/integration/receivables/receivables-api.spec.ts`'s P05 test (a
posted invoice's `GET /api/customers/:id/ledger` line carries its own INV
number). This does **not** close TD-014 itself: a plain `GET /api/invoices/
:id` still returns `journalEntry: null` — the ledger line's `sourceNumber`
and an invoice's own `journalEntry` object are two different reads, and
only the first is fixed. TD-014 stays open exactly as stated above.

---

## TD-015 · CLOSED — P04-P06/P08/P09-P12 now execute in the gate, through the real module

**Closed 2026-10-01 (M3-Q, M3-P @2a02731+ merged).** `golden-posting-runner.ts`
gained the module-routed path ADR-0028 statement 10 asks for: the
`saveDraft`/`editDraft`/`cancelDraft`/`customer` verbs the golden files
already used, a `post`/`reverse` path that drives `sales_invoice`/
`customer_receipt` sources through `modules/receivables`'s own `index.ts`
(`receivables-real-port.ts`, a `ReceivablesPort` adapter — never a fake, never
a throwaway merge) instead of `postingEngine.post` directly, an `'ALL'`
milestone for P08's dual M2/M3 subset, and a `level: "kernel"` escape for the
handful of kernel-only rejections the module's own command shape cannot
reproduce (no client-submittable `lineNet`, `kind` or `settlement` field).

P04, P05, P06, P08 (all ten steps), P09, P10, P11 and P12 now run through
`posting-scenarios-m3.spec.ts` against the REAL `modules/receivables`, and
are `EXECUTED_IN_M3` in `tests/accounting/golden-posting-registry.ts` — not
`PENDING`. `PENDING` is empty: every posting golden scenario README §6 lists
now executes somewhere, for real. Invariant 9 (AR half) and
`tests/reconciliation/subledger-to-gl-ar.spec.ts` are enforced on real rows
in the same change (`tests/accounting/invariants.ts`,
`tests/accounting/pending-baseline.json`); `tests/reconciliation/
dormant.spec.ts`'s FND-012 tripwire is re-armed on what remains (AP, Wave 6;
inventory, Wave 5) instead of on AR, which is answered.

**What was the original gap.** `packages/accounting-kernel/src/events.ts`'s
`IMPLEMENTED_EVENTS` included `SALE_POSTED`/`CUSTOMER_PAYMENT_RECEIVED`, and
`modules/receivables` posted both for real — proven by its own integration
suite (`tests/integration/receivables/receivables-api.spec.ts`) — but the
golden scenario files themselves had no runner path to execute through the
module (ADR-0028 statement 10), so the SAME reviewable, hand-computed-figures
mechanism every other posting rule is held to was not yet proving these
rules in the financial gate. Docs/posting-rules/README.md §3's "golden
first, same PR" was true of the RULE but not yet of its golden.

**Owner.** M3-Q lane (owned `tests/accounting/**` and the golden runner, per
docs/design/M3/README.md §3).

---

## TD-016 · coa-standard.md §8.7 R2's database-privilege backstop is not built — blocked on a new database role

**Renumbered from TD-012 at the M2-C / M3-P merge, 2026-10-01** — TD-012 through
TD-015 above are M3-P/M3-Q's, merged first; this item keeps its content
unchanged and only its number moves. TD-011's own "M2-C implementation"
update above has been corrected to point here.

**Also tracked as [GAP-006](COMPLIANCE_GAPS.md#gap-006--chart-of-accounts-create-has-no-database-privilege-backstop-r2)**, a named **production blocker** (Council disposition, M2-C review, 2026-09-29: R2 is option (b), merge now, production stays blocked until R2 is done). GAP-006 is the LEVEL-0-adjacent, sign-off-tracked record; this entry is the implementation-detail record for whoever picks up the fix — read both.

**What.** `coa-standard.md` §8.7 R2 asks for the chart-of-accounts user-create
path to be structurally unable to insert a header, a control account, a role
or a restricted account — at the privilege layer, not only in application
code — via a `SECURITY DEFINER` seeding function that replaces
`finsoft_app`'s current column-scoped `INSERT` grant on
`kind`/`control_kind`/`role`/`restricted` (today used only by tenant
provisioning, `seedChartOfAccounts`). The Security seat's tightening of R2
(this lane's delivery brief, M2-C) requires that function's owner to be a
`NOLOGIN`, `NOBYPASSRLS` role that "owns nothing else" (the S4 exception this
lane implemented in `database/tests/migration-ownership.spec.ts`, ready for
whichever migration lands this function).

Migration 018 does **not** land this function. The one existing role that
fits "NOLOGIN, NOBYPASSRLS" — `finsoft_refresh` (migration 006, ADR-0023 §2)
— already owns `auth_lookup.resolve_refresh`; giving it a second function
would fail "owns nothing else" for both. A fresh, dedicated role cannot be
created by a migration (`finsoft_migration` has no `CREATEROLE`, measured,
migration 006's own header) — it can only be provisioned in
`infrastructure/docker/postgres/init/00-bootstrap.sh`, a file outside this
lane's `ALLOWED` paths. The Security seat's other named option, a trigger
that admits those values only inside the tenant-provisioning transaction, is
explicitly **REJECTED** by the same ruling — there is no third mechanism this
lane could use instead.

**Why it is accepted, for now.** The APPLICATION-layer half of R2 holds:
`chartOfAccounts.create` (`packages/accounting-kernel/src/chart-of-accounts.ts`)
hardcodes `kind='POSTABLE'`, `control_kind='NONE'`, `role=NULL`,
`restricted=false` — there is no field through which a request, however
malformed, could ask for anything else. Combined with R7 (landed, TD-011's
update above), the reachable blast radius of the missing privilege-layer
backstop is narrow: a bug would have to be in `finsoft_app`'s OWN code path
(not a crafted HTTP request, which the kernel's fixed values already
foreclose) to reach the still-open `kind`/`control_kind`/`role`/`restricted`
columns of its INSERT grant.

**Owner.** Database Guardian / DevOps Guardian (owns
`infrastructure/docker/postgres/init/00-bootstrap.sh`), with the Security
seat on the exact role shape.

**What would force it.** A new NOLOGIN, NOBYPASSRLS role — for example
`finsoft_coa_seed` — added to `00-bootstrap.sh` alongside `finsoft_refresh`
(same `GRANT ... TO finsoft_migration WITH INHERIT FALSE, SET TRUE` pattern),
plus a follow-up migration that: creates the seeding function as
`finsoft_migration`, pins `SET search_path = pg_catalog, public`, does
`ALTER FUNCTION ... OWNER TO finsoft_coa_seed`, revokes `EXECUTE` from
`PUBLIC` and grants it explicitly to `finsoft_app`, and narrows
`finsoft_app`'s `INSERT` on `accounts` to drop
`kind`/`control_kind`/`role`/`restricted`. `schema.spec.ts` then asserts
`finsoft_coa_seed` is `NOLOGIN`, `NOBYPASSRLS` and owns exactly that one
function — the S4 exception (c) condition this lane's checker already
enforces. `tools/seed/backfill-accounting.mjs` and
`seedChartOfAccounts`/provisioning's tenant-creation path route through the
new function instead of the current direct INSERT.
