# M1-C — Request correlation

**Lane:** M1-C · **Risk tier:** T2 · **Branch:** `feature/M1-C-request-correlation`

## Task

Give every request a correlation id end to end: apps/api establishes it at
the earliest possible point, threads it through logs via the existing
observability correlation context, echoes it on the response, and
`packages/database`'s audit writer defaults `request_id`/`ip` on an audit
row from that same ambient context when its caller omits them.

## Why

The Architecture seat ruled the M2 posting engine may not merge until every
audit row carries a request id: `audit_log` is append-only and
hash-chained (ADR-0020), so a `null` written today can never be backfilled
once a real id exists. ARCHITECTURE §9/§10 require `request_id` on audit
rows and correlation across the whole request lifecycle.

## Scope

**ALLOWED**
- `apps/api/src/correlation/**` (new)
- `apps/api/src/main.ts` (one import, one `app.use()` line)
- `packages/observability/src/context.ts` (adds an optional `ip` field to
  `CorrelationContext`)
- `packages/database/src/audit/writer.ts` (`AuditEventInput.ip`/`.requestId`
  become optional; `recordAudit` defaults them from the ambient correlation
  context when omitted)
- `database/tests/audit-log-correlation.spec.ts` (new)
- `tests/integration/request-correlation.spec.ts` (new)
- `docs/briefs/M1-C-request-correlation.md` (this file)

**READ ONLY**
- `apps/api/src/auth/request-context.ts` (`clientIp` — reused, never
  duplicated)
- `apps/api/src/common/tenant.guard.ts`, `apps/api/src/app.module.ts`
- `packages/auth/**`, `packages/database/src/auth/**`
- `apps/worker/**`
- ADR-0016, ADR-0020, ADR-0023, ARCHITECTURE.md, `.dependency-cruiser.cjs`

**FORBIDDEN** (parallel lanes)
- m1-x: `apps/api` guards/interceptors/auth beyond the one middleware wire-up
  in `main.ts`, `packages/auth`, `tools/seed`
- m2-core: `packages/accounting-kernel`, `packages/reporting`, migrations
  010–013
- m1-web: `apps/web`, `infrastructure/staging`, `ci.yml`

## Behaviour

- `apps/api/src/correlation/request-id.ts` — `isWellFormedRequestId` /
  `resolveRequestId(header)`. The inbound `X-Request-Id` header is trusted
  ONLY if it is a syntactically well-formed UUID (any RFC 4122
  version/variant, not restricted to v4) — anything else (absent, malformed,
  oversized, a repeated-header array) gets a freshly minted `randomUUID()`.
  Never rejects the request over a bad header; a correlation id is a
  debugging convenience, not a business input.
- `apps/api/src/correlation/request-correlation.middleware.ts` — genuine
  Express middleware (`app.use()`-bound in `main.ts`, before anything else),
  not a Nest guard or interceptor. `tenant.guard.ts`'s own header already
  explains why a guard cannot keep an `AsyncLocalStorage` context alive for
  the handler chain that follows it — only `next()` called synchronously
  from inside the `AsyncLocalStorage.run()` callback does, because
  everything Express (and Nest on top of it) does next is a causal
  descendant of that call. Establishes `{ requestId, ip }` via
  `withCorrelation`, echoes `X-Request-Id` on the response, and exposes
  `req.requestId`. `ip` is `clientIp(req)` — the exact trusted-proxy-aware
  extraction `request-context.ts` already uses for sessions and rate
  limiting (ADR-0023 §5); reused, not reimplemented, so the trust rules
  cannot drift between two copies.
- `packages/observability/src/context.ts` — `CorrelationContext` gains one
  optional field, `ip?: string`. Additive; no existing consumer's shape
  changes. Flows into every log line automatically via `logger.ts`'s
  existing `mixin()`, with no call-site change anywhere.
- `packages/database/src/audit/writer.ts` — `AuditEventInput.ip` and
  `.requestId` change from required to optional (`string | null |
  undefined`). `recordAudit` resolves each independently:
  1. Caller supplies the field (including an explicit `null`) → that value,
     always.
  2. Caller omits the field → `getCorrelation()?.<field> ?? null`.
  3. No context, or the context lacks the field → `null`. Never fabricated.

  `packages/database` importing `@finsoft/observability` is not a new edge —
  `pool.ts` already does, ADR-0016 §2 names `packages/database` as an
  allowed importer, and depcruise's `observability-importers-are-allowlisted`
  rule blocks only the kernels, `shared-types`, `ui` and `validation` from
  this reach.

## Decisions

1. **`packages/database` reads `getCorrelation()` directly rather than a
   `setAuditContextProvider()` hook.** The task brief offered both; the
   direct read is strictly simpler and is already the sanctioned shape per
   ADR-0016 §2 and the existing `pool.ts` precedent — no new dependency edge,
   no new registration step for `apps/api` to forget at boot, and one fewer
   indirection between "context exists" and "audit row has it."
