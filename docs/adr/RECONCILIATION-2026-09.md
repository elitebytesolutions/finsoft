# Foundation ADR reconciliation — September 2026

**What this is:** every claim in ADR-0013, ADR-0014 and ADR-0016 checked against what the repository actually enforces, and every discrepancy recorded.

**Why it exists:** a LEVEL 1 record is read by the next person as a statement of fact. An ADR that describes a mechanism which does not exist is worse than one that is silent, because the reviewer who trusts it stops looking. These three were written alongside the code they describe, and the code moved.

Each finding is in exactly one bucket:

| Bucket | Meaning |
|---|---|
| **Required fix** | The claim was right and the mechanism was missing. The mechanism now exists, with a negative control |
| **Inaccurate claim** | The mechanism was narrower than the words. The words were corrected; nothing was built |
| **Deferral** | Genuinely not built. Recorded as debt with a reason, and — where it needs one — a named signature that is **not yet given** |

Full detail lives in each ADR's own Compliance section. This file is the index and the count.

---

## Required fixes — built during this review

| # | ADR | Finding | Evidence |
|---|---|---|---|
| R1 | 0013 | **`.dependency-cruiser.cjs` `exclude` listed `node_modules` alongside `doNotFollow`.** `exclude` removes the node *and the edges to it*, so every `^node_modules/` rule — `pg-driver-is-database-package-only`, `kysely-is-allowlisted`, `one-decimal-library` — matched nothing. Inert from the day it was written. The graph reported clean while `pool.ts`, which imports `pg` on line 1, showed one dependency | Graph 273 → 295 modules. Both rules then observed to fire against probe files |
| R2 | 0013 | **The `set_config('app.tenant_id', …)` selector matched `Literal` only.** A template literal's text is a `TemplateElement`, so it missed the sql`` form — which is the form `packages/database` itself writes. The harness exercised only the double-quoted case, certifying a rule that missed the realistic one | `TemplateElement[value.raw=/app\.tenant_id/]` and `TSTypeAssertion` selectors, both negative-tested. `tests/security/lint-boundaries.spec.ts` |
| R3 | 0013 | **`assertGeneratedTypesAreExact` was exercised only against synthetic strings written inside its own test.** A hand-edited or stale `generated/schema.d.ts` passed every gate in the repository | Now run against the committed file. `packages/database/src/guards.test.ts` |
| R4 | 0013 | **The pool opened lazily**, so the numeric-parser assertion and the role check ran on whichever request first touched the database rather than at boot | `apps/api` and `apps/worker` both call `openDatabase()` at startup |
| R5 | 0014 | **`Amount` accepted non-finite values.** A `NaN` amount serialises to a string PostgreSQL accepts as `numeric`, where `NaN = NaN` is TRUE — so an all-NaN journal entry *satisfies* `SUM(debit) = SUM(credit)` and balances nothing | Rejected at construction and again in `fixedOrThrow`. `packages/validation/src/money.ts`, `money.test.ts` |
| R6 | 0014 | **Nothing closed the same hole at the schema layer.** The application guard covers TypeScript only — not a migration, an admin script, psql, or an import, and rule 21 contemplates humans with direct access | `database/tests/numeric-finite.spec.ts`: catalog rule requiring `CHECK (col IS NULL OR col <> 'NaN'::numeric)`, with the engine's behaviour asserted rather than assumed, and the matcher proved to reject the broken `col = col` idiom |
| R7 | 0016 | **The redaction choke point covered the merge object only.** `formatters.log` never sees the message string, so a secret interpolated into one went straight to stdout — and that is the line someone writes while debugging an auth problem | `hooks.logMethod` redacts the message and every interpolation argument. Asserted on the logger's real output, not on `redact()` alone |
| R8 | 0016 | **`.child()` returned an unredacted logger.** pino does not pass child bindings through `formatters.log` | The exported `Logger` type declares six log methods and nothing else, so `getLogger().child(…)` does not compile. `childLogger()` is the sanctioned path and redacts its bindings |
| R9 | 0016 | **`packages/database`'s idle-client error listener printed the password.** `describeTarget` was already safe, but a `pg` connection failure puts the DSN it tried — credentials included — into its **message**, which is neither a denied key nor a token shape | `redactValueShapes()` applied at `packages/database/src/pool.ts`. Tested through the **real listener** by emitting `'error'` on the pool; negative-controlled by reverting the call, which fails with the password in the assertion output |
| R10 | 0016 | **No rule banned `console`** in the applications, so the choke point was one `console.log` away from being optional | `no-console: ['error', {}]` for `apps/api/src/**`, `apps/worker/src/**`, `modules/**`. The empty options object is load-bearing: raising the severity alone inherits `allow: ['warn', 'error']`, which permits the two levels an incident is actually logged at |

