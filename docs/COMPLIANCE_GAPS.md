# Compliance gaps

**Status:** requires Product Owner and Architecture Guardian sign-off. Nothing here is approved until it is signed.

| Sign-off | Status |
|---|---|
| Product Owner | ☐ not recorded |
| Architecture Guardian | ☐ not recorded |

An entry stays **open** until both boxes carry a name and a date. Acknowledging a gap is not authorising it.

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

### Compensating controls

1. The scan fails loudly on every push and pull request, so the state is never unknown.
2. Deployment is blocked by `needs`, which is enforced by GitHub and cannot be clicked past.
3. The pre-push hook refuses direct pushes to `main` and `develop`, so changes arrive through pull requests where the check is visible.
4. Agents do not merge. Every merge is a human decision by someone who can see the failing check.

None of these is the required control. They reduce the window; they do not close it.

### What would close it

Any one of:

- A paid GitHub plan on this repository, then a ruleset marking `secret scan` a required status check. This is the intended fix and it is a billing decision, not a technical one.
- Making the repository public, which enables branch protection at no cost — **rejected**: the repository must stay private.
- Moving to a forge where protected branches are available on the current spend.

### Owner

Product Owner. This is a plan decision, not something an agent can implement.

---

## Adding an entry

State the rule and quote the requirement. Say precisely what *is* enforced and what is not — a gap described vaguely reads as smaller than it is. List compensating controls without dressing them up as equivalents. Name what would close it, and who owns that. Date it.
