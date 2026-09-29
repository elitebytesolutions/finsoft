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