### Round 2 — found by the guardian re-review, built in the same pass

| # | ADR | Finding | Evidence |
|---|---|---|---|
| R11 | 0013 | **R1 was not closed.** `dist` was still in the same `exclude` pattern, unanchored, and `node_modules/kysely/dist/index.js` matches it — so `kysely-is-allowlisted` stayed inert *through the review that found R1 and was explicitly hunting for more of it*. Five files import `kysely`; the graph held zero `kysely` edges | Pattern anchored so build output is excluded only outside `node_modules`. Graph 295 to 303 modules, 595 to 678 dependencies, still clean. `kysely` edges 0 to 5 |
| R13 | 0013 | **`sql.raw` and `Migrator` claimed a negative control that did not exist.** Each appeared in the repository exactly twice — in its own selector and in its own message | Both negative-tested. `sql.raw` also carries a **positive** control asserting the `sql` tag is still allowed, so the rule cannot be satisfied by banning the sanctioned form |
| R14 | 0013 / 0016 | **D7 built, not deferred.** The depcruise negative-control harness — nine rules, each proved to fire against a probe written at a path it targets, cruised against the real ruleset | `tests/security/depcruise-negative-control.spec.ts`, covering nine of the seventeen declared rules — ADR-0013 names the eight it does not. Discriminates: a probe violating nothing fires nothing, a probe violating one rule does not trip the others. **Restoring either historical `exclude` pattern turns it red** — verified |
| R15 | 0016 | **The logger boundary had no importer side.** `observability-imports-almost-nothing` constrained what the logger imports; nothing constrained who imports it, so the first `packages/database` edge was legal only because nobody had written a rule | `observability-importers-are-allowlisted` — the kernels, `shared-types`, `ui` and `validation` may not reach it. Required by the Architecture Guardian as the condition of accepting the edge |
| R16 | 0016 | **"Never via `console`" had no mechanism** for the five packages section 2 rules on. The repo-wide warn-level rule stood, so `console.error` was legal — and the ADR's own named first consumer used it | `no-console` raised to error with the allowances cleared for those five, negative-tested per package, with `cli.ts` and test-file carve-outs placed **last** in the flat config (placing them earlier silently re-banned `console` in all three CLIs) |
| R17 | 0014 | **Two-thirds of the freeze claim was untested.** "direct assignment throws" and "`toFixed` is pinned with a non-writable, non-configurable descriptor" had no assertion; the code was right and the claim was unearned. The cited file, `decimal.test.ts`, does not exist | `money.test.ts` asserts both — the descriptor as a descriptor, the throw as behaviour — plus a test asserting what is **not** frozen, so the narrowing in I8 is checkable rather than merely stated |

**R1 and R11 are the pair to remember.** R1 was not a typo; it was a rule that looked correct in review, passed CI every day, and enforced nothing. R11 is the same defect surviving the review that found R1 — because the fix was applied to the token (`node_modules`) instead of to the mechanism: an `exclude` pattern written for our build output will also match a dependency's published directory, since that is what publishing looks like.

Neither was caught by anyone reading the config. Both were caught by someone asking what the rule had ever matched. That question is now R14, and it is why the harness stopped being a deferral.

---

## Inaccurate claims — corrected in the text, nothing built

