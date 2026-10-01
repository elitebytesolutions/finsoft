# Compliance gaps

**Status:** requires Product Owner and Architecture Guardian sign-off. Nothing here is approved until it is signed.

| Sign-off | Status |
|---|---|
| Product Owner | ☐ not recorded |
| Architecture Guardian | ☐ not recorded |

An entry stays **open** until both boxes carry a name and a date. Acknowledging a gap is not authorising it.

### GAP-001 — Product Owner disposition, 2026-09-24

> **Keep GAP-001 open.** It is acceptable only for foundation/staging; production remains blocked until required merge protection is enabled **and** a deliberately failing secret scan is proven to block merge.

**The gap stays OPEN.** This is a scoped acceptance, not a closure, and the boxes below stay unticked deliberately — acknowledging a gap is not authorising it, and a gap marked signed is one nobody looks at again.

Note what the second condition adds. The earlier recommendation asked for "a mandatory review before any production deployment", which is a promise about attention. This asks for **proof**: a scan made to fail on purpose, and a merge observed to be refused. That is the difference between believing the control works and having watched it work, and it is the right standard here — GAP-001 stopped being hypothetical on 2026-09-23, when a red scan rode through thirteen commits and a merge because nothing required anyone to read it.

**Production is blocked until both hold.** Enabling branch protection is necessary and not sufficient; the second condition is what distinguishes a configured control from a working one.

A register of places where a **LEVEL 0** requirement in [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md) is not fully enforced by a mechanism.

This file exists so that partial enforcement is visible and owned, rather than reported as complete. It does **not** grant an exemption, and being listed here is not approval — a gap stays open until the mechanism exists or the Product Owner and Architecture Guardian accept it in writing.

Do not add an entry to avoid doing the work. The test for an entry is that the control is genuinely unavailable, not inconvenient.

---

## GAP-001 — Secret scanning cannot block merge

| | |
|---|---|
| **Rule** | 20 — Secrets. [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md) §Secrets |
| **Requirement** | *"Secret scanning runs on every PR and blocks merge."* |
| **Status** | **Partially enforced.** The first clause is met; the second is not |
| **Raised** | 2026-09-23, during Wave 0 |

### What is enforced

Gitleaks runs as a required job on every push and every pull request, over the **full history** rather than the diff — a secret committed months ago and deleted since is still in the pack file and still compromised.

- A finding fails the run.
- A scanner that cannot complete **also** fails the run, and reports differently. A broken scanner must never be indistinguishable from a clean repository.
- Findings are redacted, so the value never reaches a CI log.
- The binary is pinned to a version and a recorded SHA256, verified before it executes. That pins the *bytes*; it is not proof of publisher authenticity, since checksum and artifact share an origin. Signature verification is a separate change and is not claimed.
- There is no bypass flag and no environment variable that skips it. A false positive is suppressed in a committed `.gitleaks.toml`, with a reason, which is reviewable.
- **A failing scan prevents deployment**: `deploy-staging` lists `secrets` in its `needs`, so a leak cannot reach a running system.

### What is not enforced, and why

**A failing check cannot prevent a merge on this repository.** Branch protection and rulesets — the mechanisms that make a status check *required* — are unavailable for a private repository on the current plan. Attempts return HTTP 403.

So today the merge button is not gated by anything. A person with write access can merge a pull request whose secret scan failed, and nothing in the repository will stop them. **The clause is not satisfied, and this file exists rather than a claim that it is.**

### OBSERVED, 2026-09-23 — this stopped being hypothetical

The scan was **red for 13 consecutive commits** and the branch merged anyway.

A JWT-shaped test fixture was added to two more files without widening the allowlist that covered the first. Every push after `1dd0044` failed the `secrets` job. Every one was pushed regardless, and the pull request merged to `main` with the check red.

Three things are worth separating, because the ruling depends on which failed:

