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

## Adding an entry

State the rule and quote the requirement. Say precisely what *is* enforced and what is not — a gap described vaguely reads as smaller than it is. List compensating controls without dressing them up as equivalents. Name what would close it, and who owns that. Date it.