| # | ADR | The claim | What the mechanism actually does |
|---|---|---|---|
| I1 | 0013 | CHECKSUMS: *"any change to an existing line fails"* | `verify.ts` checks file-vs-manifest **agreement**. Editing a migration and re-running `npm run db:checksums` in the same PR passes cleanly. The manifest is a review aid whose diff must be **read**. The control that does catch an edited migration is `assertAppliedUnchanged`, against `schema_migrations` in the target database — which fired during this work |
| I2 | 0013 | Destructive statements *"route the PR to the required reviewer via branch protection"* | Flagged at severity `review`; the CLI exits 0. Branch protection is unavailable on this plan — [GAP-001](../COMPLIANCE_GAPS.md) |
| I3 | 0013 | *"No tenant-owned table is addressable inside a `withGlobal` block"* | True of the **query builder** — `GlobalDatabase = Pick<Database, GlobalTableName>`, proved with `@ts-expect-error`. A raw `sql` tag inside the block can still name any table; RLS is what stops it there |
| I4 | 0013 | *"that list is the whole list"* of `withGlobal` uses | It omitted the readiness probe and the outbox dispatcher's tenant enumeration. Both legitimate, both now listed |
| I5 | 0014 | *"Any other decimal library in any `package.json` fails the dependency audit"* | Nothing scans `package.json` files. Import-level enforcement is what exists, and `depcruise` is scoped to `apps packages modules` |
| I6 | 0014 | *"…tests included"* for the unconfigured global | `no-restricted-imports` is off for **all** of `packages/validation`, and `money.test.ts` calls `Decimal.set()` on the raw global. The exemption is the clone site *and its own test file* |
| I7 | 0014 | *"under any local binding name"* | It is an identifier allowlist. `import { FinDecimal as Dec2 }` then `Dec2.set(…)` is not matched |
| I8 | 0014 | *"no test or dependency can alter rounding"* | `.set()` throws and `toFixed` is pinned. Prototype methods remain writable, `clone()` returns an unfrozen constructor, and `Amount.value` exposes the raw decimal. Deliberate-act paths, not accidents — and now described as such |
| I9 | 0016 | *"There is no path to the output that skips it"* | There were two. Both closed (R7, R8); the claim now names what the choke point covers |
| I10 | 0016 | *"A raw session id routed through `asSessionCorrelationId` throws"* | It throws unless the value is **a UUID** — it validates shape and cannot know which process minted the value. A session store backed by `randomUUID()` produces ids that pass. What holds the line today is the key-name denial in `redact.ts`, and only because the field is named `sessionCorrelationId` |
| I11 | 0016 | *"No ESLint rule bans `console.log`"* and *"Nothing calls this package yet"* | Both stale in the repository's favour. The ban exists (R10); `apps/api` and `apps/worker` both consume the package |
| I12 | 0014 | A worked verification computed inventory value as `110 × avg → 9533.3334` | The carried value is `13000.0000 − 3466.6667 = 9533.3333`. Recomputing from a rounded average reintroduces the error the method exists to avoid |
| I13 | 0016 | A **test count** was quoted | Counts go stale the first time someone adds a case. Coverage is described instead |

**I1 and I10 are the two that mattered.** Both would have been read as a control by someone deciding not to build one.

---

## Deferrals — not built, and stated as debt

Nothing in this section is approved by having been written down.

