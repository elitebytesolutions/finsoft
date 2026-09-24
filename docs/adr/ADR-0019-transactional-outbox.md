# ADR-0019: Transactional outbox for all external side effects

**Status:** Accepted
**Accepted:** 2026-09-24, by the Product Owner, on the guardian evidence recorded in the Signatures block below
**Date:** 2026-09-23
**Deciders:** Product Owner, Architecture Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Supersedes:** [ADR-0010](ADR-0010-transactional-outbox.md), which becomes `Superseded by ADR-0019` when this is accepted. The two statuses change together.

---

## Why this supersedes rather than corrects

Implementing ADR-0010 found four claims in it that are wrong. Not decisions to revisit — the decision is unchanged and restated below in full — but **facts that do not hold**, two of which change what "delivered" and "replayed" mean.

An earlier attempt corrected them in place, in a separate erratum document. [README rule 4](README.md) forbids that: an Accepted ADR is superseded, never edited, and "changing the decision, the rationale or the consequences is not" a permitted edit. Line 122 of ADR-0010 is in **Consequences**. The Product Owner ruled that rule 4 stands as written and that the corrections belong in a superseding record, so the erratum was withdrawn and this document replaces it.

The cost is visible and was accepted: most of what follows is ADR-0010's text unchanged, and every cross-reference to ADR-0010 has been repointed here. The benefit is that there is **one** place to read the outbox contract, rather than a record and a correction that a reader has to hold in their head simultaneously — which is precisely the failure mode the corrections below exist to prevent.

### The four corrections, in one place

| | ADR-0010 said | Corrected to | Why it matters |
|---|---|---|---|
| **1** | `correlation_id text` | `uuid` | Request ids are `randomUUID()`. The narrower type rejects the empty string for free, which `NOT NULL text` does not — and an empty correlation id produces exactly the unjoinable log line the column exists to prevent. No contract change. |
| **2** | `(status, available_at)` index | `(tenant_id, available_at, id) WHERE status = 'PENDING'` | ADR-0003 binds harder; `status` in the key is wasted because the index is partial on it; `id` is the tiebreak without which rows sharing `available_at` order arbitrarily. **Consequence:** "the oldest PENDING row" is not reachable in one query. |
| **3** | "Replay is trivial: reset a row to `PENDING`" and "the outbox row's `id` is the universal idempotency key" | Replay is a **new row**; the idempotency key is **`(tenant_id, topic, effect_key)`** | The reset erases the only record that the effect was performed. And changing the reset to a new row *without* changing the dedup key converts replay from audit-destroying into a **silent double-send** — the worse failure. |
| **4** | Redis job carries `{ outboxId }` | Redis carries a bare **wake signal** | An `{ outboxId }` message invites a lookup, the lookup needs a tenant context, and the only tenant available is one inferred from the message. That is rule 8 violated *quietly*, because the code looks like an ordinary fetch-by-id. |

Corrections 3 and 4 are argued at length in their own sections below, because they change the delivery contract and **silently redefining a delivery contract is how a system ends up sending an invoice twice and having no record of which send was which.**

> **Standing note, recorded at the Accounting Guardian's review rather than as a signature line.** This record needs no Accounting Guardian signature, because an outbox row carries no monetary figure, resolves no period and performs no costing — the dispatcher dispatches, it does not post. **Any future change that puts a monetary figure in an outbox payload, or that lets a dispatcher or consumer write to a financial table, requires the Accounting Guardian's signature.** The FBR e-invoicing integration is where that pressure will arrive: there will be a good-sounding argument for putting the invoice total in the payload to avoid a re-read. That change is theirs; this one is not.

