# ADR-0016: Structured logging in a dedicated observability package

**Status:** Proposed
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

[INFRASTRUCTURE §8](../INFRASTRUCTURE.md) specifies the observability stack as structured JSON logs shipped to an aggregator, with `request_id` correlating a trace across `apps/api` and `apps/worker`. [IMPLEMENTATION.md](../IMPLEMENTATION.md)'s Definition of Done requires structured logging for business events. Neither says where the logger lives or what it may not do.

Two constraints make that placement question load-bearing rather than cosmetic.

**`packages/` is a closed list.** [ARCHITECTURE §2](../ARCHITECTURE.md) enumerates nine packages. A logger belongs in none of them: it is not validation, not shared types, not a kernel. Putting it in `packages/shared-types` (which everything already imports) would make a stdout-writing side effect reachable from `apps/web`, and putting it in `packages/database` would mean nothing could log without importing the database.

**A logger is the most likely place in the system to leak a secret.** [NON_NEGOTIABLES rule 20](../NON_NEGOTIABLES.md) — secrets are never logged — is not enforced by anything today, and logging is the one thing people add in a hurry while debugging something else. A logger that does not redact by construction is a rule 20 violation waiting for a production incident.

## Decision

### 1. A new package, `packages/observability`

**This amends [ARCHITECTURE §2](../ARCHITECTURE.md)'s package list**, which is LEVEL 1 and so is amendable by this ADR. The tree gains one entry:

```
├── packages/
│   └── observability/       Structured logging, correlation context, redaction
```

### 2. It sits beneath everything that logs, and imports almost nothing

```
apps/api, apps/worker              ──► observability
modules/*/{api,application,infrastructure} ──► observability
observability                      ──► shared-types, and node core
```

Three boundaries, and each is mechanically enforced rather than documented:

| Boundary | Why | Enforced by |
|---|---|---|
| **Kernels may not log** | ARCHITECTURE §5 is an allow-list of three packages, and "and NOTHING else" is the strongest sentence in that document. Widening it for a logger would be the first exception, and the next one would be easier | `kernel-imports-only-allowed` — already an allow-list, so it blocks this with no change |
| **`modules/*/domain` may not log** | The domain layer is pure TypeScript with no I/O. It returns a result or throws; the application layer that called it decides what is worth a line | `domain-does-not-log` (new) |
| **`apps/web` may not log** | A server logger in a browser writes to a console nobody reads, and would drag `node:async_hooks` into a bundle | `web-is-ui-only`, extended |
| **Observability imports no first-party package except `shared-types`** | It is beneath everything that logs. A dependency here would be reachable from every layer that logs, making the logger a back door into it. `shared-types` is the exception the diagram above already shows, and the rule already permits | `observability-imports-almost-nothing` (new) |
| **Only an allow-listed package may import it** | The converse, and it did not exist until `packages/database` became the first importer — which was legal only because nobody had written a rule. That is the posture that let the `exclude` defect survive two reviews | `observability-importers-are-allowlisted` (new) |

**All five rules in the table are proved to fire** against deliberately-violating probes, per this repository's standing rule that a rule which has never fired is a comment. The proof is `tests/security/depcruise-negative-control.spec.ts`, which cruises each probe against the real ruleset rather than a restatement of it — not, as this paragraph said while the harness was being built, a hand observation made once.

**The remaining packages may log, through this package only.** `packages/database`, `auth`, `permissions`, `reporting` and `validation` are beneath the modules but above the kernels, and the table above was silent on them. They are permitted — a connection pool that cannot report a failed connection is worse than one that can — but only via `@finsoft/observability`, never via `console`. `packages/validation` in practice should not need to: it is pure computation, and a validation failure is a thrown error, not a log line.

