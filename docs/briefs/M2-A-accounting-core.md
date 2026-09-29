# M2-A — Accounting core foundation

**Lane:** M2-A · **Risk tier:** T3 (highest) · **Branch:** `feature/M2-A-accounting-core` ·
**Migrations:** 010–013 · **Council:** Accounting + Database + Architecture review required before merge

> Skill note: the task instructed writing this brief with a `delivery-brief`
> skill. No skill of that name exists in this session's available skill list
> (checked at task start). This brief is written by hand, following the
> format established by `docs/briefs/M1-D-audit.md`, `M1-A-auth.md`,
> `M1-R-rbac.md`. Flagged as BLOCKED-for-that-one-step in the final report;
> it did not block the rest of the lane.

## Task

Build the foundation of FinSoft's double-entry accounting core: the chart of
accounts, fiscal calendar, general ledger (journal entries/lines), server-side
document numbering, the posting engine (`packages/accounting-kernel`),
ledger/trial-balance reporting (`packages/reporting`), tenant provisioning of
COA + fiscal year, and a backfill CLI for tenants created before this lane
(BHATTI1/BHATTI2). No HTTP API, no screens — those land after M1 merges.

## Why

Every later financial feature (sales, receipts, purchases, inventory costing)
posts through this kernel. If the ledger's invariants aren't structural now —
balance enforced at commit, periods enforced with no bypass, postings
immutable, numbering race-free, parties structurally tied to control
accounts — every module built on top inherits the gap, and a posting bug here
is a financial misstatement, not a defect.

## Scope

- `database/migrations/010_create_accounts.sql` … `013_create_document_sequences.sql`, `CHECKSUMS`
- `database/tests/**` (ACL, RLS, trigger, schema-boundary tests for the new tables)
- `packages/accounting-kernel/**` (posting engine, reversal engine, event
  rules, injectable clock, `registerParty`)
- `packages/database/src/accounting/**` (query bodies the kernel calls —
  everything except `parties` writes, which live in the kernel per ADR-0026)
- `packages/database/src/provisioning.ts` (`seedChartOfAccounts`, `createFiscalYear`)
- `packages/reporting/**` (account ledger, trial balance, customer subledger balance)
- `packages/validation/src/money.ts` (ADR-0014 `Money.serialize` scale fix)
- `tools/seed/backfill-accounting.mjs`
- `tests/accounting/**`, `tests/reconciliation/**`, `tests/security/lint-boundaries.spec.ts`
- `docs/LOCK_REGISTRY.md` (append only)

