# Git policy

**Status:** Operational. Records what is enforced, by what, and what is not.

[IMPLEMENTATION.md §10](../IMPLEMENTATION.md) states that an agent never merges
its own PR. This document says how that is upheld today, and — more importantly
— where it is upheld by discipline rather than by a control.

---

## What is enforced, and by what

| Rule | Enforced by | Bypassable? |
|---|---|---|
| No direct push to `main` or `develop` | `.githooks/pre-push` | **Yes** — `--no-verify`, or a clone that never ran `npm install` |
| No deletion of `main` or `develop` | `.githooks/pre-push` | **Yes**, same |
| Typecheck, lint on changed files, unit tests before a feature push | `.githooks/pre-push` | **Yes**, same |
| Full required checks on every PR | GitHub Actions (FND-013) | No — but the result cannot be made a *merge requirement* |
| Applied migrations are immutable | `CHECKSUMS` manifest + the runner | No |
| Module boundaries | `dependency-cruiser`, ESLint | No |
| Tenant isolation | PostgreSQL RLS + role grants | No |

## What is not enforced

**Branch protection, rulesets and secret scanning are unavailable.** This
repository is private on a GitHub Free plan. Verified, not assumed:

```
PUT  /repos/:owner/:repo/branches/main/protection   403  "Upgrade to GitHub Pro
                                                           or make this repository public"
POST /repos/:owner/:repo/rulesets                   403  same
PATCH /repos/:owner/:repo  (secret_scanning)        422  "Secret scanning is not
                                                           available for this repository"
```

So: required pull requests, required status checks, and blocked force pushes
cannot be configured. GitHub Actions **is** enabled, so CI runs on every pull
request and fails visibly — it simply cannot gate the merge button.

**Human-only merging is procedural, not a security boundary.** Agents operate
with the maintainer's credentials. Anything the maintainer can do, an agent
can do. The separation is a working agreement, and it is worth being honest
that it would not survive a determined mistake.

**Secret scanning runs in CI, not at the platform.** `NON_NEGOTIABLES` rule 20
and `INFRASTRUCTURE §6` both require scanning that blocks merge. GitHub's own
is unavailable, so FND-013 runs `gitleaks` as a CI job. It reports; it cannot
block.

---

## Agent policy

Agents may:

- create and push `feature/*` branches
- open pull requests
- push follow-up commits to their own feature branch

Agents may **not**:

- push to `main` or `develop`, ever, for any reason
- merge any pull request, including their own
- use `--no-verify`, or otherwise route around the pre-push hook
- delete a branch they do not own
- deploy

A Council seat's review happens in-session and is recorded in the pull request.
It is not a GitHub approval, because an agent has no GitHub identity.

## Reviewers by tier

The PR's tier is the highest tier any changed path reaches
([OPERATING_MODEL.md §4](../OPERATING_MODEL.md), [ADR-0024](../adr/ADR-0024-operating-model.md)).
Every tier runs secret scanning and the FinancialInvariantSuite.

| Tier | Change | Reviewer recorded in the PR |
|---|---|---|
| T0 | docs, copy, prototype UI | one peer agent |
| T1 | normal UI/API behaviour | one peer agent; `packages/ui/**` → design-system |
| T2 | auth, permissions, tenancy, migrations, infra, CI | named Council seat: Database/Security, or Architecture for `packages/database/**` and guards; devops-guardian for infra and CI |
| T3 | posting, money, inventory, tax, periods | Accounting seat, plus Architecture for the kernels |

A seat's rejection is final within its domain. Disputes go to the Technical
Council, and to the Product Owner only under ADR-0024's escalation criteria.

## Maintainer workflow

Unchanged by ADR-0024: humans merge, and [GAP-001](../COMPLIANCE_GAPS.md) is
still open.

1. Agent pushes `feature/<ID>-…` and opens a PR against `develop`, naming the
   tier and the Council seat that reviewed it.
2. CI runs the required checks for that tier; `develop` runs everything.
3. Maintainer confirms the checks passed **on the head commit of that PR**, reads
   the diff, and merges by hand.
4. Deployment happens only after checks pass **on the exact commit being
   deployed** — reaching `main` is not itself evidence, since nothing enforces
   that a commit arrived there through CI.

## Setup

`npm install` installs the hook, via `prepare` → `tools/hooks/install.mjs`,
which sets `core.hooksPath` to the tracked `.githooks` directory. Git hooks
live in `.git/hooks` and are never cloned, so without this a committed hook
does nothing.

`core.hooksPath` is repository-level config and worktrees share it with the
main repository, so a new worktree inherits the hook.

```bash
npm run hooks:verify     # asserts git will actually run it
```

Verify after cloning, after creating a worktree, and any time `git config` has
been edited by hand.

---

## What would make this real

Two changes, independent of each other:

1. **GitHub Pro on the account** — enables branch protection and rulesets, so
   required PRs, required status checks and blocked force pushes stop being
   procedural.
2. **A separate GitHub App identity for agents** — then the PR author and the
   approver are different identities, required approvals can be raised above
   zero, and `CODEOWNERS` starts carrying weight instead of only routing.

Until then, the honest summary is: the machinery that protects *correctness* —
migrations, boundaries, tenant isolation, invariants — is real and
unbypassable. The machinery that protects *process* is a speed bump.