- **The scanner was correct on every run.** True positive by its own rules, every time.
- **No credential was committed.** The value is the public RFC 7519 example token, which authenticates to nothing.
- **What failed was the human loop** — the only control this gap leaves in place. "Agents do not merge. Every merge is a human decision by someone who can see the failing check" is compensating control 4 below, and it is the one that did not hold.

**The compensating control that DID hold is control 2.** `deploy-staging` lists `secrets` in its `needs`, so a red scan cannot reach a running system. Staging was never deployed from any of those commits, and that is enforced by GitHub rather than by anyone remembering.

So the entry below is accurate and its severity assessment was optimistic. "They reduce the window; they do not close it" is right — and the window was open for thirteen commits without anyone noticing, which is the number that should inform the plan decision rather than the principle alone.

### Compensating controls

1. The scan fails loudly on every push and pull request, so the state is never unknown.
2. Deployment is blocked by `needs`, which is enforced by GitHub and cannot be clicked past.
3. The pre-push hook refuses direct pushes to `main` and `develop`, so changes arrive through pull requests where the check is visible.
4. Agents do not merge. Every merge is a human decision by someone who can see the failing check.

None of these is the required control. They reduce the window; they do not close it.

### What would close it

**Both of these, not either.** Product Owner disposition, 2026-09-24:

1. Required merge protection enabled, so a failing check cannot be merged past.
2. **A deliberately failing secret scan proven to block a merge.** Configured is not the same as working, and this gap's own history is the argument: the scanner was correct on every one of thirteen runs and the merge happened anyway.

The mechanism for (1) is one of:

- A paid GitHub plan on this repository, then a ruleset marking `secret scan` a required status check. This is the intended fix and it is a billing decision, not a technical one.
- Making the repository public, which enables branch protection at no cost — **rejected**: the repository must stay private.
- Moving to a forge where protected branches are available on the current spend.

### Owner

Product Owner. This is a plan decision, not something an agent can implement.

---

## GAP-002 — Dependency vulnerabilities are reported, not gated

| | |
|---|---|
| **Rule** | 20 adjacent — supply chain. No LEVEL 0 clause states this directly; it is recorded here because a known-exploitable dependency in a deployed application is a security exposure with no owner |
| **Status** | **Policy recorded, not yet enforced** |
| **Raised** | 2026-09-23, during Wave 0 |

### The situation

`npm audit` runs in CI as an **advisory** job carrying `continue-on-error: true`. It currently reports one **high** advisory (`postcss`, reached through `next`).

The flag is there for a reason and it is not a good one to keep: a check that is red on every pull request for a reason unrelated to that pull request is a check nobody reads, and its signal is gone within a week. But "advisory forever" means a genuinely exploitable vulnerability ships with the same shrug as a transitive dev-only finding.

### The policy

Recorded explicitly so that it is a decision rather than a default:

| Finding | Disposition |
|---|---|
| **High or critical, exploitable in the deployed application** | **Blocks release.** Not advisory, not deferrable by a flag |
| High or critical, not reachable from deployed code — dev-only, build-time, or an unused code path | Recorded with a **named owner** and a **written rationale** for why it does not block |
| Moderate or low | Recorded with an owner; triaged on a stated cadence |

"Exploitable in the deployed application" means reachable from code that runs in the `api`, `worker` or `web` container. A build-time transitive dependency of a dev tool is not, and saying so requires the rationale above — not silence.

### What has to change

1. Triage the current `postcss` advisory against the test above: is it reachable in the deployed `web` image, or only in the build? Record the answer with an owner.
2. Split the CI job so that **exploitable high/critical fails the build** while the rest reports without blocking. `continue-on-error` on the whole job cannot express that distinction.
3. Remove `continue-on-error` from the blocking half once (2) exists.

Until then the raw report stays advisory, **and this entry is the record that it is a temporary posture rather than an accepted state**.

### Owner

Product Owner for the policy; Security Guardian for the triage.

---

## GAP-003 — MFA deferred to pre-production

