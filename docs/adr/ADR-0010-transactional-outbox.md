# ADR-0010: Transactional outbox for all external side effects

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Amended by:** [ERRATUM-001](ADR-0010-ERRATUM-001.md) — four corrections from implementing it. Two change the delivery contract: replay is a new row rather than a reset, and consumer deduplication keys on `(tenant_id, topic, effect_key)` rather than `outbox.id`. Read the erratum alongside this record; where they differ, the erratum is later.

## Context

Posting a sale must also do things outside the database: email the invoice, render a PDF, push the invoice to the FBR POS endpoint, fire a webhook, invalidate a cache. Each of those can be slow, can fail, and can succeed-but-time-out.

Calling them inline inside the posting transaction creates two failure modes, and both are unacceptable:

```
1  The external call fails → the transaction rolls back
   A correct sale is rejected because an SMTP server was down.
   Worse: the FBR call may have SUCCEEDED before the timeout, so the
   regulator now holds an invoice the ledger does not.

2  The external call succeeds → the transaction rolls back afterwards
   The customer holds an emailed invoice for a sale that does not exist.
```

There is no ordering of "commit then call" or "call then commit" that fixes this, because a database transaction and an HTTP request cannot commit together. The only way out is to make the *intent* to perform the side effect part of the same transaction as the business fact, and perform it afterwards.

A held transaction is also a held lock. Inside the posting transaction the stock balance row is locked (ADR-0008); an inline HTTP call with a 30-second timeout holds that lock for 30 seconds, and the posting budget is P95 < 800 ms ([ARCHITECTURE.md §11](../ARCHITECTURE.md)).

## Decision

**Every side effect that touches anything outside the database is written as a row in the `outbox` table inside the posting transaction, and dispatched by the worker after the commit.**

```
BEGIN
  set app.tenant_id                                      (ADR-0004)
  domain operations
  inventoryKernel.postMovement(...)                      (ADR-0008)
  postingEngine.post(...)        journal + numbering + audit + idempotency
  INSERT INTO outbox (...)       ← the intent, same transaction
COMMIT                           ← business fact and intent become true together
  ────────────────────────────────────────────────────────────
  worker polls / is signalled → dispatches → marks the row done
```

**Nothing that touches an external system happens inside the posting transaction.** Not email, not PDF rendering, not an FBR push, not a webhook, not a cache invalidation, not an object-storage write, not an SMS. If it can fail independently of the books, it is an outbox row.

### The table

```
outbox
  id               uuid pk
  tenant_id        uuid not null          ← RLS-protected like everything else
  topic            text not null          ← INVOICE_EMAIL, FBR_POS_PUSH, …
  payload          jsonb not null         ← identifiers + minimal facts
  occurred_at      timestamptz not null   ← business time
  created_at       timestamptz not null default now()
  available_at     timestamptz not null   ← delay / backoff schedule
  status           text not null          ← PENDING | IN_FLIGHT | DONE | FAILED
  attempts         int  not null default 0
  last_error       text
  dispatched_at    timestamptz
  correlation_id   text not null          ← request_id, propagated end to end
```

The payload carries **identifiers, not financial truth** (ADR-0002): `{ saleId, invoiceId }`, not `{ amount, accountId }`. The dispatcher re-reads the committed row, so a payload can never disagree with the ledger and financial detail does not sit in a queue.

### Dispatch

```
worker loop, per tenant batch:
  SELECT … FROM outbox
   WHERE status = 'PENDING' AND available_at <= now()
   ORDER BY available_at
   FOR UPDATE SKIP LOCKED                  ← concurrent workers, no contention
   LIMIT n

  for each row:
    mark IN_FLIGHT
    perform the side effect (HTTP, SMTP, storage, cache)
    ├─ success → status DONE, dispatched_at = now()
    └─ failure → attempts += 1
                 available_at = now() + backoff(attempts)   (exponential + jitter)
                 status back to PENDING, or FAILED after the cap
```

`FOR UPDATE SKIP LOCKED` lets several worker processes drain the table without stepping on each other. Rows that exhaust their retry cap go to `FAILED`, which raises an operational alert and is visible in an admin view — a `FAILED` outbox row is a real operational condition, never quietly discarded. Redis carries the *signal* to wake the dispatcher promptly; PostgreSQL remains the queue of record, so losing Redis delays dispatch and loses nothing.