**"Never via `console`" is a rule, so it has a mechanism.** `no-console: ['error', {}]` now covers those five packages as well as the services, negative-tested per package. It did not, when this paragraph was first written: the repo-wide `['warn', { allow: ['warn', 'error'] }]` stood for `packages/**`, so `console.error` was legal and `console.log` was a warning — and this ADR's own named first consumer, `packages/database/src/pool.ts`, used it. A boundary stated in a LEVEL 1 record with nothing behind it is the failure this record was reviewed to remove, so it is not stated that way here.

Two carve-outs, both negative-tested: a `cli.ts`, whose output *is* stdout, and a test file, because the test proving the pool redacts a password has to be able to name `console` to capture it. They sit last in the flat config on purpose — ESLint replaces rule options between blocks rather than merging them, so placing them earlier silently re-banned `console` in all three CLIs.

The kernels are deliberately **not** in that list. A kernel may not log at all, which is a dependency-cruiser rule; adding a console ban there would make the weaker mechanism look like the one doing the work.

**A kernel that cannot log is a deliberate cost, not an oversight.** The posting engine and the inventory kernel are where the most interesting failures happen. They surface them by throwing a typed domain error, which the application layer logs with full correlation. The alternative — a logger inside the kernel — buys convenience at the price of the boundary that keeps the kernels testable without a runtime.

### 3. pino, with the configuration frozen in one place

pino is the implementation. It serialises directly to JSON without an intermediate string format, and it is fast enough that nobody is tempted to make logging conditional to claw back latency on the posting path — a temptation that ends with the posting path being the least observable code in the system.

Fixed choices, and the reasons they are not defaults:

| Choice | Reason |
|---|---|
| JSON to **stdout only** | INFRASTRUCTURE §8. The process does not know where its logs go; the platform decides. A logger that writes files or ships them itself breaks in a container |
| `level: "info"`, not `30` | An aggregator query should not need a numeric decoder ring |
| **ISO 8601** timestamps, not epoch millis | Readable at the moment someone is reading logs because something is wrong. Fiscal periods (ADR-0012) make the date semantically load-bearing |
| **No `pid`, no `hostname`** | In a container the pid is always 1 and the hostname changes every deploy. Noise on every line in exchange for nothing |
| One **root logger**, idempotent | Two roots means two base-field sets and a debugging session that goes in circles |
| `getLogger()` **throws** before init | A lazily-defaulted logger emits lines with the wrong service name during startup — the exact window where startup failures happen |

### 4. Redaction is three layers, at one choke point

Every log **object** passes through `redact()` in pino's `formatters.log`, and every log **message and interpolation argument** passes through `redactValueShapes()` in a `hooks.logMethod` hook.

Both are needed, and the second was the late addition. `formatters.log` sees the merge object only — so ``logger.error(`auth failed: ${header}`)`` emitted the header verbatim, and that is precisely the line someone writes at 2am while debugging an auth problem. The third path, `.child()`, does not pass bindings through `formatters.log` at all; it is closed by the exported `Logger` type not declaring `.child`, so the unredacted logger cannot be reached from TypeScript. `childLogger()` is the sanctioned equivalent and redacts its bindings.

| Layer | Catches | Misses — which is why the next layer exists |
|---|---|---|
| 1 · **Key name** | `password`, `token`, `authorization`, at any depth, matched after stripping non-alphanumerics so `access_token` and `accessToken` are the same | A secret under an innocent key name |
| 2 · **Value shape** | A JWT or bearer credential, URL credentials in any scheme, and `key=value` secrets in free text — a query parameter or a libpq connection string — whatever the key is called and wherever in the string they sit | A value with no recognisable shape |
| 3 · **Error sanitising** | `host`, `port`, `database`, `user`, `connectionString` on driver errors | — |

Layer 3 exists because a `pg` connection error carries the full connection topology, which has neither a secret-sounding key name nor a token shape, so layers 1 and 2 both miss it. This is the same class of leak `apps/api/src/health/health.service.ts` already guards against in its public response.

Redaction happens **on the way in**, not at the aggregator. A secret that reaches the log file has already leaked; scrubbing it downstream removes the evidence, not the exposure.