| | |
|---|---|
| **Rule** | [ADR-0009](adr/ADR-0009-jwt-access-and-rotating-refresh-tokens.md) §"MFA for privileged roles" (LEVEL 1), hardening the authentication behind rules 7 & 8 (tenancy) and 18 (server-side authorization) of [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md). Production break-glass MFA (rule 21) is **not** deferred |
| **Requirement** | *"MFA (TOTP, with hashed single-use recovery codes) is **mandatory** for any role holding a privileged permission"* — enrolment before the role is effective, step-up for the highest-privilege actions, audited recovery-code use |
| **Status** | **Not enforced. Deferred by decision** |
| **Raised** | 2026-09-27, by the Product Owner's MVP decision ([ADR-0024](adr/ADR-0024-operating-model.md)) |

### Product Owner disposition, 2026-09-27

> **MFA is deferred to pre-production.** The MVP slice ships to staging without it; **production is blocked** until TOTP, recovery codes and step-up re-authentication ship and are tested.

This is a scoped acceptance, not a closure, in the same shape as GAP-001. ADR-0009 considered and **rejected** *"MFA optional for privileged roles"*; nothing here reverses that. The decision is about *when* MFA ships, and production is where it matters.

### What is enforced

- Password authentication, short-lived access tokens, rotating refresh tokens with reuse detection and family revocation (ADR-0009, ADR-0022) — unchanged.
- Server-side permission checks on every endpoint, and RLS beneath them. MFA hardens *who holds* a permission; it is not what enforces it.

### What is not enforced, and why

The MVP journey exercises privileged permissions — `voucher.reverse` and `audit.view` at least — and the demo users hold them **without enrolment or step-up**. A stolen staging password is a stolen privileged session.

### Compensating controls

1. **Staging holds demo data only.** Two demo tenants, seeded; no real business data, no Bhatti Traders records, no production credentials.
2. Production is blocked by this entry. There is no production deployment path in the MVP.
3. `sessions.mfa_at` already exists (migration 005), so recording MFA completion needs no change to a released migration.

None of these is the required control.

### What would close it

All of these, tested against ADR-0009's Compliance MFA test:

1. TOTP enrolment, with the privileged-role grant pending until enrolment.
2. Hashed, single-use recovery codes, with consumption audited.
3. Step-up re-authentication for `period.reopen`, `admin.role_manage` and break-glass.

### Owner

Product Owner for the production gate; Database/Security seat (`security-guardian`) for the implementation, scheduled before the first production release.

---

## GAP-004 — Audit chain head has no external witness

| | |
|---|---|
| **Rule** | 9 — Audit. [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md) §9, as specified by [ADR-0020](adr/ADR-0020-audit-hash-chain-canonicalisation.md) (LEVEL 1) |
| **Requirement** | *"`hash = H(previous_hash \|\| canonical(record))` — a tamper-evident chain per tenant."* |
| **Status** | **Partially enforced.** Alteration within the chain is detected. Tail deletion or a full rewrite by the table owner, a superuser or break-glass is **undetectable** |
| **Raised** | 2026-09-27, Security seat finding F1, in review of migration 009 |

### Scope of the finding, 2026-09-27

> **Acceptable for staging. Production is blocked** until either (a) an ADR-0020 amendment stores periodic `(tenant, seq, head_hash)` checkpoints **outside the database** — in WORM object storage, or signed with a key no database role holds — and the verifier asserts that the head is at or beyond the last checkpoint, or (b) the Product Owner accepts the gap in writing.

Neither has happened. The boxes at the top of this file stay unticked.

### What is enforced

- `finsoft_app` cannot alter or delete audit rows. Table-level `UPDATE` is revoked and `DELETE` was never granted. The `audit_log_no_update`, `audit_log_no_delete` and `audit_log_no_truncate` triggers reject every row write, including one through the `UPDATE (ip)` column grant, which exists only to permit a row lock (ADR-0020 correction notice 3).
- Chain linkage, fork, orphan, self-link and duplicate-hash forgeries are rejected by the constraints and the linkage trigger in ADR-0020 §5.
- `audit:verify`, running as `readonly_support`, names the first break when a row is altered **without** its successors being recomputed, and when a row is removed or renumbered from the middle of the chain.