FORBIDDEN (parallel lanes' territory): `apps/api` guards/interceptors, audit
wiring, `packages/auth`, `packages/permissions`, `tools/seed/demo-tenants.mjs`,
`tests/integration/exit-m1.spec.ts` (lane m1-x); `apps/web`,
`infrastructure/staging`, `ci.yml` (lane m1-web); `docs/adr/**` (Architecture
Guardian's seat — this lane builds *to* ADRs, it does not author or amend
them, including ADR-0026, which lives on another branch).

## Key decisions, and why

1. **ADR-0026 (Accepted 2026-09-28) drives the party dimension in migration
   012, superseding this task's original framing of it as an open Council
   question.** `parties` is a kernel-owned registry table (id, tenant_id,
   party_type CHECK IN ('CUSTOMER','VENDOR'), insert-only — `finsoft_app` gets
   SELECT+INSERT, never UPDATE/DELETE), created *before* `journal_entries`/
   `journal_lines` in 012. A journal line reaches a party only through the
   composite FK `(tenant_id, party_type, party_id) → parties (tenant_id,
   party_type, id)` MATCH SIMPLE ON DELETE RESTRICT. `journal_lines` carries
   `account_control NOT NULL`, whose composite FK `(tenant_id, account_id,
   account_control) → accounts (tenant_id, id, control_kind)` is the line's
   *only* FK to accounts, backed by two CHECKs that make README §4.1's
   "AR line must carry a customer" structural rather than trigger-enforced.
   This requires `accounts.control_kind` to be `NOT NULL DEFAULT 'NONE'`
   (never null) with `UNIQUE (tenant_id, id, control_kind)` — a change to
   migration 010's original shape.
   **Correction at Architecture-seat signature, binding:** `registerParty`'s
   query body lives in `packages/accounting-kernel`, *not*
   `packages/database` — `packages/database` is importable by
   `modules/*/infrastructure`, which would let a module write `parties`
   around the kernel. The lint rule (Compliance 7) fires on any
   `insertInto/updateTable/deleteFrom('parties')` or `parties` in a raw `sql`
   tag outside `packages/accounting-kernel/src/**` and
   `database/migrations/**` — including inside `packages/database` itself.
   ADR-0026 is not yet merged to `develop` (it lives on
   `feature/M3-000a-party-dimension`); this lane builds to its text as
   relayed and quoted in migration 012's own header, since the document
   itself isn't reachable from this worktree. **OBSERVED, not fixed here:**
   ADR-0026 needs to land on `develop` before or alongside this lane's merge
   for CI/Council traceability to resolve cleanly.
2. **K7 (PO decision, 2026-09-28) — `document_sequences` gets a `scope`
   column (`FISCAL_YEAR` | `TENANT`).** Customer codes (`CUST-000001`) are
   system-generated, one series per tenant for life, never resetting per FY —
   incompatible with the original per-(tenant, series, fiscal_year) unique
   key. Fixed with nullable `fiscal_year`, a CHECK tying it to `scope`, and
   two partial unique indexes rather than `NULLS NOT DISTINCT`, for
   portability. Six-digit zero-padding is the house width for both scopes.
3. **A subagent I dispatched purely for read-only research disobeyed its
   instructions and wrote a first draft of migrations 010–013 and kernel
   scaffolding before either correction above existed.** That draft is not
   trusted as authorized or reviewed; nothing in it was accepted without
   independent re-verification against the spec by Database Guardian and
   Accounting Guardian review inside this lane, exactly as any other
   engineer's untested draft would be. See Council review below for what
   changed and why.
4. **`Money.serialize`'s ADR-0014 open item** (a defaulted scale argument is
   an undeclared second rounding boundary) is resolved before the posting
   engine is built, as the ADR requires — see Council review for the exact
   fix chosen.
5. **No tenant-provisioning orchestrator exists yet in this branch** to wire
   `seedChartOfAccounts`/`createFiscalYear` into — tenant creation currently
   only happens through the test harness (`createTenantFixture`); the real
   provisioning flow lands with another lane. Both functions are exported
   from `packages/database/src/provisioning.ts`, ready to be called from
   that orchestrator's transaction once it exists. Wiring them into
   `apps/api` now would mean touching explicitly forbidden territory for
   this lane ("no HTTP API") for a service that doesn't exist yet — not
   done, noted for whoever builds it.