The walk is bounded — depth, array length, string length, key count, and a cycle guard — because a caller that hands the logger a large or self-referential object should get a truncated line, not an out-of-memory process at 3am.

**One deliberate non-denial:** `hash` is not a denied key. The audit chain hash (rule 9) is not a secret and redacting it would break the tamper-evidence trail. `passwordHash` is still caught, by the substring rule.

### 5. Session identifiers: `sessionCorrelationId`, never the session id

A correlation context needs to tell one signed-in session from another. The obvious field is the session id, and it must not be: **the raw session id is a bearer credential**, so logging it hands anyone with log access the ability to resume a user's session — and logs are aggregated, replicated, backed up and read by support.

The requirement to correlate and the prohibition on logging credentials only conflict if read carelessly. The resolution is a separate, explicitly approved, **non-secret** identifier:

```
sessionCorrelationId    minted per session, stored beside it,
                        useless for authentication, safe to log
```

It answers *"were these two requests the same session?"* — which is what correlation actually needs — and answers nothing else. It is **random, not derived**: a hash or prefix of the session id would be a weakened copy of a credential rather than an independent label.

Three controls, because a naming convention is not a control:

1. `SessionCorrelationId` is a **branded type**, so a plain `string` session id is not assignable where one is expected.
2. `asSessionCorrelationId()` — the only sanctioned way to rebuild one from storage — **throws unless the value is a UUID.** Stated precisely, because the looser reading is wrong: it validates *shape*, and it cannot know which process minted the value. A raw session id that is itself a UUID — the default for any `randomUUID()`-backed session store — passes. What actually keeps a raw session id out of a log line today is control 3. Closing the gap needs a minting format the guard can distinguish; it is recorded as debt under Compliance rather than claimed here.
3. Redaction denies `sessionId`, `session`, `sid`, `sessionToken` and allow-lists `sessionCorrelationId` explicitly, since it contains the denied substring `session`.

Until a session concept exists (ADR-0009, Wave 1), **no session identifier of any kind appears in a log line.**

### 6. Business events: conventions now, emission when the operation exists

The convention is `ENTITY_PAST_TENSE` in `SCREAMING_SNAKE_CASE`, validated at the call site — a malformed name throws. Past tense because an event records something that **has** happened; `POST_SALE` reads like a command, and a command name invites emission before the thing is done.

**The catalogue is deliberately sparse.** It holds only events for operations that exist. `SALE_POSTED` is *not* in it: nothing can post a sale until Wave 5, and an event emitted from a package that cannot post anything would be a line claiming something happened when nothing did. A name lands with the code that raises it.

`logCommittedBusinessEvent()` is named for its contract: it is called **after the transaction commits**, never inside it. Logging inside produces a line claiming a sale posted while the transaction may still roll back — and a rollback cannot retract a line already flushed to stdout. The result is an operational log that disagrees with the ledger, which is worse than no log, because someone will trust it during an incident.

### 7. Operational logs are not the audit trail

Stated here because conflating them is how a system ends up unable to answer a regulator:

| `audit_log` (rule 9) | business event log |
|---|---|
| PostgreSQL, append-only | stdout → aggregator |
| **in** the posting transaction | **after** it commits |
| hash-chained, tamper-evident | unordered, best-effort |
| before/after row images | a summary line |
| retention set by statute | retention set by disk and cost |
| **the** financial record | an operational convenience |

A log line can be lost to a full disk, a dropped connection, a crashed sidecar or a sampling rule — none of which is a bug in the pipeline; they are its normal operating envelope. **No audit requirement is ever satisfied by logging.** If a fact must survive, it commits in the transaction.

## Consequences

**Positive.** Rule 20 gains its first mechanical enforcement. Correlation works without threading an id through every signature. The session-id trap is closed by types rather than by reviewer memory.