| # | ADR | Deferred | Reason, and what closes it |
|---|---|---|---|
| D1 | 0013 | Lint rule for SQL assembled by string concatenation outside the `sql` tag | `"select … where tenant_id = " + t` lints clean today. No decision blocks it; it is unwritten |
| D2 | 0013 | Lint rule for the `types` option on `Pool`/`Client`/query config, and for `pg-types` in any `package.json` | **Open at both layers.** The runtime assertion covers `setTypeParser` and `pg.defaults` but a per-`Pool` `types` map does not alter the module-global parser, so it passes both |
| D3 | 0013 | Codegen drift check in CI | **No longer hypothetical.** It went stale in `b4271b0` — two `COMMENT ON` strings changed and the committed `schema.d.ts` kept the old text while every gate stayed green. Caught by a reviewer reading the file, which is the detection mechanism this deferral says is missing. Highest priority in this table |
| D4 | 0013 / 0014 | `numeric` round-trip integration test, and the negative type test | Both need a `numeric` column; migrations 001–004 create none. Deferred to the wave that adds the first monetary column, where they become writable and non-vacuous |
| D6 | 0014 | Lint rule forbidding float egress (`.toNumber()`, `Number()` on a decimal receiver) | Deferred **in favour of the cheaper fix**: making `Amount.value` internal closes the whole class and costs nothing, since nothing outside the package reads it. Recorded as the next change to `packages/validation` rather than as a rule to write |
| D8 | 0016 | A distinguishable `sessionCorrelationId` minting format | So the guard can reject a value it did not mint rather than accepting any UUID (I10). Not urgent: no session concept exists until ADR-0009, Wave 1, and no session identifier of any kind appears in a log line today |
| D9 | 0016 | `packages/database`'s error listener as a **log line** rather than `console.error`. Now carries a scoped `eslint-disable` with a stated reason, so it is visible rather than silently legal | The credential leak is closed (R9); the structured-logging migration is not. The listener runs inside an `'error'` handler and `getLogger()` throws before `initLogger()`, so a CLI or a test would turn a recoverable idle-socket error into a throw from an error handler. Needs a logger lifecycle `packages/database` does not have |

---

**D7 was withdrawn from this table.** It was filed as debt and called "the highest-value item"; the guardian reclassified it as a blocker on the grounds that R11 is the bill for not having it, arriving inside the review that identified it. Built as R14.

---

## Evidence: every control proved to fail when its mechanism is removed

A green suite proves the tests pass. It does not prove they would notice the thing they were written to notice — and this repository has twice shipped a rule that looked correct, passed CI every day and enforced nothing.

**Graph sizes are not evidence.** "295 modules became 303" says something changed; it does not say which named rule can now fire. `tools/verify-controls.mjs` produces the only evidence that settles it: patch out one mechanism, run one test file, assert a NAMED test fails, restore the file. It ends by comparing the bytes of every file it touched against what it read at the start, so a half-patched tree is an error rather than a surprise.

Run with `npm run verify:controls`. Result at commit `22296e3` plus this change — **10/10**:

| # | Mechanism removed | The named test that failed |
|---|---|---|
| R1 | `options.exclude` lists `node_modules` again | `pg-driver-is-database-package-only`, `kysely-is-allowlisted`, `one-decimal-library` |
| R11 | `options.exclude` lists `dist` unanchored again | `kysely-is-allowlisted` |
| R15 | `observability-importers-are-allowlisted` disabled | `observability-importers-are-allowlisted` |
| R13a | the `sql.raw` selector removed | `catches sql.raw, which does not parameterise` |
| R13b | the `Migrator` selector removed | `catches Kysely's Migrator` |
| R16 | `no-console` not extended to the five packages | `bans console.error in packages/database/src/pool.ts` |
| R2 | the `TemplateElement` selector removed | `app.tenant_id in a TEMPLATE LITERAL` |
| R9 | `redactValueShapes` removed from the pool listener | `redacts the credentials out of the driver message` |
| R5 | `Amount`'s non-finite rejection removed | the NaN / Infinity rejection cases |
| R17 | `toFixed` left writable on the prototype | `pins toFixed, which every money value is serialised through` |

Each `expect` is a specific test name rather than "any failure", because a patch that breaks a suite for an unrelated reason — a syntax error, say — would otherwise read as proof.

### One finding was withdrawn: R12 did not reproduce

The re-review flagged that `zod`, which resolves to `index.d.cts`, produced no edges because no declaration extension was configured — a plausible third instance of the defect that had already appeared twice, and it was recorded here as a required fix.

**Measured against the exact pre-fix config, it is false.** `zod` resolves to `node_modules/zod/index.d.cts` with the six runtime extensions alone, because `exportsFields` and the `types` condition hand enhanced-resolve an exact path and the extension list is never consulted. Adding `.d.ts`, `.d.cts`, `.d.mts`, `.cts`, `.mts` and `.json` moved the graph by **minus one module and zero dependencies**, and gave no rule any coverage it did not already have. Side by side on the pre-fix config: `kysely` 0 edges, `zod` 1 edge.