### At-least-once delivery, and what that obliges

The outbox guarantees **at-least-once**, not exactly-once. Exactly-once across a process boundary does not exist: a dispatcher can perform the side effect and then crash before marking the row `DONE`, and on recovery it will perform it again. This is not a defect to engineer away; it is the guarantee, and the system is designed on top of it.

Therefore **every consumer must be idempotent**, and this is a requirement on the consumer, not a hope about the dispatcher:

| Consumer | Idempotency mechanism |
|----------|----------------------|
| Email / SMS | Deduplicate on **`(tenant_id, topic, effect_key)`**; a `sent_notifications` row keyed by that, inserted before send. **Not `outbox.id`** — see [ERRATUM-001](ADR-0010-ERRATUM-001.md) erratum 3: a replay row carries a fresh id and would sail past a table keyed on it, turning replay into a silent double-send |
| PDF generation | Deterministic object key from `(tenant_id, documentType, documentId, version)`; re-render overwrites the identical artefact |
| FBR POS push | Send the invoice's own document number as the regulator-facing idempotency key; treat "already submitted" as success, not as an error |
| Webhook | Send `Idempotency-Key:` the **effect key**, not `outbox.id`; publish it in the integration contract so receivers can deduplicate. [ERRATUM-001](ADR-0010-ERRATUM-001.md) erratum 3 — a receiver deduplicating on the row id would accept a replay as a new request |
| Cache invalidation | Naturally idempotent — invalidating twice is invalidating |

The **effect key** — `(tenant_id, topic, effect_key)` — is the universal idempotency key, and it is stable across retries **and across replays**. [ERRATUM-001](ADR-0010-ERRATUM-001.md) erratum 3 corrects this sentence, which previously named `outbox.id`: that is stable across retries and **not** across replays, because a replay is a new row with a fresh id. Keying on the row id therefore makes replay a silent double-send, which is the one failure worse than the audit loss the erratum set out to fix. Where an external system offers no idempotency facility, the consumer records its own attempt in PostgreSQL before acting and checks that record on retry, accepting a narrow duplicate-send window in exchange for never losing the effect. **Losing a side effect is worse than duplicating one**, and the design is tuned in that direction deliberately.

Ordering is per-topic best-effort, not guaranteed. A consumer that needs ordering derives it from `occurred_at` and the business document, not from dispatch sequence.

### Tenant context in the worker

The dispatcher sets `app.tenant_id` from the outbox row's own `tenant_id` column — a committed, RLS-protected value — before doing any work for that row (ADR-0004). There is no session and no JWT in the worker, and the tenant is never taken from the job payload (ADR-0009).

### This is also the extraction seam

Because every external interaction is already a row plus a consumer, moving notifications, PDF generation, analytics or an integration into its own process later is a deployment change, not a rewrite ([ADR-0001](ADR-0001-modular-monolith.md)). The outbox is what keeps that option open without paying for it now.

## Consequences

### Positive

- The books and the intent to notify commit atomically. There is no state in which a sale exists without its queued side effects, or side effects exist without the sale.
- External outages do not reject correct business transactions; the row waits and retries.
- The posting transaction stays short, so locks stay short and the P95 < 800 ms budget is achievable.
- Every pending, retrying and failed side effect is visible as data — queryable, alertable, replayable — rather than lost in a process's memory.
- Replay is a **new row**, not a reset. **[ERRATUM-001](ADR-0010-ERRATUM-001.md) erratum 3 corrects this line**, which previously read "reset a row to `PENDING`": `status = 'DONE'` and `dispatched_at` are the record that the effect was performed, and frequently the only record — an SMTP send leaves nothing on our side. The reset erases it. Recovering a botched integration is still an `INSERT` on the outbox rather than a data-repair script over financial tables.
- Gives the modular monolith a clean extraction seam for later.

### Negative / accepted costs

- Side effects are asynchronous, so the user does not get "invoice emailed" confirmation in the posting response. The UI reports the posting, and notification status separately.
- At-least-once means duplicates are possible and every consumer must be written idempotently. This is real, recurring work and is a review checklist item for any new consumer.
- The outbox is an operational surface: it needs monitoring for depth, age of oldest pending row, and `FAILED` count, with alerts on each ([ARCHITECTURE.md §10](../ARCHITECTURE.md)).
- The table grows and needs an archival policy for `DONE` rows, plus an index supporting the dispatch query without bloating the write path.
- Debugging spans two processes, which is why `correlation_id` (the originating `request_id`) is mandatory on every row and propagated into the dispatcher's logs.
- A poison row that always fails can consume retry capacity. Bounded by the attempt cap and per-topic concurrency limits.

