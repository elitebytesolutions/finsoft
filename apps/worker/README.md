# apps/worker

Background jobs and queue consumers (BullMQ). Built by **FND-011**.

Plain Node, not NestJS: no HTTP surface beyond two probes and no dependency
injection to do, so it runs directly under Node's type stripping with no build
step — the same way `packages/*` do. That is why its `tsconfig.json` extends
`tsconfig.packages.json` and inherits `erasableSyntaxOnly`, while `apps/api`
deliberately does not.

```
npm start --workspace @finsoft/worker     # node src/main.ts
npm run dev --workspace @finsoft/worker   # node --watch src/main.ts
```

Requires `REDIS_URL`. It will not start without one — a worker that starts with
a missing config and discovers it on the first job has already told the
orchestrator it is healthy. See `.env.example` for `WORKER_*`.

## What it does today

A `maintenance` queue and a `heartbeat` job, which proves the loop end to end
without pretending to do business work: enqueued for real, consumed for real,
logged with the correlation id of whatever produced it. Wave 0's exit criterion
is "an empty-but-real vertical"; this is the worker's part of it.

**The outbox dispatcher is not here yet.** It is the reason this process exists
(ADR-0010) — rows written inside the posting transaction, dispatched after it
commits, carrying emails, PDFs, FBR pushes, webhooks and cache invalidation —
and it needs the `outbox` table, which needs a migration that needs posting to
exist. This is the machinery that dispatcher will run on.

## Probes

| | |
|---|---|
| `GET /health/live` | Is the process running? Never touches a dependency |
| `GET /health/ready` | Should it be given work? Round-trips to Redis |

Split deliberately. If liveness touched Redis, a brief blip would make the
orchestrator kill and restart healthy workers — turning a short outage into a
restart storm at the moment Redis is least able to cope. On `SIGTERM` readiness
fails immediately while liveness stays true, so the worker stops being sent work
while it finishes what it holds.

A failing readiness probe logs the **transition**, not every probe: otherwise a
ten-minute outage becomes a few hundred identical lines that bury the one line
explaining what else broke. The recovery line carries the outage duration and
the failed-probe count.

## Rules this process does not get an exception to

- **No period bypass.** A closed fiscal period rejects a posting from a job
  exactly as it does from the API. There is no `systemActor`, `forcePost` or
  `bypassPeriod`, and no such parameter is threaded through the runner for a
  handler to reach (ADR-0012, rule 3). `eslint.config.mjs` fails the build on
  those three identifiers anywhere in the repository.
- **No console.** Services log through `@finsoft/observability` (ADR-0016). A
  bare `console.error` writes unstructured text into the JSON log pipeline, with
  no level, no correlation id and no redaction. Enforced by `no-console` with
  the allowances cleared, and negative-tested in
  `tests/security/lint-boundaries.spec.ts`.
- **Nothing financial in a job payload.** ADR-0002: if Redis is flushed at any
  moment the system loses nothing but speed. Payloads carry identifiers and a
  correlation id; the handler re-reads the committed row from PostgreSQL. That
  is what makes a flushed queue a delay rather than a loss, and what stops a
  payload disagreeing with the ledger.
- **Every job carries a correlation id.** The runner refuses one that does not,
  rather than minting a fresh id — a minted id produces a trace that looks
  complete and joins to nothing, discovered months later during an incident.
- **A failing handler re-throws.** Swallowing the error reports success, the job
  is removed, and the side effect never happens — with a log line saying it did.
