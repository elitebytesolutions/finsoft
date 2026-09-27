# Risk-tiered CI (OPS-002)

**Status:** Operational. Records what runs when, why, and what is honestly still
not enforced.

Approved by the Product Owner, 2026-09-27: keep secret scanning, the static
checks and the FinancialInvariantSuite on every push; run the database gate,
the rest of the financial gate, end-to-end and image publication only when
the changed paths warrant it, or unconditionally on develop, a release
branch, a manual dispatch or the nightly schedule. Nothing is removed — it is
scheduled by risk.

---

## The one thing tiering may never touch

[`docs/NON_NEGOTIABLES.md`](../NON_NEGOTIABLES.md) §3 is LEVEL 0:

> A dedicated test suite that runs on **every PR**, not nightly. If it fails,
> nothing merges — no exceptions, no `--skip`, no "flaky, re-run".

The `invariants` job runs `test:financial-invariant-suite` on **every tier,
every push, unconditionally** — it is not gated by `classify` at all. A
one-line documentation fix and a rewrite of the posting engine both run it.
The REST of the financial gate — full `test:accounting` (golden scenarios,
cross-engine rounding), `test:reconciliation` — is legitimately scoped to T3
in the `financial` job, because those are not the suite rule 3 names.

If you are ever asked to move the FinancialInvariantSuite to nightly-only "to
make CI faster": don't. That is exactly the change rule 3 forbids, and
`classify.mjs` is written so it cannot express it — `runInvariants` is a
constant `true`, not a function of tier.

---

## How classification works

[`tools/ci/classify.mjs`](../../tools/ci/classify.mjs) looks at the files
changed relative to the merge-base with `origin/develop` (or an explicit
`--base`/`--files` list) and, per file, finds the **highest** tier whose
globs in [`tools/ci/risk-tiers.json`](../../tools/ci/risk-tiers.json) match
it. The overall tier is the highest across all changed files. A path that
matches no tier's globs at all is **not** treated as low-risk — it fails
safe UP to T1, never down to T0.

| Tier | What it covers | What runs, beyond the always-on jobs |
|---|---|---|
| **T0** | `docs/**`, `**/*.md`, `apps/web/src/mocks/**`, `ui-prototype/**` | Nothing extra. A web-preview build if `apps/web` itself changed. |
| **T1** | `apps/web/**`, `apps/api/src/**`, `apps/worker/**`, `modules/*/{api,ui}/**`, `packages/{ui,observability,reporting}/**`, `tools/**` | e2e, if web/api/worker actually changed. |
| **T2** | `packages/{auth,permissions,database,shared-types}/**`, `database/**`, an auth/tenant guard, `infrastructure/**`, `.github/**`, `.githooks/**`, root `package.json`/`package-lock.json`, `tests/security/**`, `tests/integration/**` | T1's e2e trigger (if applicable) + the full database gate (schema, tenant isolation, integration, performance, schema-drift check) + CodeQL. |
| **T3** | `packages/{accounting-kernel,inventory-kernel,validation}/**`, `modules/*/{domain,application}/**`, `docs/posting-rules/**`, `tests/accounting/**`, `tests/reconciliation/**` | Everything T2 gets, plus the rest of the financial gate. |

**Always, on every tier, every push:** `static`, `secrets`, `unit` (workspace
tests, no database), `invariants` (the FinancialInvariantSuite), `audit-gate`
(GAP-002's blocking half — see below).

**"Full" overrides tiering entirely** and runs everything, regardless of what
changed: a push to `develop`, a push to `release/*`, `workflow_dispatch`, and
the nightly `schedule` (`0 21 * * *` UTC = 02:00 PKT). This is also when
`deploy-staging` can run and when container images are published.

## Images

Each of `api`, `worker`, `web` is rebuilt only when its own paths (or a
shared package it actually depends on — see the `images` map in
`risk-tiers.json`) changed. On a PR or feature push, a changed image is built
and **not** pushed — proving it still builds. On a full run:

- A **changed** image is built and pushed as both `:${{ github.sha }}` and
  `:develop`.
- An **unchanged** image has its existing `:develop` digest retagged to
  `:${{ github.sha }}` with `docker buildx imagetools create` — no rebuild,
  so it stays the exact bytes that already ran on staging. This falls back to
  a full build+push only if `:develop` does not exist yet (the first full run
  on a fresh repository).

This is what keeps `infrastructure/staging/deploy.sh` — which pulls
`:$SHA` for all three images unconditionally — working without any change to
it: every full run, all three tags exist, whether or not all three images
were rebuilt.

## Dependency audit (GAP-002)

[`docs/COMPLIANCE_GAPS.md`](../COMPLIANCE_GAPS.md) GAP-002 records the policy:
an exploitable high/critical finding in a production dependency blocks;
everything else is recorded and reported. Two jobs implement it, always:

- `audit-gate` — `npm run audit:gate` (`tools/ci/audit-gate.mjs`). Runs
  `npm audit --omit=dev`; any HIGH/CRITICAL finding fails the run **unless**
  it is named in [`tools/ci/audit-allowlist.json`](../../tools/ci/audit-allowlist.json)
  with an owner, a written rationale, and a `reviewBy` date that has not
  passed. Adding or extending an allowlist entry is a Security Guardian /
  Product Owner decision, not something to wave through in a PR that needs
  it to pass.
- `audit` — the original advisory job, unchanged: `npm audit --audit-level=high`
  with `continue-on-error: true`, reporting everything (dev dependencies,
  moderate/low findings) without blocking anything.

## Local commands

- **`npm run check`** — the fast, no-Docker local gate: classify, typecheck,
  lint on changed files only, `format:check`, `depcruise`, and every
  workspace's unit tests. Target ≤90s on a warm install. This is what
  `.githooks/pre-push` runs now, replacing what used to be inlined there —
  the two can no longer drift apart.
  - On a change that looks T2 or T3, `npm run check` prints a notice (not a
    block) to run `npm run check:full` before opening the pull request.
- **`npm run check:full`** — brings the data plane up (`npm run db:up --
  --wait`) and runs `npm run verify` (typecheck/lint/depcruise/
  `db:migrate:verify`/`format:check`/`npm test`, where `npm test` includes
  `test:gate` — schema, security, accounting, reconciliation, integration,
  performance) plus `npm run test:e2e`.
- **`npm run test:ci-tools`** — `node --test tools/ci/classify.test.mjs`,
  the classifier's own test suite. Part of the `static` job: if the
  classifier is wrong, every gate downstream of it is wrong too, silently.

Override: `workflow_dispatch` on any branch runs everything ("full"),
including a staging deploy attempt — this is how a deploy is exercised
without merging to `develop` first.

## What this does not claim

**GitHub Free cannot make any check a required, merge-blocking status.**
See [`docs/COMPLIANCE_GAPS.md`](../COMPLIANCE_GAPS.md) GAP-001 and
[`git-policy.md`](git-policy.md) — branch protection and rulesets return 403
on this plan. Every job described above runs and reports honestly, including
the ones that are LEVEL 0 (`secrets`, `invariants`, `audit-gate`), but a
person with write access can still merge a pull request with a red check.
The compensating controls are the same ones GAP-001 already names: the scan
fails loudly, `deploy-staging` cannot start unless the run's own jobs passed
in this run, `.githooks/pre-push` refuses direct pushes to `main`/`develop`,
and agents do not merge. None of that is the same as GitHub refusing the
merge button, and this document does not pretend otherwise.