6. Golden scenario executability follows exactly what M2 can prove without
   M3's customer/invoice/receipt tables: P01, P02, P03, P07 run fully; P08
   runs steps 1–5 only (JV idempotency), steps 6–10 pending
   ("needs sales_invoice module, M3"); P04, P05, P06, P09, P10 pending
   ("needs customers/sales_invoice/customer_receipt module tables, M3").
   FinancialInvariantSuite invariants 1, 2, 4, 5, 6, 8 move out of
   `pending-baseline.json`; 3, 9, 10 correctly stay pending (stock/costing is
   Wave 5, subledger reconciliation needs M3's customer/invoice tables).

## Gate

`npm run verify` (typecheck, lint, depcruise, `db:migrate:verify`,
format:check, every workspace's own tests, then `test:gate` — smoke,
`test:schema`, `test:security`, `test:accounting`, `test:reconciliation`,
`test:integration`, `test:performance`) run **twice**, both green within
this lane's boundary. The only failure on either run, in the same place
both times: `tests/integration/api-app.spec.ts`'s
`keeps REQUIRED_SCHEMA_VERSION in step with the migrations on disk` —
`apps/api/src/health/health.service.ts`'s `REQUIRED_SCHEMA_VERSION` constant
is hardcoded to `9` and needs bumping to `13` now that migrations 010–013
exist. `apps/api` is explicitly FORBIDDEN territory for this lane, and this
is the *exact* constant the M1-D brief already deferred once before as a
"rebase-time duty" when its own migration landed — same pattern, left for
whoever integrates this branch (lane m1-x owns `apps/api`).

`npm run check:full` additionally runs `test:e2e` (Playwright, against
`apps/web` + `apps/api` together) — not run here: this lane is explicitly
"foundation only — NO HTTP API and NO screens," and `apps/web`/e2e
infrastructure belongs to lanes (m1-web, m1-x) not yet merged into this
branch.

## Council review

### Database Guardian — APPROVED for migrations 010–013, with real defects fixed

Independently re-verified and corrected the untrusted draft against ADR-0026
and K7 rather than trusting it. Applied cleanly from empty, full
`database/tests` suite green against real PostgreSQL (19 files / 353 tests).
Beyond the two corrections, found and fixed:

- **Every one of 010–013 revoked UPDATE but never INSERT.** Default
  privileges still gave `finsoft_app` table-level INSERT, so every
  column-scoped INSERT grant was decorative — the app could have inserted an
  entry born `REVERSED`, a period born `LOCKED`, or chosen its own id,
  `created_at` or `version`. Both are now revoked everywhere; an exact-ACL
  test (`accounting-acl.spec.ts`) checks grants column by column.
- **ADR-0026's second CHECK, as literally written, lets an AR line with no
  party through** (`party_type IS NULL` makes the OR-chain evaluate to NULL,
  and a NULL CHECK passes). Rebuilt with `IS NOT DISTINCT FROM` for
  null-safety, tested. **The ADR text itself needs this correction** —
  flagged for the Database/Security seat to fix at the source.
- Lock-ordering bug (`LOCK_REGISTRY.md` described taking the period lock
  before numbering; the code did the reverse) and a deadlock between
  concurrent period close/reopen/lock, both fixed. Ledger pagination was
  unbounded; now hard-capped at 500 rows.
- Entries could be extended after posting, could commit with fewer than two
  lines, and a reversal's pairing (E.reversed_by ↔ R.reversal_of) wasn't
  enforced as a pair — all closed with new constraints/tests.

**Follow-up requested by Accounting Guardian, completed:** `journal.ts`'s
`insertJournalEntry`/`markEntryReversed` were dead code once the kernel's own
query bodies existed, and a bypass route around the kernel's validation —
removed, along with their lint exemption.

### Accounting Guardian — APPROVED for the M2 kernel scope

Also treated the draft as unverified and found real defects beyond the three
reported breaks (missing `accountControl` at 6 call sites; the
`controlKind !== null` bug that would have rejected every valid JV;
exception-driven idempotency control flow that aborted the transaction on
replay). Notably:

- The balance assertion (pipeline step 7) only ran for the JV rule, not
  every rule.
- Golden-file error shapes didn't match the spec (`JV_UNBALANCED`'s keys,
  `PERIOD_CLOSED` not naming the open period).
- Audit records omitted line detail and never captured the
  POSTED→REVERSED transition.
- Unknown payload keys were silently dropped instead of rejected
  (`PAYLOAD_INVALID`) — a stray `taxAmount` would have vanished rather than
  failing loudly, which matters given "no tax in MVP" is a hard PO decision.
- No party pre-check existed before relying on the FK backstop.
- SALE_POSTED/CUSTOMER_PAYMENT_RECEIVED were left postable even though their
  golden proof can't run yet — now return `RULE_NOT_ENABLED` per README §1/§3
  until M3, with their account-resolution/rounding logic built and unit
  tested against P04/P10's figures.
- The golden runner never actually compared outcomes — verified by
  deliberately corrupting four figures and confirming all four failed.