The config change is reverted. Config added on a theory that measurement contradicts is how a file accumulates settings nobody can justify — and a fix recorded against a defect that does not exist is the same overclaim as a mechanism recorded against a rule that cannot fire, which is what this document exists to remove.

What survives is a standing assertion in the harness that a types-first dependency resolves at all. It passed before the change and after it, so it is a regression guard, not a negative control, and it is labelled as one. Types-first resolution is genuinely load-bearing for every `^node_modules/` rule and nothing else asserted it.

---

## Guardian rulings

### Architecture Guardian — the `packages/database` to `packages/observability` edge

**ACCEPT WITH A REQUIRED CHANGE.** The fallback — dropping the driver's message and emitting `name`, `code` and the safe target — was explicitly rejected: it closes the leak by destroying the diagnosis, and a control that destroys the diagnosis is one the next on-call engineer removes.

The reasoning, recorded because it sets a precedent: *"and NOTHING else" has always been a statement about direct edges, and the mechanism that enforces it has always been a direct-edge allow-list.* `packages/database` already carries `pg`, `kysely` and `node:async_hooks` behind it; a kernel that transitively links a TCP driver and a query compiler is not meaningfully compromised by also linking a JSON formatter. The containment that made this acceptable is not the cruiser config: **`packages/database/src/index.ts` re-exports nothing from observability**, so `getLogger` is not nameable through the allowed edge.

Corrected in the same ruling: the transitive link is **prospective, not present**. Both kernels are empty, with no declared dependencies and no outbound edges. ADR-0016 section 2 now states it in the future tense.

**The required change**, now built as R15: the edge was legal only because nobody had written a rule, and that is the posture that produced R1 and R11.

### Database Guardian — migration 004 manifest immutability

The `CHECKSUMS` line for `004_create_outbox.sql` was committed twice with different values (`c8d8b8c8...` in `1dd0044`, edited to `f9c09068...` in `71de5db`), which `renderManifest`'s "never edit an existing line" forbids. Ruled **amend 004 in place**, on the grounds that ADR-0013 binds on *applied* and IMPLEMENTATION section 11 on *released*, and 004 is neither: both commits are on an unmerged branch, `main` and `develop` are at the initial commit, and staging's `schema_migrations` holds 001-003 only.

Four conditions attached: pre-merge only; the double-commit recorded as a stated exception in the file's revision history with both SHAs and both checksums; ledger evidence attached to the PR showing 004 absent; and **once** — a third revision goes to 005 whatever the branch state says.

Tracked as part of the outbox work, not closed here.

---

## Signatures

These are recommendations for sign-off. **Recording a decision here does not supply the signature**, and no signature has been entered on anyone's behalf.

| Item | Owner | Status |
|---|---|---|
| Scope of this reconciliation, and the deferral of D1–D9 to their stated waves | Product Owner | ☐ not recorded — **D3 and D5 are now closed**, so this covers D1, D2, D4, D6, D7 (built), D8 and D9 |
| The `packages/database → packages/observability` edge (R9) | Architecture Guardian | ✅ **ACCEPTED**, 2026-09-23, conditional on `observability-importers-are-allowlisted`, which is built |
| D5 — adopting `fast-check`, or declining it | Product Owner | ✅ **ADOPTED**, 2026-09-24. Security-reviewed, pinned, D5 closed with property tests |
| [GAP-001](../COMPLIANCE_GAPS.md) — secret scanning cannot block merge | Product Owner **and** Architecture Guardian | ⚠️ **OPEN by decision**, 2026-09-24. Scoped to foundation/staging; production blocked until merge protection is enabled AND a deliberately failing scan is proven to block a merge |

---

## Status of the three ADRs

All three remain **Proposed**. This reconciliation is a precondition for review, not a substitute for it: the corrections above change what each record claims, so the version a guardian accepts must be this one.
