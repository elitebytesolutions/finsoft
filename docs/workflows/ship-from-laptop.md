# Ship to staging from the laptop

**Status:** Operational, staging only. OPS-003, PO decision 2026-09-29 — GitHub
Actions is unpaid, so the gate runs here instead until billing is on. See
[COMPLIANCE_GAPS.md GAP-005](../COMPLIANCE_GAPS.md#gap-005--the-gate-is-self-attested-while-it-runs-off-the-laptop).

This tool does the equivalent of a risk-tiered CI ([OPS-002](ci-tiers.md))
**"full"** run — `static`, `secrets`, `unit`, `invariants`, `db-suites`,
`financial`, `e2e`, the web build and `audit-gate` — from this machine,
against a fresh throwaway stack, then builds and deploys the tested commit to
Contabo staging. It never touches production — there is no path from here to
Hostinger, by design (`docs/INFRASTRUCTURE.md`).

## Prerequisites

- Windows with Git Bash, or any POSIX shell — the tool itself
  (`tools/ship/staging.mjs`) is plain Node and runs the same everywhere.
- Node, the version in `.nvmrc`.
- Docker Desktop running.
- `ssh vps` working (`~/.ssh/config`: `root@31.220.74.159`, key
  `~/.ssh/id_ed25519`). Test it: `ssh vps 'echo ok'`.
- A clean `git fetch origin` — the tool refuses to ship anything that isn't
  merged to `origin/develop`.

## The one command

```
npm run ship:staging
```

Ships `origin/develop` HEAD. To ship a specific commit instead:

```
npm run ship:staging -- --sha <sha>
```

The commit is **refused** unless `git merge-base --is-ancestor <sha>
origin/develop` succeeds — humans merge, and this tool never ships an
unmerged branch.

### What it does, in order

1. **Resolve and verify the commit** — `git fetch origin`, then the
   ancestor check above.
2. **Check it out clean** — a dedicated worktree at `../finsoft-wt/_ship`
   (a sibling of the primary clone, found via `git rev-parse
   --git-common-dir` so it resolves correctly whether you run the tool from
   the primary clone or from any other worktree), reset to the commit and
   `npm ci`'d fresh every run. Your working copy, however dirty, is never
   used.
3. **Run the full gate** against a throwaway `docker compose` project
   (unique project name, free ports, `down -v` before and after — migrations
   apply from empty, exactly like a CI runner). The data plane is brought up
   **once** and reused across every suite below; that's a local speedup, not
   a weaker guarantee — it's still fresh-from-empty for all of them:
   - secret scan (`tools/security/secret-scan.sh` — pinned, checksummed
     gitleaks; falls back to the `zricethezav/gitleaks` Docker image, loudly,
     if the pinned binary can't run — which it can't on this Windows laptop,
     since the pinned binary is `linux_x64`, so this fallback is the normal
     path here, not a rare one)
   - typecheck, lint, `format:check`, `depcruise`, runtime smoke, migration
     ledger, git hooks, `tools/ci` classifier tests
   - unit tests (all workspaces, no database — mirrors `unit`)
   - the web build (`next build` — mirrors `web-preview`)
   - `test:financial-invariant-suite` — LEVEL 0
     ([NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) §3), mirrors the
     always-on `invariants` job
   - the rest of the financial gate: `test:accounting`, `test:reconciliation`
     (mirrors `financial`)
   - db suites: schema, security (tenant isolation, RBAC), integration,
     performance (mirrors `db-suites`)
   - e2e (Playwright, against a built API and a real browser — mirrors `e2e`)
   - `npm run audit:gate` (mirrors `audit-gate`) — GAP-002's blocking half.
     Fails on any HIGH/CRITICAL finding in a production dependency that
     isn't named, with an owner, a rationale and a live `reviewBy` date, in
     [`tools/ci/audit-allowlist.json`](../../tools/ci/audit-allowlist.json).
     This tool calls that exact script rather than keeping a second copy of
     the policy that could drift from it.

   **Any failure aborts the ship. Nothing is built or deployed.** A gate
   evidence record is still written.
4. **Build on the server** — streams `git archive <sha>` to the VPS (a few
   MB of tracked source, not gigabytes of images), then builds
   `finsoft-{api,worker,web}:<sha>` there with the same Dockerfiles, build
   args and OCI labels CI uses. The build context is deleted afterwards;
   the images are kept. The last 3 SHAs' images are kept for rollback; older
   ones are pruned.
5. **Deploy** — `infrastructure/staging/deploy.sh` in `IMAGE_SOURCE=local`
   mode: no GHCR login, no pull, just a check that the three local tags
   exist, then the same migrate → `up -d` → prune sequence CI's deploy always
   ran. The `IMAGE_SOURCE=ghcr` path (CI's own) is untouched and still works.
   `compose.yaml` and `Caddyfile` are **not** touched or re-copied by this
   tool — only `deploy.sh` is — so the server keeps whatever those two
   currently are; that's deliberate (see Paths/FORBIDDEN in the OPS-003
   task contract) and matches this host's actual state as of this writing
   (HTTPS on `31-220-74-159.sslip.io` is already live there).
6. **Smoke test** — `infrastructure/staging/smoke.sh` against
   `https://31-220-74-159.sslip.io` — the same origin `vars.STAGING_URL`
   points CI's own `deploy-staging` smoke step at, and for the same reason:
   the Caddyfile has exactly one site block, addressed by that hostname, and
   dispatches by Host header — the bare IP matches only a redirect to this
   origin, so testing the bare IP would test the redirect and nothing else.
   Checks: liveness, readiness (schema version), no internal detail leaked
   through the public body, the data plane unreachable from outside,
   plain-HTTP redirecting to HTTPS, and a real page rendered through the
   proxy. **A failing smoke test rolls back automatically** to the previous
   `.env.images` and restarts — never a migration rollback, only the running
   images. It reports the rollback outcome.
7. **Evidence** — a JSON record (SHA, timings, every gate step's
   pass/fail and counts, what was skipped and why, the deploy and smoke
   result) is written to `/opt/finsoft/deploys/<utc-timestamp>-<sha>.json` on
   the server, and to `../finsoft-wt/_ship/.ship-evidence/` locally (not
   committed — and wiped by the next run's worktree clean, so copy out
   anything you want to keep before shipping again; the server copy is the
   durable record).

Nothing prints `.env` contents, JWT keys, passwords, or any other secret.
The output is safe to paste into a chat.

## How long it takes

Dominated by the test gate, not the deploy: expect the full run — `npm ci`,
static analysis, a from-empty data plane, the whole suite including e2e, the
docker builds on the VPS and the deploy — to take **tens of minutes** on a
4-core VPS and a normal laptop, most of it in the test suite. The build +
deploy + smoke portion, once the gate has passed, is a few minutes.

## Rollback

```
npm run ship:staging -- --rollback
```

Restores the last checkpointed `.env.images` on the server
(`/opt/finsoft/deploys/last-good.env.images`, written before every deploy)
and restarts the stack against it. **It never touches migrations** — only
which images are running. If there is nothing checkpointed (e.g. this would
be the very first deploy), it says so and does nothing.

A failing smoke test triggers this automatically; you only need the command
above to roll back by hand.

## Emergencies only: `--skip-gate`

```
npm run ship:staging -- --skip-gate --reason "why this can't wait for the gate"
```

Skips the entire local gate. It does **not** skip the ancestor check — an
unmerged commit is still refused. It prints an impossible-to-miss warning and
records the reason in the evidence file. This is for a documented emergency,
not a shortcut; see
[COMPLIANCE_GAPS.md GAP-005](../COMPLIANCE_GAPS.md#gap-005--the-gate-is-self-attested-while-it-runs-off-the-laptop)
for why the gate's self-attested status already costs something.

## `--gate-only`

Runs the full gate and stops — no build, no deploy. Useful to check a commit
is ship-ready without touching staging. It's also how the "a failing gate
aborts before deploy" refusal path was verified for this tool, without
committing a broken test to any real branch: a step name matched by the
`SHIP_TEST_FORCE_FAIL` environment variable is forced to fail *after* it has
actually run — it can only turn a pass into a failure, never the reverse, so
it's a verification seam, not a way to weaken the gate.

## What is skipped versus CI

**CodeQL only.** It is a GitHub-hosted static analysis action with no free
local equivalent; the tool records it as skipped in the evidence file rather
than pretending to run it. Everything else CI's "full" path checks, this
tool checks too — including reusing CI's own `audit:gate` script and
allowlist rather than a separate copy of that policy.

## Switching back to GitHub CI

Once GitHub Actions billing is active, restore the triggers in
`.github/workflows/ci.yml` — the exact lines (including the nightly
`schedule` OPS-002 added) are in a comment block at the top of that file —
and close
[GAP-005](../COMPLIANCE_GAPS.md#gap-005--the-gate-is-self-attested-while-it-runs-off-the-laptop).
`ship:staging` keeps working afterwards; there is no reason to remove it,
only to stop relying on it as the primary gate.