### What is not enforced, and why

`hash` is unkeyed SHA-256 over a byte format that ADR-0020 publishes, and it has to publish it so the chain can be independently recomputed. **Anyone who can read the chain and write the table can therefore produce valid hashes.** The table owner (`finsoft_migration`) can disable the append-only triggers. A superuser and a break-glass session can do more.

- **Tail deletion.** Disable the triggers, delete the last rows, and re-enable the triggers. `audit_log_prev_fkey` does not stop this, because nothing references the deleted rows. What remains is a valid chain, and `audit:verify` reports **OK**. Measured by the Security seat.
- **Full rewrite.** Rewrite any row, recompute every successor, and the result verifies.

The verifier knows what the chain contains but has no record of **where its head was**. Nothing outside the database holds that fact. ADR-0020:330 claimed the reverse ("still cannot make the hashes link"), and its correction notice 5 withdraws that claim.

### Compensating controls

1. `finsoft_app`, the role every request runs as, has no path to either attack.
2. The owning role is used by migrations only, and break-glass is MFA-protected, time-limited, reason-required, logged and reviewed ([NON_NEGOTIABLES](NON_NEGOTIABLES.md) rule 21).
3. Staging holds demo data only (GAP-003 control 1).
4. Backups taken before an attack still hold the earlier head. **Nothing compares them today**, so this is recovery evidence, not detection.

None of these is the required control.

### What would close it

One of these:

1. **An ADR amending ADR-0020** that takes periodic `(tenant_id, seq, head_hash)` checkpoints and stores them outside the database, either in WORM object storage or signed with a key that no database role holds. `audit:verify` would fail when the current head is behind the last checkpoint, or when the row at a checkpointed `seq` no longer carries the checkpointed hash. Tampering would still be possible within the last checkpoint interval. The ADR must state that interval.
2. **The Product Owner accepts the gap in writing** for production, naming the residual exposure above.

### Owner

Product Owner for acceptance and the production gate. Security seat (`security-guardian`) for the checkpoint design. Architecture Guardian for the ADR-0020 amendment.

---

## GAP-005 — The gate is self-attested while it runs off the laptop

| | |
|---|---|
| **Rule** | On top of GAP-001 and GAP-002. Rule 20's *"Secret scanning runs on every PR and blocks merge"* and the general premise that CI results are independently produced |
| **Status** | **Accepted, scoped, staging only** |
| **Raised** | 2026-09-29, PO decision (OPS-003) |

### The decision

> Until GitHub Actions is paid for, the gate runs on the laptop and staging is deployed from the laptop at zero cost — no GitHub Actions minutes, no GHCR storage. GitHub CI must be restorable later with a one-line change.

`.github/workflows/ci.yml` now triggers on `workflow_dispatch` only (see the comment block at the top of that file for the exact lines to restore, including the nightly `schedule` OPS-002 added). `npm run ship:staging` (`tools/ship/staging.mjs`) runs the equivalent of risk-tiered CI's ([docs/workflows/ci-tiers.md](workflows/ci-tiers.md)) "full" path — static analysis, secret scan, the full test suite including the FinancialInvariantSuite, the web build, the blocking `audit:gate` — against a fresh throwaway stack, then builds and deploys to Contabo staging. Full flow: [docs/workflows/ship-from-laptop.md](workflows/ship-from-laptop.md).

### What is enforced

Every gate step CI's "full" path would have run still runs, and a failure still stops the ship before anything is built or deployed — nothing here is skipped, weakened, or made optional. The refusal to ship an unmerged commit is unconditional, including under `--skip-gate`. It reuses the same canonical tools CI does — `npm run audit:gate` against `tools/ci/audit-allowlist.json`, not a separate copy of that policy — so GAP-002's disposition cannot drift between the two paths.

### What is not enforced, and why