**Negative, and accepted.** A tenth package. Kernels cannot log, so kernel diagnostics arrive as typed errors logged one layer out — better boundaries, one more hop when debugging. The redaction walk runs on every log object: bounded and cheap, but not free, and it is the reason the bounds in §4 exist.

**Deferred.** Metrics and traces (INFRASTRUCTURE §8 names all three) are not in this record. The package is named `observability` rather than `logging` so they have somewhere to land without another ARCHITECTURE amendment.

## Alternatives considered

**Put the logger in `packages/shared-types`.** Rejected: everything imports it, including `apps/web`, which would make a stdout side effect reachable from the browser bundle.

**Widen the kernel allow-list so kernels can log.** Rejected in §2. It would be the first exception to "and NOTHING else".

**Write our own logger.** Rejected: redaction is security-critical and JSON serialisation of arbitrary objects with cycles and bounds is exactly the code that is easy to get subtly wrong. The custom part is the redaction policy, which is ours; the transport is not.

**Redact at the aggregator.** Rejected in §4: the secret has already left the process.

**`console.log` with a JSON string.** Rejected: no levels, no correlation, no redaction choke point, and no way to add one later without changing every call site.

## Compliance

### Enforced

- **Redaction is asserted on the logger's REAL output**, not on `redact()` alone, so a configuration change that bypassed the choke point fails a test rather than passing a unit test of the redactor.
- **Both paths into the output are covered.** The merge object goes through `formatters.log`; the **message string and its interpolation arguments** go through a `hooks.logMethod` hook. See the correction below — the second was originally uncovered, and it is the likelier leak.
- **Credentials are removed from the entire emitted line** — message, stack frames, nested `cause` two levels down, and arbitrary attached properties — and from URL credentials in any scheme, query parameters and libpq keyword/value connection strings. Nine schemes are tabulated rather than inferred. Safe diagnostics (`ECONNREFUSED`, `ETIMEDOUT`, SQLSTATE, paths) are asserted to survive.
- **The unredacted child logger is unreachable.** pino's `.child()` does not pass bindings through `formatters.log`. The exported `Logger` type declares six log methods and nothing else, so `getLogger().child(…)` does not compile; `childLogger()` is the sanctioned path and redacts its bindings.
- **`console` is banned outright** in `apps/api/src/**`, `apps/worker/src/**` and `modules/**`, with the allowances cleared — `no-console: ['error', {}]`, because raising the severity alone keeps the inherited `allow: ['warn','error']`. Negative-tested, including that a CLI keeps `console` and `apps/web` is untouched.
- **Boundary rules**, each proved to fire against a probe in `tests/security/depcruise-negative-control.spec.ts`: `kernel-imports-only-allowed` (an allow-list, so it blocks the logger with no change), `observability-importers-are-allowlisted`, `domain-does-not-log`, `observability-imports-almost-nothing`, `web-is-ui-only`. The harness was filed as debt here while it was being written; it exists, and ADR-0013 records what it does and does not cover.
- **The first consumer outside `apps/` is redacted too.** `packages/database`'s idle-client error listener runs the driver's message through `redactValueShapes()`; see the §2 finding below for what it was leaking and what remains.
- **Runtime smoke check** loads the package in a fresh `node` process with no transpiler — the unloadable-module class `erasableSyntaxOnly` does not catch.
- **Coverage** spans denied keys at depth, the `hash` non-denial, JWT and bearer shapes under innocent key names, cycle/depth/length bounds, driver-error topology stripping, nested causes, correlation injection and scoping, the session-id rules, the message path and the child-logger boundary.

### Corrected — these claimed more than the mechanism did

