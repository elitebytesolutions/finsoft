# @finsoft/observability

Structured logging, correlation context and redaction. [ADR-0016](../../docs/adr/ADR-0016-structured-logging-and-observability-package.md).

One JSON line per event, to stdout, with every credential removed on the way in.

---

## The four things that are easy to get wrong

**1. `initLogger()` before `getLogger()`.** `getLogger()` throws if the root has not been initialised. That is deliberate: a lazily-defaulted logger emits lines with the wrong service name during startup, which is the exact window where startup failures happen. Initialise once, in the process entrypoint.

```ts
initLogger({ service: 'api', level: 'info' })   // apps/api/src/main.ts, first thing
```

**2. `childLogger()`, never `.child()`.** pino's own `.child()` does not pass its bindings through `formatters.log`, so a child logger would emit unredacted bindings. The exported `Logger` type declares six log methods and nothing else, so `getLogger().child(…)` does not compile. Use `childLogger()`, which redacts.

```ts
const log = childLogger({ module: 'sales', invoiceId })
```

**3. `sessionCorrelationId`, never the session id.** The raw session id is a bearer credential: anyone holding it can resume the session, and logs are aggregated, replicated, backed up and read by support. `sessionCorrelationId` is a separate random value, minted per session and useless for authentication.

Note what `asSessionCorrelationId()` does and does not guarantee: it throws unless the value is **a UUID**. It validates shape, and cannot know which process minted the value — so a session store backed by `randomUUID()` produces raw ids that pass. What keeps a raw session id out of a log line today is that `redact.ts` denies `sessionId`, `session`, `sid` and `sessionToken` by key name.

**4. `logCommittedBusinessEvent()` is named for its contract.** It is called **after** the transaction commits, never inside it. A line claiming a sale posted, written inside a transaction that then rolls back, cannot be retracted once flushed — and the result is an operational log that disagrees with the ledger, which is worse than no log because someone will trust it during an incident.

---

## What may log

| | |
|---|---|
| `apps/api`, `apps/worker` | Yes |
| `modules/*/{api,application,infrastructure}` | Yes |
| `packages/database`, `auth`, `permissions`, `reporting`, `validation` | Yes — through this package only |
| The kernels, `modules/*/domain` | **No.** They return a result or throw; the caller decides what is worth a line |
| `apps/web` | **No.** A server logger in a browser writes to a console nobody reads |

Enforced in both directions by `.dependency-cruiser.cjs` — `observability-imports-almost-nothing` for what this package may import, `observability-importers-are-allowlisted` for who may import it. `console` is banned outright in everything above that may log, so there is no way to bypass the redactor by not using the logger.

---

## Redaction

Three layers, because each has a failure mode the others cover:

| | Catches | Misses — which is why the next exists |
|---|---|---|
| **Key name** | `password`, `token`, `authorization` at any depth, matched after stripping non-alphanumerics so `access_token` and `accessToken` collapse to the same thing | A secret under an innocent key name |
| **Value shape** | A JWT or bearer credential, URL credentials in any scheme, and `key=value` secrets in free text — a query parameter or a libpq connection string | A value with no recognisable shape |
| **Error sanitising** | Connection topology on driver errors: `host`, `port`, `database`, `user`, `connectionString` | — |

Both paths into the output are covered: the merge **object** through `formatters.log`, and the **message** and its interpolation arguments through a `hooks.logMethod` hook. The second was the late addition and is the likelier leak — `logger.error(\`auth failed: ${header}\`)` is what someone writes at 2am.

**Credentials are removed from the whole line.** Topology is removed from structured error *fields*, where it is machine-readable and trivial to harvest in bulk, and **kept** in free text — `could not connect to [redacted]` tells an on-call engineer nothing, and a redaction that destroys the diagnosis is one that gets switched off. `ECONNREFUSED`, `ETIMEDOUT` and SQLSTATE always survive.

**`hash` is deliberately not denied.** The audit chain hash (rule 9) is not a secret, and redacting it would break the tamper-evidence trail. `passwordHash` is still caught, by the substring rule.

The walk is bounded — depth, array length, string length, key count, and a cycle guard — so a caller who hands the logger a 50 MB object gets a truncated line rather than an out-of-memory process at 3am.

---

## This is not the audit trail

| `audit_log` (rule 9) | this package |
|---|---|
| PostgreSQL, append-only, hash-chained | stdout, best-effort, unordered |
| **in** the posting transaction | **after** it commits |
| the financial record | an operational convenience |

A log line can be lost to a full disk, a dropped connection, a crashed sidecar or a sampling rule — none of which is a bug; they are the normal operating envelope. **No audit requirement is ever satisfied by logging.** If a fact must survive, it commits in the transaction.