**The result is self-attested.** The person running `ship:staging` runs the gate on their own machine and could, in principle, edit the tool or skip a step no evidence would catch — there is no independent third party (GitHub) producing the result the way CI did. This is strictly weaker than GAP-001's world, where at least the check ran somewhere the operator didn't control, even though nothing blocked merging past it.

**Compensating controls:**

1. `--skip-gate` requires a written `--reason`, prints an unmissable warning, and is recorded in the evidence file (`/opt/finsoft/deploys/<timestamp>-<sha>.json`) — an emergency bypass is never silent.
2. The tool refuses to ship anything that is not an ancestor of `origin/develop` — it cannot be pointed at an unmerged branch.
3. Evidence is written to the staging server itself (`/opt/finsoft/deploys/`), outside the operator's local control, with per-step pass/fail and durations.
4. CodeQL cannot run locally for free and is recorded as **skipped** in the evidence, never silently dropped.
5. This posture is **staging only**. It changes nothing about production: production was already blocked by GAP-001, GAP-003 and GAP-004, and stays blocked — no agent and no laptop tool has a path to Hostinger.

### What would close it

Restore the `push`/`pull_request`/`schedule` triggers in `ci.yml` (the exact lines are in that file's header comment) once GitHub Actions billing is active. That gives back an independently-run gate and this entry closes; GAP-001 through GAP-004 are unaffected by it either way.

### Owner

Product Owner (billing decision) / DevOps Guardian (restoring the workflow).

---

## GAP-006 — Chart-of-accounts create has no database-privilege backstop (R2)

| | |
|---|---|
| **Rule** | [`coa-standard.md`](posting-rules/coa-standard.md) §8.7 R2, hardening rules 4, 7 and 9 of [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md) (no hard delete / structural drift of the chart; tenant isolation; audit) via Invariant 9 (subledger/control-account reconciliation) |
| **Requirement** | The chart-of-accounts user-create path must be **structurally** unable to insert a header, a control account, a role-holding account or a restricted account — enforced at the database-privilege layer, not only in application code — via a `SECURITY DEFINER` seeding function owned by a dedicated `NOLOGIN`, `NOBYPASSRLS` role that owns nothing else |
| **Status** | **Not enforced. Deferred by decision (R2 option (b): merge now, close later)** |
| **Raised** | 2026-09-29, M2-C Council review (Security seat) |

**Also tracked as [TD-016](TECH_DEBT.md#td-016--coa-standardmd-87-r2s-database-privilege-backstop-is-not-built--blocked-on-a-new-database-role)** (renumbered from TD-012 at the M2-C/M3-P merge, 2026-10-01) — the implementation-detail record for whoever picks up the fix; this entry is the LEVEL-0-adjacent, sign-off-tracked one. Read both.

### Council disposition, 2026-09-29

> **R2 is option (b): merge now.** Production stays blocked until R2 is done.

This accepts the application-layer enforcement (`chartOfAccounts.create`, `packages/accounting-kernel/src/chart-of-accounts.ts`, hardcodes `kind='POSTABLE'`, `control_kind='NONE'`, `role=NULL`, `restricted=false` — no request field admits anything else) plus R7 (`accounts_tenant_ar_ap_control_key`, migration 018 — at most one `AR`-control and one `AP`-control account per tenant, structurally, for every role) **for develop and staging only**, where tenants hold demo data. It does not accept the database-privilege half of R2 for production.

### What is enforced

- The application layer: no code path in `chartOfAccounts.create` can be made to write a header, a control kind, a role, or `restricted = true` — there is no field for it in the command shape, checked by `validateCreatePayload`'s `requireKnownKeys`.
- R7's unique index (`accounts_tenant_ar_ap_control_key`, migration 018): a second `AR`- or `AP`-control account cannot be **stored**, by any role, including `finsoft_migration` — this closes the specific configuration TD-011 worried about, independent of R2.
- Every other database requirement in `coa-standard.md` §8.7 (R1, R3–R11) is built and tested (migration 018, `database/tests/accounting-acl.spec.ts`, `journal-lines.spec.ts`, `migration-ownership.spec.ts`).

### What is not enforced, and why

`finsoft_app`'s column-scoped `INSERT` grant on `accounts` still includes `kind`, `control_kind`, `role` and `restricted` (migration 010, unchanged) — the same grant tenant provisioning (`seedChartOfAccounts`) uses. A bug in `finsoft_app`'s **own** code (not a crafted HTTP request, which the kernel's fixed values already foreclose) could still reach those columns; nothing at the privilege layer refuses it. Closing this needs a `SECURITY DEFINER` seeding function owned by a role that is `NOLOGIN`, `NOBYPASSRLS`, and "owns nothing else" (Security seat, S4 exception (c) — see [ADR-0028](adr/ADR-0028-module-packaging-and-runtime.md) §9's 2026-09-29 note). The one existing such role, `finsoft_refresh` (migration 006, ADR-0023 §2), already owns `auth_lookup.resolve_refresh`, so reusing it would fail "owns nothing else" for both functions. A fresh role can only be created in `infrastructure/docker/postgres/init/00-bootstrap.sh` (`finsoft_migration` has no `CREATEROLE`) — infrastructure work, not a migration.

Also not yet enforced at the database level: **R12** (`updated_by` must equal the user in context) has no database-level check — it is set correctly by `updateAccountRow` (`packages/database/src/accounting/accounts.ts`), but nothing at the trigger or grant layer stops a different value being written by a caller that bypasses the kernel (the same class of gap as the rest of R2 — an application-layer guarantee, not a structural one).

### Compensating controls

1. Every reachable path (the real HTTP API, the real kernel) cannot produce a header/control/role/restricted account or a wrong `updated_by` — this is proven by `tests/integration/accounts-create-edit.spec.ts` and the kernel's own unit tests, not merely assumed.
2. R7's structural index means even a hypothetical bug that reached `control_kind` could not create a second `AR`/`AP` control account — the specific failure Invariant 9 depends on.
3. Develop and staging hold demo/test data only (same posture GAP-003 and GAP-004 already rely on) — the blast radius of a `finsoft_app`-code bug reaching these columns is a corrupted demo chart, not a real business's books.
4. Production has no deployment path today (GAP-001, GAP-003, GAP-004) and this entry adds a fourth, independent block specific to chart-of-accounts maintenance.

### What would close it

1. A new `NOLOGIN`, `NOBYPASSRLS` database role (for example `finsoft_coa_seed`) added to `infrastructure/docker/postgres/init/00-bootstrap.sh`, granted to `finsoft_migration` `WITH INHERIT FALSE, SET TRUE` (the `finsoft_refresh` pattern).
2. A follow-up migration: the seeding function created as `finsoft_migration`, `SET search_path = pg_catalog, public`, `ALTER FUNCTION ... OWNER TO finsoft_coa_seed`, `REVOKE EXECUTE ... FROM PUBLIC` then an explicit `GRANT EXECUTE ... TO finsoft_app`; `finsoft_app`'s `INSERT` on `accounts` narrowed to drop `kind`/`control_kind`/`role`/`restricted`; `seedChartOfAccounts` and `tools/seed/backfill-accounting.mjs` routed through the new function.
3. `database/tests/schema.spec.ts` asserting the new role is `NOLOGIN`, `NOBYPASSRLS`, and owns exactly that one function (the S4 exception (c) condition `migration-ownership.spec.ts` already enforces the *shape* of, pending the role existing to assert against).
4. A database-level check or trigger for R12 (`updated_by` matches the session's context, for every role), closing the companion gap named above.

### Owner

Database Guardian / DevOps Guardian (owns `00-bootstrap.sh`), with the Security seat on the exact role shape and the T2 Database/Security review the new migration needs.

---

## Adding an entry

State the rule and quote the requirement. Say precisely what *is* enforced and what is not — a gap described vaguely reads as smaller than it is. List compensating controls without dressing them up as equivalents. Name what would close it, and who owns that. Date it.
