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

**R1 is the one to remember.** It is not a typo; it is a rule that looked correct in review, passed CI every day, and enforced nothing. Every other finding here was found by looking for more of it.

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
| D3 | 0013 | Codegen drift check in CI | No codegen step in the workflow. R3 catches a malformed committed schema; nothing catches a **stale** one |
| D4 | 0013 / 0014 | `numeric` round-trip integration test, and the negative type test | Both need a `numeric` column; migrations 001–004 create none. Deferred to the wave that adds the first monetary column, where they become writable and non-vacuous |
| D5 | 0014 | Property-based generation over `Money.from`'s rejections | Needs a property-testing dependency. **Tooling decision — `fast-check` adoption — pending, Product Owner** |
| D6 | 0014 | Lint rule forbidding float egress (`.toNumber()`, `Number()` on a decimal receiver) | Deferred **in favour of the cheaper fix**: making `Amount.value` internal closes the whole class and costs nothing, since nothing outside the package reads it. Recorded as the next change to `packages/validation` rather than as a rule to write |
| D7 | 0016 | depcruise negative-control harness | `lint-boundaries.spec.ts` covers ESLint rules only. The four boundary rules were verified by hand, once. **R1 is the argument for building this**, and it is the highest-value item in this table |
| D8 | 0016 | A distinguishable `sessionCorrelationId` minting format | So the guard can reject a value it did not mint rather than accepting any UUID (I10). Not urgent: no session concept exists until ADR-0009, Wave 1, and no session identifier of any kind appears in a log line today |
| D9 | 0016 | `packages/database`'s error listener as a **log line** rather than `console.error` | The credential leak is closed (R9); the structured-logging migration is not. The listener runs inside an `'error'` handler and `getLogger()` throws before `initLogger()`, so a CLI or a test would turn a recoverable idle-socket error into a throw from an error handler. Needs a logger lifecycle `packages/database` does not have |

---

## Raised for the Architecture Guardian

**R9 adds the first `packages/database → packages/observability` edge.** It is legal under the rules as written — `observability-imports-almost-nothing` constrains what observability imports, not who imports it — and consistent with ADR-0016 §2, since observability sits beneath everything that logs.

The consequence worth a decision rather than an assumption: **a kernel imports `packages/database`, so a kernel now transitively links against observability.** It still cannot log — `kernel-imports-only-allowed` blocks the direct import and is unchanged — but "the kernels do not reach the logger" is now a statement about the import graph, not about its transitive closure.

Flagged, not assumed. If the Guardian rejects the edge, the fallback is to drop the driver's message and emit `name`, `code` and the safe target instead — which closes the leak at the cost of diagnosability on unusual errors.

---

## Signatures

These are recommendations for sign-off. **Recording a decision here does not supply the signature**, and no signature has been entered on anyone's behalf.

| Item | Owner | Status |
|---|---|---|
| Scope of this reconciliation, and the deferral of D1–D9 to their stated waves | Product Owner | ☐ not recorded |
| The `packages/database → packages/observability` edge (R9) | Architecture Guardian | ☐ not recorded |
| D5 — adopting `fast-check`, or declining it | Product Owner | ☐ not recorded |
| [GAP-001](../COMPLIANCE_GAPS.md) — secret scanning cannot block merge | Product Owner **and** Architecture Guardian | ☐ not recorded — tracked separately, and **not** covered by the first row |

---

## Status of the three ADRs

All three remain **Proposed**. This reconciliation is a precondition for review, not a substitute for it: the corrections above change what each record claims, so the version a guardian accepts must be this one.
