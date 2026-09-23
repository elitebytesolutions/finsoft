# Wave 0 — task register

**Authority:** LEVEL 2, alongside [IMPLEMENTATION.md](IMPLEMENTATION.md). Scope changes need Product Owner approval.

The `FND-` task contracts, recorded in the repository rather than in a session. Until now they existed only in planning conversation, which meant the scope of Wave 0 was not durable: a later session could not tell what FND-016 was, or why FND-012 was considered done.

Each entry states scope, dependencies, acceptance criteria, status, and evidence tied to a commit. **Status is claimed, not assumed** — `complete` means the acceptance criteria are met and the evidence link shows it.

Reference CI run for everything marked complete below: [35909452053](https://github.com/elitebytesolutions/finsoft/actions/runs/35909452053) at `a5093af` — static analysis, secret scan, tests and all three container images green.

| Status | Meaning |
|---|---|
| **complete** | Acceptance criteria met, evidenced |
| **partial** | Delivered in part; the remainder is named |
| **blocked** | Cannot proceed; the blocker is named |
| **deferred** | Deliberately out of Wave 0, with an owner and a target wave |

---

## FND-000 · Version control and branch protection

**Scope.** Git repository, remote, branching model, push protection, code ownership.
**Dependencies.** None.

**Acceptance criteria.** Repository is private · `main` and `develop` exist · direct pushes to both are refused · CODEOWNERS routes review · agents push feature branches only and never merge.

**Status: partial.**

Local enforcement works: `.githooks/pre-push` refuses direct pushes to `main` and `develop` and cannot be skipped without `--no-verify`, which is prohibited. What is **not** enforced is server-side branch protection — unavailable for a private repository on this plan, returning HTTP 403.

**Evidence.** `7a298ce` initial commit · `8f18069` local push protection · `74f71cb` CODEOWNERS, and a written record of what GitHub can and cannot enforce here.

**Outstanding.** See [GAP-001](COMPLIANCE_GAPS.md) — the same plan limitation blocks required status checks. A merge can still be made past a failing check by anyone with write access.

---

## FND-001 · Workspace skeleton

**Scope.** npm workspaces laid out per [ARCHITECTURE.md](ARCHITECTURE.md) §2; Node pinned.
**Dependencies.** FND-000.

**Acceptance criteria.** Every package and app in §2's tree exists · Node version pinned in `.nvmrc` and used by CI · `npm ci` succeeds from a clean clone.

**Status: complete.** 13 workspaces. Node 24.17.0, pinned and consumed by CI through `node-version-file`.

**Evidence.** `b12f6d5`.

---

## FND-002 · Lint, format and mechanical boundary enforcement

**Scope.** ESLint flat config encoding the ADRs, Prettier, dependency-cruiser.
**Dependencies.** FND-001.

**Acceptance criteria.** Each rule cites the document it enforces · every rule is **negative-tested** — observed to fire against a deliberate violation · module graph enforced in CI.

**Status: complete.** `tests/security/lint-boundaries.spec.ts` runs ESLint over deliberately-violating fixture strings and asserts the specific rule catches each one.

**Evidence.** `f435c33` · later extended in `ea1af7d` (no-console in services) and `6861dc8`.

---

## FND-003 · ADR-0013 (Kysely) and ADR-0014 (decimal.js)

**Scope.** Decide the query builder and the decimal implementation; enforce both mechanically.
**Dependencies.** FND-001, FND-002.

**Acceptance criteria.** Both ADRs written · every compliance bullet names a mechanism that exists · guardian review addressed.

**Status: partial — the mechanical items are done; both ADRs remain `Proposed`.**

This corrects a conflicting report. The enforcement rules **were** completed in `6cd4bcc`, which also fixed two tests that were passing for the wrong reason. What has not happened is the **status transition**: ADR-0013 and ADR-0014 are still marked `Proposed` while the foundation is built on both.

**Evidence.** `a5f7d74` both ADRs · `88a80df` closed ADR-0014's blocking gaps and the test that hid one · `6cd4bcc` enforcement rules and two lying tests.

**Outstanding.** Acceptance review. These are **not** Wave 5 decisions — the database layer and every money primitive already depend on them. Tracked at step 4 of the current plan.

---

## FND-004 · Money primitives

**Scope.** `packages/validation` — decimal, `Money`, `Quantity`, `UnitCost`, rounding.
**Dependencies.** FND-003.

**Acceptance criteria.** One frozen decimal constructor · half-up away from zero, matching PostgreSQL · no float anywhere on a money path · Golden Scenario A exact.

**Status: complete.** 63 tests. Cross-engine rounding is verified against PostgreSQL itself rather than against an assumption.

**Evidence.** `5a88017` · `88a80df` · `be67a75` removed an `x − x` tautology that proved nothing.

---

## FND-005 · Local Docker data plane

**Scope.** PostgreSQL 17 and Redis, dev and test, with the role bootstrap.
**Dependencies.** FND-001.

**Acceptance criteria.** `docker compose down -v && up` produces a working system from scratch ([INFRASTRUCTURE.md](INFRASTRUCTURE.md):257) · `finsoft_app` has neither `SUPERUSER` nor `BYPASSRLS` · builtin locale provider with `C.UTF-8`.

**Status: complete.** `npm run db:verify` asserts 26 properties against the running cluster. CI performs the from-scratch test on every run.

**Evidence.** `12cfe71` · `7b0bc3e` Adminer as opt-in tooling.

---

## FND-006 · Migration framework

**Scope.** Forward-only numbered SQL migrations, checksummed, with an immutable ledger.
**Dependencies.** FND-005.

**Acceptance criteria.** Migrations are reviewable SQL · checksums detect an edited file · the ledger is not writable by the application role · re-running applies nothing twice.

**Status: complete.**

**Evidence.** `a5c6b91` framework and `001_create_tenants` · `ffe2aab` made the ledger read-only to the application role · idempotency proved in `tests/integration/migrations.spec.ts`.

---

## FND-007 / FND-008 · Database framework, tenant context, RLS helpers

**Scope.** Connection ownership, Kysely wiring, `withTenant` / `withGlobal`, RLS policies and the isolation gate. Run as one gate because neither half is demonstrable alone.
**Dependencies.** FND-006.

**Acceptance criteria.** RLS `ENABLE` **and** `FORCE` on every tenant-owned table · app role is not the table owner · every policy has a non-null `WITH CHECK` · isolation proven adversarially, and proven again with each control removed.

**Status: complete.** 36 schema tests, 50 security tests. Isolation is asserted serially, with interleaved requests on one connection, and with transactions genuinely open on separate backends.

**Evidence.** `0526c3f` · `tests/security/tenant-isolation*.spec.ts` · verified on the live staging database.

---

## FND-009 · API skeleton

**Scope.** NestJS app, health endpoints, fail-closed tenant guard, exception filter, zod validation.
**Dependencies.** FND-007/008.

**Acceptance criteria.** Liveness touches no dependency · readiness checks the schema version, not a count · a route without an explicit opt-out is refused · no internal detail in any response (rule 20).

**Status: complete.**

**Evidence.** `b3d976c` · `f6dafdf` closed the gaps and guarded strip-safety at compile and run time.

---

## FND-010 · Structured logging

**Scope.** `packages/observability` — JSON logs, correlation context, redaction. ADR-0016.
**Dependencies.** FND-001.

**Acceptance criteria.** JSON to stdout only · correlation across api and worker · secrets redacted at a single choke point · raw session identifiers never logged · operational logs are not the audit trail.

**Status: complete.** 66 tests. A new package, so ARCHITECTURE §2's package list was amended by ADR-0016.

**Evidence.** `ea1af7d`.

**Outstanding.** ADR-0016 is `Proposed` and unreviewed. It is a **foundation** decision, not a Wave 5 one — the worker and the API both depend on it.

---

## FND-011 · Worker process

**Scope.** `apps/worker` — BullMQ consumer, correlation across the queue hop, graceful shutdown, health probes.
**Dependencies.** FND-010.

**Acceptance criteria.** A job carries the correlation id of the request that produced it · shutdown waits for in-flight jobs · liveness never touches Redis · no fiscal-period bypass.

**Status: partial.**

The process is complete and correct. The **transactional outbox dispatcher** that ADR-0010 specifies — this worker's actual reason to exist — is not built: it needs an `outbox` table, and a migration needs database-guardian review.

**Evidence.** `6861dc8` · `tests/integration/worker-transaction.spec.ts` proves the commit/rollback/redelivery contract at the level the system supports today.

**Outstanding.** The outbox dispatcher. **No longer deferred** — Wave 0 does not close until FND-011 does.

The schema it needs is now built and reviewed: `004_create_outbox.sql` carries the lease and its fence, the transition graph, both attempt budgets, replay integrity and the column-scoped grants, with 40 acceptance cases in `database/tests/outbox.spec.ts` exercising them through direct SQL. [ADR-0010-ERRATUM-001](adr/ADR-0010-ERRATUM-001.md) records the four contract corrections and is unsigned.

What the dispatcher must still demonstrate, per the database-guardian review: a crash after claiming; an enqueue that succeeds while the ack fails; a stale dispatcher unable to ack a reclaimed row; repeated failures reaching each cap; replay preserving evidence; and tenant enumeration respecting access boundaries. Every ack, failure and reclaim asserts `rowcount = 1` — a dispatcher that ignores how many rows it touched cannot detect that it lost its lease. `EXPLAIN (ANALYZE, BUFFERS)` on the claim query against at least 10^6 rows across 50+ tenants is required on the PR; a plan reviewed against ten rows will not be accepted.

**Deferral recorded here rather than only in SQL:** the `outbox` table is **not partitioned**. The key is `created_at` RANGE. Two costs, both accepted deliberately — converting a populated forever-growing table later is a full rewrite under an exclusive lock, and this is the cheapest moment it will ever be; and once partitioned, the claim query has no `created_at` predicate and so must consider every partition on every poll, which is planning-time cost per poll, forever. A detached partition is **retained and archived, never dropped**, and detaching requires a verified backup and Database Guardian sign-off. This is in the register because a deferral that survives only in a comment nobody greps is an omission with a note.

---

## FND-012 · Test framework and fixtures

**Scope.** The FinancialInvariantSuite harness, golden scenarios, and the cross-cutting suites in `tests/`.
**Dependencies.** FND-004, FND-007/008.

**Acceptance criteria.** Deterministic fixtures, isolated per run, with repeatable cleanup · a runnable suite of each kind named in [tests/README.md](../tests/README.md) · meaningful foundation coverage, not directories.

**Status: partial.**

Delivered: accounting (58), schema (36), security (50), integration (20), performance (3), e2e (4). Fixtures are built through the real `withGlobal`/`withTenant` surface with unique naming per run; cleanup is by disposable cluster.

Not delivered: **reconciliation** has no suite. See the scope decision below.

**Evidence.** `7fdc9b5` harness and golden scenarios · `a5093af` foundation suites.

**Outstanding.** Reconciliation scope approval — separate from GAP-001's signatures.

---

## FND-013 · CI pipeline

**Scope.** Gate every push and pull request on the full suite, against a real data plane.
**Dependencies.** FND-012.

**Acceptance criteria.** Typecheck, lint, format, boundaries, smoke, migration ledger, hooks, full tests · real PostgreSQL and Redis, not mocks · images built · secret scanning.

**Status: complete.** Six jobs. The `tests` job stands the compose stack up from scratch, which is INFRASTRUCTURE:257's criterion run on every push.

**Evidence.** `94d0844` · `0c93075` fixed a trigger gap that left feature branches unchecked · secret scanning added in `5cbdb98`.

**Outstanding.** `npm audit` reports one high (postcss via next) and is `continue-on-error` pending an accept-or-upgrade ruling. A deliberately temporary posture, not a decision.

---

## FND-014 · Staging environment

**Scope.** Provision the Contabo host, deploy the stack, gate the deploy on the checks.
**Dependencies.** FND-013.

**Acceptance criteria.** Deploy cannot run unless the checks passed on that exact commit · images deployed by digest · nothing published but the proxy · database credentials never handled by CI · smoke test asks the deployed system whether it works.

**Status: complete.** Deployed and serving at `31.220.74.159`. Readiness reports `schema 3, requires 3`; the worker processes jobs; 5432, 6379, 3001 and 3002 are refused from outside.

**Evidence.** `b8fdc2a` images · `2e8e688` host and gated deploy · `6a4b713` fixed a silent deploy failure · run [35804636168](https://github.com/elitebytesolutions/finsoft/actions/runs/35804636168).

**Outstanding.** No TLS — the box is reached by IP, so session cookies would travel in clear. Nothing involving a real credential should be exercised on staging until it has a hostname and a certificate. Deployment protection rules (required reviewers, self-approval prevention) are unavailable on this plan.

---

## FND-015 · Wave 0 exit criterion

**Scope.** An empty-but-real vertical goes from a branch to staging through the full pipeline, **automatically**.
**Dependencies.** All of the above.

**Acceptance criteria.** One health endpoint · one page · one table · one migration · one test of each kind · deployed automatically, with no manual dispatch.

**Status: blocked.**

Every component exists and has been deployed. The remaining word is **automatically**: the `develop → staging` path has never run. Deployment to date has been by `workflow_dispatch`, which executes every gate and deploys only their artifacts — no bypass — but is a manual trigger.

**Blocked by.** A merge to `develop`, which is a human action. Agents do not merge.

**Outstanding.** "One test of each kind" — reconciliation has none. See below.

---

## FND-016 · *candidate: design-system reconciliation*

**Status: unknown — awaiting restatement or retirement.**

The number was used in planning conversation and its contract was never committed, so it cannot be recovered from the repository.

**Candidate description, not an authoritative contract:** reconciling `packages/ui` and the page specifications in `docs/design-system/` against what `apps/web` actually renders.

That description comes from recollection of a planning discussion. It is recorded so the intent is not lost, and it is explicitly **not** a scope anyone should build against — the register would otherwise be inventing a contract and then reporting progress against its own invention.

**Action required.** Product Owner to either restate it as a real contract with acceptance criteria, or retire the number. Wave 0 should not close with a task in this state.

| Decision | Status |
|---|---|
| Restate or retire | ☐ not recorded |

---

## FND-017 · apps/web lint and build repair

**Scope.** Clear the `no-unused-vars` backlog in `apps/web` and restore the production build.
**Dependencies.** FND-002.

**Acceptance criteria.** `npm run lint` clean · `npm run format:check` clean · `next build` succeeds · no behaviour change.

**Status: complete.**

**Evidence.** `555b8cb` checkpoint · `aa2f3c2`, `a3bae44`, `effe9dc`, `1824dd9` lint cleanup (Product Owner) · `2de5379` Suspense repair, traced to one shared consumer in the app shell rather than six pages · `28664ba` formatting, as its own commit.

---

## FND-018 · *candidate: CLAUDE.md correction*

**Status: unknown — awaiting restatement or retirement.** As FND-016.

**Candidate description, not an authoritative contract:** correcting `CLAUDE.md` where it has drifted from the repository — for instance its "Current state" section, which still reads *"Wave 0 — factory foundation. The constitution exists; the monorepo does not yet."* That sentence is now plainly false, and CLAUDE.md is loaded into every agent's context, so the drift misinforms every session that starts.

Whether that is what FND-018 meant is not established.

| Decision | Status |
|---|---|
| Restate or retire | ☐ not recorded |

---

## Scope decision required — reconciliation coverage

**This is separate from [GAP-001](COMPLIANCE_GAPS.md)'s signatures. Recording either decision does not supply the other.**

Wave 0's exit criterion asks for "one test of each kind". `tests/reconciliation/` has none, and cannot: both kernels are `export {}`, so a test today could only assert that zero equals zero — which would sit in the suite looking like coverage and stay green through every change that later breaks reconciliation for real.

**Proposed.** Amend the exit criterion to exclude reconciliation, and defer the suites:

| | |
|---|---|
| Subledger-to-GL | **Wave 5** — the wave that introduces posting |
| Valuation-to-ledger | **Wave 6** — needs the movement ledger, currently blocked on ADR-0018 |
| Owner | Accounting Guardian for the invariants; QA Engineer for the suites |
| Acceptance criteria | Recorded in [tests/reconciliation/README.md](../tests/reconciliation/README.md) |

The rationale is the plan's own: *"build the factory before building the product."* Building a posting engine early to satisfy a foundation checklist inverts that.

**Reconciliation is not marked delivered.** It is deferred, pending this approval.

**A recommended disposition has been offered:** approve the deferral to the Wave 5/6 contracts above, with no claim that reconciliation coverage exists today. That is a recommendation awaiting signature — it does not tick the box, and the decision remains open.

| Approval | Status |
|---|---|
| Product Owner | ☐ not recorded |

---

## Not in the register

Two things are deliberately absent because they are not Wave 0:

- **The costing and stock ADR backlog** — ADR-0015, 0017 and 0018. ADR-0018 is **rejected** with 19 required changes, and two LEVEL 0 amendments (rules 15 and 16) await signatures. These block Wave 5, not Wave 0.
- **The `outbox` table** — ADR-0010's dispatcher. Needs a migration and database-guardian review; belongs with the wave that introduces posting.