**What is unchanged:** at-least-once delivery; consumer idempotency being mandatory (only its *key* changes); the row being written inside the posting transaction and dispatched after it commits; the payload carrying identifiers and never financial truth; no BYPASSRLS dispatcher; the transaction never holding a network call open.

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
  payload          jsonb not null         ← identifiers + minimal facts, ≤ 4 KB
  effect_key       text not null          ← identity of the EFFECT, not the row
  occurred_at      timestamptz not null   ← business time
  created_at       timestamptz not null default now()
  available_at     timestamptz not null   ← delay / backoff schedule
  status           text not null          ← PENDING | IN_FLIGHT | DONE | FAILED
  attempts         int  not null default 0 ← CONSUMER failures,  cap 10
  reclaims         int  not null default 0 ← DISPATCHER deaths,  cap 5
  claimed_at       timestamptz            ← the lease
  lease_id         uuid                   ← the FENCE on that lease
  last_error       text
  dispatched_at    timestamptz
  acknowledged_at  timestamptz            ← a human owns this FAILED row
  acknowledged_by  uuid
  replay_of        uuid                   ← this row replays that one
  correlation_id   uuid not null          ← request_id, propagated end to end
```

Six columns are new against ADR-0010's sketch, and each closes a failure that sketch permitted:

| | |
|---|---|
| `claimed_at` + `lease_id` | The lease and its **fence**. Without a lease, "mark IN_FLIGHT, commit, crash" strands a row forever and the redelivery guarantee below is unmeetable. Without a fence it is worse than stranded: the original dispatcher wakes and acks a row another dispatcher is actively working, because a correct ack nulls `claimed_at` anyway and nothing distinguishes one lease generation from the next. `lease_id` is regenerated on **every** claim including every reclaim, and every ack, failure and reclaim carries `WHERE id = $1 AND lease_id = $2` and asserts `rowcount = 1`. A dispatcher that fires an update and ignores how many rows it touched cannot detect that it lost its lease. |
| `reclaims`, separate from `attempts` | A deploy that restarts five workers is an **infrastructure event**, not a poison message. Charging it to `attempts` delivers a poison-message verdict on a row whose consumer never once ran. Different cause, different owner, different remedy, different counter. |
| `acknowledged_at` / `_by` | "Alert on any `FAILED` row" against a terminal state with no acknowledgement fires forever from the first poison row and is muted within a week, at which point the system has monitoring in name only. **The alert is over UNACKNOWLEDGED failed rows.** Acknowledgement is an append: once recorded it cannot be withdrawn or reassigned. |
| `replay_of` | See correction 3. `correlation_id` cannot express "this row replays that one" — it also groups every unrelated row from the same request. |
| `effect_key` | See correction 3. |

The payload carries **identifiers, not financial truth** (ADR-0002): `{ saleId, invoiceId }`, not `{ amount, accountId }`. The dispatcher re-reads the committed row, so a payload can never disagree with the ledger and financial detail does not sit in a queue.

### Dispatch

```
worker loop, per tenant batch:
  SELECT … FROM outbox
   WHERE status = 'PENDING' AND available_at <= now()
   ORDER BY available_at, id                ← id is the tiebreak, see correction 2
   FOR UPDATE SKIP LOCKED                   ← concurrent workers, no contention
   LIMIT n                                  ← the per-tenant batch cap

  for each row:
    claim  → IN_FLIGHT, claimed_at = now(), lease_id = gen_random_uuid()
             COMMIT before the side effect. Holding a transaction open across
             an HTTP call is the thing this ADR exists to prevent.
    perform the side effect (HTTP, SMTP, storage, cache)
    ├─ success → DONE, dispatched_at = now()   WHERE id = $1 AND lease_id = $2
    └─ failure → attempts += 1
                 available_at = now() + backoff(attempts)  (exponential + jitter)
                 PENDING, or FAILED once attempts + 1 reaches the cap
                                                WHERE id = $1 AND lease_id = $2

  reaper, concurrently:
    a lease older than the configured interval returns the row to PENDING and
    increments `reclaims`; once reclaims + 1 reaches its cap the row becomes
    FAILED with a synthetic, clearly-attributed last_error, because the reaper
    has no consumer error to record and a row that died of dispatcher restarts
    must be distinguishable on sight from one that failed on its merits.