2. **`ip` on `CorrelationContext` is additive, not a new ADR.** It widens an
   existing LEVEL 1 interface by one optional field, changes no boundary
   ADR-0016 states (no new import edge, no new importer, no redaction
   change — `ip` is not a denied key and has no secret shape), and is the
   mechanism the task explicitly asked for ("use packages/observability's
   correlation context ... so logs already include it"). Flagged for the
   Architecture seat's review rather than assumed final.
3. **Explicit `null` always beats the ambient context**, distinguished from
   "omitted" via the optional field being genuinely `undefined` when not
   passed. Every existing call site in the repository (all in
   `database/tests/**`, `packages/database/src/audit/record.test.ts`,
   `tests/integration/audit-api.spec.ts`) already passes `ip`/`requestId`
   explicitly — `null` or a literal value — so none of them change
   behaviour; this was verified by inspection (`grep` across the repo for
   every `recordAudit(` call site) rather than assumed.
4. **No production call site needed updating (item 3 of the task).**
   `packages/auth`'s `AuthAuditSink` (`login.ts`/`logout.ts`/`refresh.ts`)
   still resolves to `noopAuthAuditSink` — `apps/api/src/auth/auth.service.ts`
   (m1-x's active file) does not yet wire a real, `recordAudit`-backed sink,
   per that file's own comment ("M1-D wires a real implementation..." /
   the coordinator's deferral of this exact wiring to m1-x). There is
   therefore no existing `requestId: null` / `ip: null` production call site
   to fix. Once m1-x wires a real sink and calls `recordAudit` from inside
   `apps/api`'s request pipeline, simply omitting `ip`/`requestId` (rather
   than passing them explicitly) is enough to pick them up from the
   correlation context this lane establishes — no further plumbing needed on
   either side.
5. **`apps/worker` needed no change (item 4).** It does not write audit rows
   today (confirmed by `grep` — no audit import anywhere under `apps/worker`).
   It already correlates job executions: `apps/worker/src/outbox/
   dispatcher.ts` wraps every dispatched job in
   `withCorrelation({ requestId: row.correlationId })` before invoking it,
   and `apps/worker/src/runner.ts` refuses to run a job with no
   `correlationId` at all (INFRASTRUCTURE §8) and adds `jobName`. When a
   future audit-writing job handler calls `recordAudit` without an explicit
   `requestId`, it will pick up the job's correlation id automatically
   through the exact mechanism this lane built — the worker side of
   end-to-end correlation was already in place before this lane started.
6. **The outbox has no `enqueue` producer yet** (`packages/database/src/
   outbox.ts` has no `INSERT`-side function — only `claimBatch`, `ackDispatched`,
   `recordFailure`, `reclaimExpired`, `listTenantIdsForDispatch`,
   `oldestPendingAgeSeconds`). There is nothing to wire for "capture the
   ambient request id at enqueue time" because nothing enqueues yet.
   **OBSERVED**, not fixed here: whoever adds the producer (the M2 posting
   engine, per the posting pattern in the repo's own `CLAUDE.md`) should read
   `getCorrelation()?.requestId` as the default `correlationId` the same way
   `recordAudit` now does, for the same reason — an outbox row is exactly as
   append-only-adjacent as an audit row once a consumer has acted on it.

## Acceptance

- [x] A request with a valid `X-Request-Id` → the audit row written during
      it has that `request_id` (lowercased) and a normalised `ip`.
- [x] A request with an invalid/oversized/absent `X-Request-Id` → a fresh
      UUID, never the client's raw text.
- [x] The response always echoes `X-Request-Id`.
- [x] Log lines emitted while handling the request carry the request id
      (`tests/integration/request-correlation.spec.ts`); `tests/integration/
      log-leak.spec.ts` still passes unmodified — it boots `AuthModule`
      directly, not through this middleware, so it is unaffected either way.
- [x] Unit coverage for `isWellFormedRequestId`/`resolveRequestId`: valid
      UUIDs (including non-v4), case-insensitivity, malformed/oversized/empty/
      array/undefined/non-string inputs.
- [x] `recordAudit` defaulting: both fields from context, ip normalisation
      still runs on the defaulted value, no-context stays `null`, explicit
      value (including explicit `null`) always wins, partial defaulting
      (one explicit, one from context), and a context with no `ip` (the
      worker/job shape) defaults `requestId` only.
- [x] `ip` never appears in a log line, even though `requestId` and every
      other correlation field still do — asserted against real logger
      output in both `packages/observability/src/logger.test.ts` and
      `tests/integration/request-correlation.spec.ts` (a real request with
      a real `X-Forwarded-For`).
- [x] A POST with a JSON body: the correlation context (entered via
      `AsyncLocalStorage.run()` around `next()` in the correlation
      middleware) survives NestJS's body parser reading the request stream
      — an async hop that happens between the middleware calling `next()`
      and the handler running — and the audit row written during the
      request still carries `request_id` and the normalised `ip`.

## Architecture seat review — APPROVED WITH CONDITIONS

Two conditions, both landed:

1. **`ip` must never appear in a log line.** It is personal data; ADR-0016's
   redaction layers exist to catch secrets and driver topology, not to
   decide a data-protection policy question about broadcasting an address
   onto every line of output. Fixed in `packages/observability/src/
   logger.ts`'s `mixin()`: `const { ip: _ip, ...rest } = correlation` before
   the spread, so `ip` reaches `recordAudit` (the one caller that reads
   `getCorrelation()` directly) and nowhere else. `CorrelationContext.ip`'s
   own doc comment, this brief, and the middleware's header comment are
   corrected to state this — they previously (incorrectly) said `ip` flowed
   into every log line the same way `requestId` does. Covered by a new
   logger-output test (`logger.test.ts`: "never logs the ip, even though
   requestId and other fields still appear") and a real-HTTP one
   (`request-correlation.spec.ts`: "never logs the ip, on any line written
   while handling the request").
2. **A POST + JSON-body integration test**, to prove the AsyncLocalStorage
   context survives the body parser rather than only ever being exercised
   over a bodyless GET. Added: `CorrelationProbeController.writeAuditFromBody`
   (`@Post('audit')`, `@Body()`) plus the "a POST with a JSON body" describe
   block in `tests/integration/request-correlation.spec.ts`.

## Gate

`npm run check:full`, twice — before and after the conditions above.
