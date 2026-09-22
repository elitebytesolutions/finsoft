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
| **Observability imports no first-party package** | It is beneath everything that logs. A dependency here would be reachable from every layer that logs, making the logger a back door into it | `observability-imports-almost-nothing` (new) |

**All three new or amended rules were observed to fire** against deliberately-violating probe files before being accepted, per this repository's standing rule that a rule which has never fired is a comment.

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

Every log object passes through `redact()` in pino's `formatters.log`. There is no path to the output that skips it.

| Layer | Catches | Misses — which is why the next layer exists |
|---|---|---|
| 1 · **Key name** | `password`, `token`, `authorization`, at any depth, matched after stripping non-alphanumerics so `access_token` and `accessToken` are the same | A secret under an innocent key name |
| 2 · **Value shape** | Anything shaped like a JWT or a bearer credential, whatever the key is called, including inside a longer string | A value with no recognisable shape |
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
2. `asSessionCorrelationId()` — the only sanctioned way to rebuild one from storage — **throws** unless the value is a minted UUID. A raw session id routed here fails loudly instead of being logged.
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

- **66 unit tests**, covering: denied keys at depth, the `hash` non-denial, JWT and bearer shapes under innocent key names, cycle and depth and length bounds, driver-error topology stripping, nested `cause`, correlation injection and scoping, and the session-id rules.
- **Boundary rules**, each observed to fire against a violating probe: `kernel-imports-only-allowed`, `domain-does-not-log`, `observability-imports-almost-nothing`, `web-is-ui-only`.
- **Runtime smoke check** — `tools/smoke/runtime.mjs` loads the package entrypoint in a fresh `node` process with no transpiler, which is what catches the unloadable-module class of defect that `erasableSyntaxOnly` does not.
- **Redaction is asserted on the logger's real output**, not on `redact()` alone, so a configuration change that bypassed the choke point would fail.

**Not yet done, and named rather than implied:**

- **No ESLint rule bans `console.log` in `apps/*` and `modules/*`.** Until there is one, the logger is available but not mandatory, and `no-console` is a warning in this repo. That is the next mechanical step and it is debt, not a claim.
- **No depcruise negative-control harness exists.** `tests/security/lint-boundaries.spec.ts` covers ESLint rules only; the four boundary rules above were verified manually, once. A rule verified once is weaker than a rule verified on every run.
- Nothing calls this package yet. It is wired into `apps/api` by FND-011 and after.

## Related

- [../INFRASTRUCTURE.md](../INFRASTRUCTURE.md) §8 — the observability stack this implements the first third of
- [../ARCHITECTURE.md](../ARCHITECTURE.md) §2 (package list, amended here), §5 (dependency rules)
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rule 20 (secrets), rule 9 (audit), rule 19 (business logic placement)
- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — sessions; `sessionCorrelationId` is minted where a session is created
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — the financial events business-event names will mirror
- [ADR-0012](ADR-0012-fiscal-period-locking.md) — why the log timestamp is spelled out rather than epoch