```

**Write every cap predicate in terms of the RESULTING value.** `attempts + 1 >= 10`, not `attempts < 10`. The naive form is off by one — a row at 4 passes `reclaims < 5`, reclaims to 5, and lands on `PENDING`, which the schema rejects outright. This is recorded because both the implementation and its review got it wrong, and a test caught it.

**The lease interval must exceed the maximum per-topic consumer timeout, with margin**, and the dispatcher asserts this at startup over its registered consumers and refuses to start otherwise. Without that ordering, a merely **slow** consumer loses its row to the reaper every time, burns the reclaim budget, and lands on `FAILED` — a poison-message verdict on a consumer that works, which is the diagnostic confusion the separate counter exists to prevent.

**A lease cannot be extended in place.** Note the reason, because the obvious one is wrong: "a lease that can be extended is not a fence" is *not* true — a renewal that **rotates** the token is still a fence, since the holder must present the current token to get the next one. It is excluded on narrower grounds: rotation-on-renewal adds a failure mode of its own, where the renewal commits, the dispatcher dies before recording the new token, and the live token is held by nobody, so the row waits out the full lease anyway. If renewal is ever needed, **rotation-on-renewal is the sanctioned shape** — recorded so the next person builds the fenced version rather than inventing a non-rotating one.

`FOR UPDATE SKIP LOCKED` lets several worker processes drain the table without stepping on each other. Rows that exhaust either cap go to `FAILED`, which raises an operational alert and is visible in an admin view — a `FAILED` outbox row is a real operational condition, never quietly discarded.

### Correction 4 — Redis carries a wake signal, and nothing else

ADR-0010 inherited [ADR-0002](ADR-0002-postgresql-and-redis.md)'s *"a job says `{ outboxId }`"*. **The message carries no identifier at all.** Redis says only "there is work"; the dispatcher enumerates tenants, opens a `withTenant` transaction per tenant, and claims from `outbox` itself.

ADR-0002's rule is *"identifiers, never financial facts"*, and this is strictly more conservative. Two reasons:

1. **Rule 8, through the back door.** An `{ outboxId }` message invites the worker to look that id up, and the lookup needs a tenant context to run under. The only tenant available at that moment is one inferred from the message — the tenant coming from an untrusted payload, which rule 8 forbids. It would be a *quiet* violation, because the code would look like an ordinary fetch-by-id. The premise is structural rather than cautious: `outbox` is not on the global-table allow-list, so `withGlobal` cannot name it at all, and a fetch-by-id genuinely has nowhere else to obtain a tenant. With no id in the message there is nothing to infer from.
2. **Redis is not the queue of record.** A message naming a specific row invites treating its delivery as meaningful; a bare wake signal cannot be, so a lost signal costs latency until the next poll and nothing else.

PostgreSQL remains the queue of record, so losing Redis delays dispatch and loses nothing.

### Tenant enumeration covers EVERY tenant, of any status

A `SUSPENDED` or `CLOSED` tenant can hold pending rows — a final invoice email, an FBR push owed for a period already posted. Enumerating only active tenants leaves those rows never claimed, never reaped, and never measured, because no measurement is taken for a tenant nobody enumerates. That is a liveness hole, and the convenient query is the one that creates it: `001_create_tenants.sql`'s only index on `tenants` is partial on `status = 'ACTIVE'`.

Scaling note: one claim probe per tenant per poll cycle is O(tenants) queries per interval. Fine at Wave 0 volumes; measure it before the tenant count reaches three figures.

### At-least-once delivery, and what that obliges

The outbox guarantees **at-least-once**, not exactly-once. Exactly-once across a process boundary does not exist: a dispatcher can perform the side effect and then crash before marking the row `DONE`, and on recovery it will perform it again. This is not a defect to engineer away; it is the guarantee, and the system is designed on top of it.

Therefore **every consumer must be idempotent**, and this is a requirement on the consumer, not a hope about the dispatcher:

| Consumer | Idempotency mechanism |
|----------|----------------------|
| Email / SMS | Deduplicate on **`(tenant_id, topic, effect_key)`**; a `sent_notifications` row keyed by that, inserted before send. **Never `outbox.id`** — correction 3 |
| PDF generation | Deterministic object key from `(tenant_id, documentType, documentId, version)`; re-render overwrites the identical artefact |
| FBR POS push | Send the invoice's own document number as the regulator-facing idempotency key; treat "already submitted" as success, not as an error |
| Webhook | Send `Idempotency-Key:` the **effect key**, never `outbox.id`; publish it in the integration contract so receivers can deduplicate. A receiver deduplicating on the row id would accept a replay as a new request — correction 3 |
| Cache invalidation | Naturally idempotent — invalidating twice is invalidating |

The **effect key** — `(tenant_id, topic, effect_key)` — is the universal idempotency key, and it is stable across retries **and across replays**.

> ADR-0010 said here: *"The outbox row's `id` is the universal idempotency key and is stable across retries."* The first clause is false and the second is true only of retries. A replay is a new row with a fresh id, so keying on the row id makes replay a silent double-send. The superseded wording is quoted rather than deleted because the reasoning trail is the point: the sentence was true of the design ADR-0010 described, and became false the moment replay stopped being a reset.

Where an external system offers no idempotency facility, the consumer records its own attempt in PostgreSQL before acting and checks that record on retry, accepting a narrow duplicate-send window in exchange for never losing the effect. **Losing a side effect is worse than duplicating one**, and the design is tuned in that direction deliberately.

Ordering is per-topic best-effort, not guaranteed. A consumer that needs ordering derives it from `occurred_at` and the business document, not from dispatch sequence.

### Correction 3 — replay is a NEW ROW, and it carries `effect_key`

**This is the correction that changes the delivery contract.**

ADR-0010's Consequences said: *"Replay is trivial: reset a row to `PENDING`. Recovering a botched integration is an `UPDATE` on the outbox."*

**That reset is forbidden.** `status = 'DONE'` and `dispatched_at` are not workflow state. They are the **record that the effect was performed**, and frequently the only record — an SMTP send leaves nothing on our side. Resetting the row erases that record and replaces it with a fresh attempt wearing the same id. Afterwards nothing in the system can answer *"was this invoice emailed on the 3rd, or only on the 12th after someone re-ran it?"* — a question a customer, an auditor or the FBR can ask.

A replay is a new row: fresh `id`, `replay_of` pointing at the original, the original left byte-identical, and the replay refused if the original is still live.

**And the part that is easy to get wrong.** ADR-0010 keyed the consumer's `sent_notifications` on `outbox.id`. That is correct for redelivery — the same row arriving twice must act once — and wrong for replay, because a replay row carries a fresh id and sails straight past a dedup table keyed on it. **Replacing the reset with a new row and changing nothing else converts replay from an audit-destroying operation into a silent double-send, and the second failure is worse than the first.**

So the key is `(tenant_id, topic, effect_key)`, where `effect_key` identifies the *business effect* rather than the row that asked for it: "send the invoice email for sale S once". A replay carries its original's `effect_key` unchanged, enforced at insert.

The result: **a replay does not re-send by default.** Genuinely re-performing an effect requires clearing the consumer-side record, which is a deliberate, separately recorded act. That is the right shape — *"I intend to email this customer a second time"* should not be a side effect of fixing a dispatcher.

`effect_key` carries a shape constraint, not only a length. `'sale:S1 '` and `'sale:S1'` would be two dedup slots for one effect, so two enqueuers disagreeing by a trailing space produce a silent double-send through the exact mechanism this correction added to prevent silent double-sends. The constraint names the **whitespace class**, not the space character: measured against the engine, `btrim` strips spaces only, and a tab is exactly as invisible in a log line as a space.

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
- Replay is a **new row**, not a reset — correction 3. Recovering a botched integration is still an `INSERT` on the outbox rather than a data-repair script over financial tables, and the original's evidence survives it.

  > ADR-0010 said here: *"Replay is trivial: reset a row to `PENDING`. Recovering a botched integration is an `UPDATE` on the outbox, not a data-repair script over financial tables."* Quoted rather than deleted: the second half still holds, and the first half is the claim that made an audit-destroying operation sound like a convenience.
- Gives the modular monolith a clean extraction seam for later.

### Negative / accepted costs

- Side effects are asynchronous, so the user does not get "invoice emailed" confirmation in the posting response. The UI reports the posting, and notification status separately.
- At-least-once means duplicates are possible and every consumer must be written idempotently. This is real, recurring work and is a review checklist item for any new consumer.
- The outbox is an operational surface: it needs monitoring for depth, age of oldest pending row, and `FAILED` count, with alerts on each ([ARCHITECTURE.md §10](../ARCHITECTURE.md)).
- The table grows and needs an archival policy for `DONE` rows, plus an index supporting the dispatch query without bloating the write path. Rule 4 forbids `DELETE` and no role holds it, so the only compatible mechanism is `DETACH PARTITION` on a `created_at` range key. **A detached partition is retained and archived, never dropped**, and detaching requires a verified backup and Database Guardian sign-off. Partitioning is deferred and the deferral is recorded in `docs/WAVE_0_REGISTER.md` with both of its costs.
- Debugging spans two processes, which is why `correlation_id` (the originating `request_id`) is mandatory on every row and propagated into the dispatcher's logs.
- A poison row that always fails can consume retry capacity. Bounded by the two caps and per-topic concurrency limits.
- **"The oldest `PENDING` row" is not reachable in one query** — correction 2. RLS confines every dispatch query to one tenant, so a global minimum does not exist by construction. The monitoring bullet is a **maximum over per-tenant measurements**, and fairness across tenants is the dispatcher's scheduling problem — round-robin with a per-tenant batch cap — rather than a property of an `ORDER BY`.

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
- Schema: `outbox` carries `tenant_id NOT NULL` with RLS enabled **and forced**, like every tenant-owned table (ADR-0004). The dispatch index is **`(tenant_id, available_at, id) WHERE status = 'PENDING'`** — correction 2.
- Schema: the status transition graph and post-insert immutability of the evidence columns are enforced by a trigger, **not** by a CHECK. A CHECK sees only a row's final state, and every illegal transition here ends in a state that is legal on its own — which is how an earlier draft came to carry a comment claiming a protection the constraint did not provide.
- Schema: the application role holds **column-scoped** `UPDATE`, with the default table-level grant revoked first. Without the revoke the column list is decorative, because table-level `UPDATE` supersedes it entirely.
- Integration test: kill the worker mid-dispatch after the side effect but before the `DONE` mark; assert the row is redelivered and the consumer's idempotency guard prevents a duplicate effect.
- Integration test: a **stale** dispatcher, whose lease has been reclaimed, affects **zero rows** when it acks — and its failure path cannot steal the row from the live claimant either. Paired with a positive control proving the live claimant can still ack, so the fence cannot pass by blocking everything.
- Integration test: roll back a posting transaction that wrote an outbox row; assert no row exists and no side effect occurs.
- Consumer contract test: every registered consumer is exercised twice with the same **`(tenant_id, topic, effect_key)`**, including once via a replay row carrying a different `id`, and asserted to produce one effect.

  > ADR-0010 required this "twice with the same `outbox.id`". **That form passes against a consumer that double-sends on replay**, which is the whole of correction 3. This is the bullet most likely to be dropped when someone writes the first consumer, so it is stated as a requirement rather than a note.
- Monitoring: alerts on queue depth, the age of the oldest `PENDING` row **as a maximum over per-tenant measurements taken across every tenant of any status**, and any **unacknowledged** `FAILED` row. A `FAILED` row is an operational incident with an owner, and acknowledgement is what takes it off the alert — which is why acknowledgement is an append that cannot be withdrawn.
- Dispatcher test: `app.tenant_id` is asserted to be set from the outbox row before any consumer code runs, and unset after. Never from the Redis message — correction 4.
- Dispatcher requirement: **every ack, failure and reclaim asserts `rowcount = 1`.** A dispatcher that fires an update and ignores how many rows it touched cannot detect that it lost its lease, which is the entire content of the fence.
- Dispatcher requirement: `EXPLAIN (ANALYZE, BUFFERS)` on the claim query against at least 10^6 rows across 50 or more tenants, attached to the dispatcher's pull request. A plan reviewed against ten rows is not evidence — the planner picks a sequential scan for a handful of rows whatever the indexes say.
- Schema verification: `database/tests/outbox.spec.ts`, through **direct SQL** rather than a repository, because every guarantee here has to hold against a psql session, a migration, an admin script and a future import. Rule 21 contemplates humans with direct access, and a control that only works when called through the right TypeScript is not a control.

## Signatures

`Deciders: Product Owner, Architecture Guardian`. The Accounting Guardian reviewed this record for accounting touchpoints and confirmed none bind — see the standing note in the summary above, which is recorded at review rather than as a signature line.

| | |
|---|---|
| **Architecture Guardian** | ✅ **ACCEPTED**, 2026-09-23, subject to three corrections outside this record — all landed: the committed `generated/schema.d.ts` was stale (ADR-0013 deferral D3's first live instance, in the commit that caused it, with every gate green); a line-number citation into a superseded record; and a "no DDL changed" claim in `004`'s revision note, when `COMMENT ON` is DDL and writes `pg_description`. |
| **Accounting Guardian** | — not required. Confirmed at review. |
| **Product Owner** | ✅ **SIGNED**, 2026-09-24 — see below |

> Product Owner — 2026-09-24 — "Accept ADR-0013, ADR-0014, ADR-0016, and ADR-0019 after the PO signs each dated signature block. Guardian evidence is present; no financial invariant violation was found."

Both signatures are recorded, so the status is **Accepted** and [ADR-0010](ADR-0010-transactional-outbox.md) is now `Superseded by ADR-0019`. The two moved together, as ADR-0007 and ADR-0015 do.

**Database Guardian condition C2 was breached and is now satisfied, in that order.** C2 required that `004_create_outbox.sql` not merge before this record was accepted, because the migration cites the supersession in the present tense. The migration merged on 2026-09-23 and this was accepted on 2026-09-24, so for one day a released migration cited a Proposed record. No code consequence — the schema is identical either way — and it is recorded rather than passed over, because a condition quietly overtaken by events is a condition that stops being written next time.

**Status stays `Proposed`.** A record carrying two of three signatures and an `Accepted` status would claim more than it has, which is the defect class this document was rejected over the first time. The status flips when the last box carries a name and a date, and not before.

## Related

- [ADR-0010](ADR-0010-transactional-outbox.md) — superseded by this record
- [ADR-0003](ADR-0003-shared-database-multi-tenancy.md) — why `tenant_id` leads every index
- [ADR-0001](ADR-0001-modular-monolith.md) — the extraction seam this creates
- [ADR-0002](ADR-0002-postgresql-and-redis.md) — PostgreSQL is the queue of record; Redis carries the signal
- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — the transaction the outbox row joins
- [ADR-0004](ADR-0004-postgresql-row-level-security.md) — how the dispatcher establishes tenant context
- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — why the tenant is never taken from a payload
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 9, 14, 20
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §7 transactions and the outbox, §10 observability, §11 performance guardrails