## Alternatives considered

**Direct calls inside the posting transaction.** Rejected — the two failure modes in Context, plus holding stock and numbering locks across a network call.

**Direct calls immediately after commit, in the request handler.** Rejected. If the process dies between `COMMIT` and the call — a deploy, an OOM, a crash — the side effect is lost with no record that it was owed. The invoice is never sent and nothing knows.

**Publishing to a message broker inside the transaction.** Rejected. It is the same dual-write problem wearing different clothes: the broker publish and the database commit cannot be made atomic, so either a published message references a rolled-back sale or a committed sale has no message.

**Change Data Capture from the WAL (Debezium or similar).** Technically sound and genuinely atomic. Rejected for v1 as disproportionate: it adds a connector, a broker and a schema-evolution pipeline to operate, to solve a problem one table and a polling loop already solve at this volume. Revisit if event volume outgrows polling.

**PostgreSQL `LISTEN`/`NOTIFY` as the delivery mechanism.** Rejected as the mechanism of record — notifications are not durable, so a worker that is down during the notify never learns of the row. Useful only as a wake-up signal alongside polling, which is how Redis is used here.

**Exactly-once delivery via distributed transactions with each external system.** Rejected. Not available for SMTP, not available for the FBR endpoint, not available for most webhooks. At-least-once plus consumer idempotency is the achievable and correct design.

## Compliance

- Lint rule: HTTP clients, SMTP clients, object-storage SDKs and the PDF renderer may not be imported inside `packages/accounting-kernel`, `packages/inventory-kernel`, or any `modules/*/domain` and `modules/*/application`. Build failure.
- Architecture test: a transaction that reaches `postingEngine.post(...)` is asserted to make no outbound network call — verified by a test harness that fails the test if any socket is opened while a posting transaction is open.
- Type-level: the outbox payload type is restricted to identifier-shaped DTOs; a payload declaring a `Money`- or amount-typed field fails type-check (ADR-0002).
- Schema: `outbox` carries `tenant_id NOT NULL` with RLS enabled and forced, like every tenant-owned table (ADR-0004). The dispatch index is **`(tenant_id, available_at, id) WHERE status = 'PENDING'`**, not `(status, available_at)` — [ERRATUM-001](ADR-0010-ERRATUM-001.md) erratum 2 states why, and what it costs.
- Integration test: kill the worker mid-dispatch after the side effect but before the `DONE` mark; assert the row is redelivered and the consumer's idempotency guard prevents a duplicate effect. Redelivery now also requires a **lease fence** — see [ERRATUM-001](ADR-0010-ERRATUM-001.md), additive departures.
- Integration test: roll back a posting transaction that wrote an outbox row; assert no row exists and no side effect occurs.
- Consumer contract test: every registered consumer is exercised twice with the same **`(tenant_id, topic, effect_key)`**, including once via a replay row carrying a different `id`, and asserted to produce one effect. Amended by [ERRATUM-001](ADR-0010-ERRATUM-001.md) erratum 3: the `outbox.id` form passes against a consumer that would double-send on replay.
- Monitoring: alerts on queue depth, the age of the oldest `PENDING` row **as a maximum over per-tenant measurements** (a global minimum is not reachable in one query under RLS), and any **unacknowledged** `FAILED` row. A `FAILED` row is an operational incident with an owner. Amended by [ERRATUM-001](ADR-0010-ERRATUM-001.md) errata 2 and 4.
- Dispatcher test: `app.tenant_id` is asserted to be set from the outbox row before any consumer code runs, and unset after.

## Related

- [ADR-0001](ADR-0001-modular-monolith.md) — the extraction seam this creates
- [ADR-0002](ADR-0002-postgresql-and-redis.md) — PostgreSQL is the queue of record; Redis carries the signal
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — the transaction the outbox row joins
- [ADR-0004](ADR-0004-postgresql-row-level-security.md) — how the dispatcher establishes tenant context
- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — why the tenant is never taken from a payload
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 9, 14, 20
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §7 transactions and the outbox, §10 observability, §11 performance guardrails