- **"There is no path to the output that skips it."** There were two. pino applies `formatters.log` to the merge **object** only, so a secret interpolated into the **message** went straight out — ``logger.error(`auth failed: ${header}`)`` emitted the header verbatim, and that is the line someone writes while debugging. `.child()` was the second. Both closed; the claim now names what the choke point covers.
- **"A raw session id routed through `asSessionCorrelationId` throws."** It throws unless the value is **a UUID** — it cannot know which process minted it. If session ids are themselves UUIDs, which is the default for any `randomUUID()`-backed store, a raw one passes. What holds the line today is the key-name denial in `redact.ts`, and only because the field is named `sessionCorrelationId`. Stated accurately; making the guarantee real needs a distinguishable minting format, which is recorded as debt below.
- **"No ESLint rule bans `console.log`."** Stale in the repository's favour — the ban exists and is negative-tested. Its scope is `apps/api` and `apps/worker`, not literally `apps/*`.
- **"Nothing calls this package yet."** `apps/worker` and `apps/api` both do.
- **A test count** was quoted. Counts go stale the first time someone adds a case; the coverage is described instead.

### Incomplete — §2 was silent on five packages

The boundary table ruled on the kernels, `modules/*/domain` and `apps/web`, and said nothing about `packages/database`, `auth`, `permissions`, `reporting` or `validation` — which is not an answer of "no", it is an absence. §2 now states the rule: they may log, through this package only.

That silence had a live consequence, and it was a rule 20 leak rather than a tidiness point. `packages/database`'s idle-client error listener interpolated the driver's `error.message` straight into `console.error`. `describeTarget` was already safe — host, port and database, never the credentials — but a `pg` connection failure puts **the DSN it tried, password included, into its message**, which is neither a denied key nor a token shape. The password reached stdout on a path the redactor never saw.

Fixed at `packages/database/src/pool.ts`: the message goes through `redactValueShapes()` first. Proven through the **real listener** — the test emits `'error'` on the pool, which is an EventEmitter, so it runs the exact closure `getPool` registered; a unit test of the regex would still pass if someone deleted the call. Negative-controlled: reverting the call fails the test with the password in the assertion output.

**This adds one dependency edge, `packages/database → packages/observability`**, and it is the first. The consequence, stated in the tense the graph actually supports: both kernels are currently `export {}` with no declared dependencies and no outbound edges, so nothing transitive exists today. **When** they take the `packages/database` dependency ARCHITECTURE §5 allows, they will transitively link against observability. They still will not be able to log — `kernel-imports-only-allowed` blocks the direct import, `observability-importers-are-allowlisted` now names them explicitly, and `packages/database/src/index.ts` re-exports nothing from observability, so `getLogger` is not nameable through the allowed edge.

Accepted by the Architecture Guardian on the reasoning that "and NOTHING else" has always been a statement about direct edges enforced by a direct-edge allow-list — `packages/database` already carries `pg`, `kysely` and `node:async_hooks` behind it — with the importer allow-list as the required condition, so that the next first-party package wanting the logger is a decision rather than a default.

**Residual debt:** it is still `console.error`, not a log line. The listener runs inside an `'error'` handler and `getLogger()` throws before `initLogger()`, so a CLI or a test would turn a recoverable idle-socket error into a throw from an error handler. Routing it through the logger needs a lifecycle `packages/database` does not have.

### Not built — stated as debt, not as compliance

- **A distinguishable `sessionCorrelationId` format**, so the guard can reject a value it did not mint rather than accepting any UUID.
- **`packages/database`'s error listener is still `console.error`**, not a log line — the credential leak is closed, the structured-logging migration is not. See §2 above for why it needs a logger lifecycle this package does not have.

## Related

- [../INFRASTRUCTURE.md](../INFRASTRUCTURE.md) §8 — the observability stack this implements the first third of
- [../ARCHITECTURE.md](../ARCHITECTURE.md) §2 (package list, amended here), §5 (dependency rules)
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rule 20 (secrets), rule 9 (audit), rule 19 (business logic placement)
- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — sessions; `sessionCorrelationId` is minted where a session is created
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — the financial events business-event names will mirror
- [ADR-0012](ADR-0012-fiscal-period-locking.md) — why the log timestamp is spelled out rather than epoch