- **ADR-0005 step 2 could not be implemented as literally written** ("INSERT
  … on conflict, return prior result") against this schema, because the
  idempotency key lives on `journal_entries` itself, not a separate table —
  a concurrent duplicate consumes a document number before the INSERT
  conflicts. Fixed with a single savepoint around the number-assignment +
  insert steps, proven by mutation (removing the rollback leaves a gap in
  the JV series under a double-click). **Flagged for the Architecture seat**:
  ADR-0005's step 2 text should be corrected to describe this.

Verified runs (pass counts, against the real `finsoft-m2a` stack):
typecheck/lint/depcruise/`db:migrate:verify` all exit 0;
`test:schema` 353/353; `test:security` 170/170; `test:accounting` 117/117;
`test:financial-invariant-suite` 33/33; `test:reconciliation` 32/32;
`@finsoft/validation` 106/106; `@finsoft/accounting-kernel` 34/34.

### Items raised for Council / Product Owner attention (not resolved in this lane)

1. **ADR-0026 needs to land on `develop`**, with the null-safety correction
   to its second CHECK, for CI/Council traceability — it is currently only
   quoted in migration 012's header.
2. **ADR-0005 step 2's text** needs the savepoint-based correction described
   above.
3. `reversal.md` and IMPLEMENTATION §11 disagree on what `reversed_by`
   names (the reversing entry vs. a user) — Database Guardian followed
   `reversal.md`; the docs should be reconciled.
4. `journal_lines` partitioning (range on an added `occurred_at`-bearing
   key) is recorded as an intended approach in 012's header but not built —
   worth deciding before a real release, since adding the column later means
   rewriting the largest table.
5. Two Accounting-seat judgment calls made in the absence of written spec,
   flagged rather than silently decided: reversing onto a since-deactivated
   account is rejected (`ACCOUNT_INACTIVE`); an over-length reversal
   narration is truncated with a visible marker while the full reason is
   kept in `reversal_reason`.
6. `registerParty` writes no audit record of its own (the audit lock must be
   taken last in a transaction) — M3's customer-creation flow must cover
   the party registration in its own audit record.
7. M3 needs a kernel entry point for reversing a document-sourced entry
   (`REVERSAL_VIA_SOURCE_REQUIRED`'s counterpart) — not built in M2, out of
   scope here, noted for whoever picks up M3.

## Council T3 review — APPROVED WITH CONDITIONS, all conditions fixed

The full T3 Council (Accounting, Database, Architecture) reviewed the
branch above and returned APPROVED WITH CONDITIONS. Every condition is
fixed, verified twice against the real `finsoft-m2a` stack, and pushed.
Item by item:

- **PERIOD GATE** (Accounting F1/R1, Database F1/R1): the 012 open-period
  trigger now also requires `occurred_at` to fall within the *referenced*
  period's own `[period_start, period_end]`, raising 23514 — a
  period_id/occurred_at pair naming two different periods no longer passes
  just because the named period is OPEN. DB test: close 2026-07, post with
  period 2026-08 + date 2026-07-10 → 23514 (and 2026-09-01 → 23514; 2026-08-01
  and 2026-08-31 accepted). FinancialInvariantSuite scan added
  (`entriesOutsideTheirPeriod`): every posted entry's date is confirmed
  inside its own period, tenant-wide.
- **MIGRATION-ROLE BYPASS** (Accounting R2, Database R6): new tests prove
  `finsoft_migration` (BYPASSRLS) cannot insert into a CLOSED or LOCKED
  period, or post a mismatched period/date, and that a posting racing a
  period close is serialised correctly in both orderings (real two-connection
  tests, not simulated). "OPEN GAP" removed from the Invariant 5 note,
  replaced with the actual DB-level evidence it now cites.
- **KERNEL-ONLY FENCES** (Architecture 1/2/5, Accounting F3/R3):
  `closePeriod`/`reopenPeriod`/`lockPeriod` moved out of `packages/database`
  entirely into `packages/accounting-kernel/src/queries/periods.ts`, exposed
  through `periodEngine.close/reopen/lock` (the `registerParty` pattern). A
  transition now re-reads the period under its own calendar lock rather than
  trusting a caller-supplied version — two racing closes now produce a typed
  `PERIOD_CLOSED` for the loser. `assignDocumentNumber`,
  `assignTenantDocumentNumber` and `lockEntryForReversal` stay in
  `packages/database` but are lint-fenced to the kernel, `provisioning.ts`
  and tests only. A new lint rule confines any write to `fiscal_periods` to
  the kernel's queries and migrations, with fixtures firing in
  `packages/database`, a synthetic `modules/*/infrastructure`, `apps/api`,
  `packages/reporting` and `tools`. `packages/database/src/index.ts`'s
  comment now states the real rule instead of implying a general license.
- **ADR-0027 K1**: an ESLint rule rejects every transaction-control
  statement anywhere in `packages/accounting-kernel` except the three
  statements in `queries/journal-writes.ts` naming the savepoint
  `finsoft_posting_number` exactly (confirmed already correctly named). The
  prior fixture using a savepoint named `s` is now a rejected case; new
  cases prove a stray `ROLLBACK`/`COMMIT`/savepoint anywhere else in the
  kernel is caught. `lint-boundaries.spec.ts`: 110/110 before → 134/134
  after.
- **PARTIES** (Database R2/R3): `parties` gets its own forbid-mutation
  trigger set (`parties_no_update`/`_delete`/`_truncate`), matching
  `journal_lines`' shape, plus an owner test proving even the owning role
  can't bypass it. The party lookup index is replaced with ADR-0026
  Compliance row 8's exact shape: `(tenant_id, party_id, account_id) WHERE
  party_id IS NOT NULL`.
- **TESTS** (Accounting F4/R4, F5/R5): new coverage for `ENTRY_NOT_FOUND`
  (unknown id, malformed id, and another tenant's real entry id all give
  the identical answer), `REVERSAL_REASON_REQUIRED`,
  `REVERSAL_VIA_SOURCE_REQUIRED` (against a document-sourced entry inserted
  as the migration role, since `sales_invoice` doesn't exist until M3), and
  `ACCOUNT_INACTIVE` on both the JV and reversal paths. The golden runner's
  trial-balance checks now call the real `trialBalance()` from
  `@finsoft/reporting` instead of a parallel computation — proven to bite by
  deliberately corrupting the report's presentation and watching four
  scenarios fail, then reverting. Invariant 6 now builds the whole
  per-(account, party) residual map for every reversal pair and asserts
  every cell is exactly zero, not an aggregate.
- **COMMENTS** (Accounting F6/F7, Database R5): corrected the false "gaps
  are acceptable" claim about document numbering (the counter is an
  ordinary locked row, not a sequence — a rolled-back posting consumes no
  number) in migration 013's header, its `COMMENT ON COLUMN`, and
  `sequences.ts`; fixed stale `LOCK_REGISTRY.md` position references
  (period lock is 5b, numbering is 5c).
- **BACKFILL** (Database R4, Accounting C3): the CLI now refuses
  `NODE_ENV=production` without an explicit `FINSOFT_ENVIRONMENT=staging`
  marker (staging and production both set `NODE_ENV=production`, so
  `NODE_ENV` alone can't distinguish them), and even then refuses if any
  tenant outside the known demo set (`BHATTI1`/`BHATTI2`) exists on the
  target — mirroring the *intent* of the M1-X demo seed's own rule (that
  script doesn't exist in this worktree yet; reconcile the two rules once
  it lands). Every audit record it writes now carries `via:
  'backfill-accounting'` and a fresh request id, via a new optional
  `AuditOrigin` parameter on `seedChartOfAccounts`/`createFiscalYear`.
  Confirmed the CLI imports nothing from `@finsoft/accounting-kernel`. All
  four behaviors verified against the live dev database, including a direct
  query against `audit_log` confirming the `via` tag.
- **REVERSED_BY**: Accounting seat ruled `journal_entries.reversed_by → R.id`
  per ADR-0006 is correct as built. No change made.
- **MERGE ORDER** (Architecture): not yet mergeable pending (a) the
  request-correlation middleware lane merging — explicitly deferred per the
  coordinator's instruction; the `requestId`/`ip` null call sites in
  `posting-engine.ts`/`reversal.ts`/periods are untouched, waiting for that
  signal — (b) ADR-0026 landing on `develop`, (c) ADR-0027 Accepted
  (confirmed accepted on `feature/M2-000b-adr-0027` per the coordinator).
  `REQUIRED_SCHEMA_VERSION` 9→13 happens at the final rebase, not here.

**Evidence, twice, against the real `finsoft-m2a` Postgres stack:**
`test:schema` 363/363 (20 files), `test:security` 216/216 (9 files),
`test:accounting` 129/129 (7 files), `test:reconciliation` 32/32,
`@finsoft/accounting-kernel` 34/34, `@finsoft/reporting` 4/4,
`tests/accounting/period-transitions.spec.ts` 5/5,
`tests/security/lint-kernel-fences.spec.ts` 21/21. Only failure on either
run: the same pre-existing, out-of-scope `REQUIRED_SCHEMA_VERSION` drift in
`apps/api` noted above.

A note on process: this round again involved two guardian subagents editing
overlapping files concurrently (`eslint.config.mjs`,
`tests/security/lint-boundaries.spec.ts`, `accounting-triggers.spec.ts`,
`parties.spec.ts`), which produced some duplicated tests that had to be
reconciled by hand — both guardians caught and resolved this themselves,
confirmed against each other's final state rather than assuming their own
last-known version was correct.
