# ADR-0010 erratum 001: the outbox delivery contract, corrected

**Status:** Proposed — requires Architecture Guardian sign-off before `004_create_outbox.sql` merges
**Date:** 2026-09-23
**Deciders:** Architecture Guardian, Product Owner
**Authority:** LEVEL 1 — amends [ADR-0010](ADR-0010-transactional-outbox.md), which remains Accepted
**Blocks:** `database/migrations/004_create_outbox.sql`

---

## Why an erratum rather than a comment in the migration

Implementing ADR-0010 produced four places where the schema departs from the record. The first draft of `004_create_outbox.sql` noted two of them in SQL comments and said of one that "an ADR-0010 erratum is owed for that line."

An owed erratum is not an erratum. A migration comment cannot amend a LEVEL 1 record, and a reader who trusts ADR-0010 — which is the correct thing to do with a LEVEL 1 record — would find the schema disagreeing with it and conclude the schema was wrong. Two of the four go further than a divergence: they change what "delivered" and "replayed" mean, and **silently redefining a delivery contract is how a system ends up sending an invoice twice and having no record of which send was which.**

Each correction below states what ADR-0010 says, what the schema does, and why. None of them weakens at-least-once delivery or consumer idempotency, which remain exactly as ADR-0010 describes.

---

## Erratum 1 — `correlation_id` is `uuid`, not `text`

**ADR-0010 implies** a text correlation identifier.

**The schema uses `uuid`.** Request ids are minted by `randomUUID()` in `packages/observability/context.ts`, so the narrower type is the true one. It also rejects the empty string for free, which a `NOT NULL text` column does not — and an empty correlation id produces precisely the unjoinable log line the column exists to prevent.

**No contract change.** Anything that could legitimately have been stored is still storable.

---

## Erratum 2 — the dispatch index is `(tenant_id, available_at, id)`, not `(status, available_at)`

**ADR-0010 Compliance says:** *"`(status, available_at)` index supports the dispatch query."*

**The schema uses** a partial index `(tenant_id, available_at, id) WHERE status = 'PENDING'`.

Three reasons, in order of authority:

1. **ADR-0003 binds harder.** `tenant_id` leads every index on a tenant-owned table.
2. **`status` in the key is wasted.** The index is partial on `status = 'PENDING'`, so every row in it has the same status. Partial is what keeps it bounded: rule 4 means `DONE` rows never leave, so an index over all statuses would grow without limit while the working set stayed small.
3. **`id` is a tiebreak, not decoration.** Many rows share `available_at = now()` from the column default. Without a third key column the order among them is arbitrary, which permits a starved row and makes the query plan irreproducible.

### The consequence that is a real contract change

**"The oldest `PENDING` row" is not reachable in one query.** RLS confines every dispatch query to one tenant, so a global minimum does not exist by construction.

ADR-0010's monitoring bullet — *"age of the oldest `PENDING` row"* — is therefore redefined: it is a **maximum over per-tenant measurements**, not a single query. Fairness across tenants becomes the dispatcher's scheduling problem — round-robin with a per-tenant batch cap — rather than a property of an `ORDER BY`.

**And the enumeration covers every tenant, of any status.** A `SUSPENDED` or `CLOSED` tenant can hold pending rows: a final invoice email, an FBR push owed for a period already posted. Enumerating only active tenants would leave those rows never claimed, never reaped, and never measured — because no measurement is taken for a tenant nobody enumerates. That is a liveness hole, and the convenient query is the one that creates it: `001_create_tenants.sql`'s only index on `tenants` is partial on `status = 'ACTIVE'`.

---

## Erratum 3 — replay is a NEW ROW, not a reset. And it carries `effect_key`.

**This is the correction that changes the delivery contract, and it is the one that must not pass silently.**

**ADR-0010 Consequences says:** *"Replay is trivial: reset a row to `PENDING`. Recovering a botched integration is an `UPDATE` on the outbox, not a data-repair script over financial tables."*

**The schema forbids that reset outright.** `outbox_enforce_transition()` raises on any update leaving a `DONE` row.

### Why the reset is wrong

`status = 'DONE'` and `dispatched_at` are not workflow state. They are the **record that the effect was performed**, and they are frequently the only record — an SMTP send leaves nothing on our side. Resetting the row erases that record and replaces it with a fresh attempt wearing the same id. Afterwards, nothing in the system can answer *"was this invoice emailed on the 3rd, or only on the 12th after someone re-ran it?"* — which is a question a customer, an auditor or the FBR can ask.

The old draft of 004 claimed a CHECK constraint prevented the reset. **It did not.** `UPDATE outbox SET status = 'PENDING', dispatched_at = NULL` satisfies `(false) = (false)`, leaves `claimed_at` already NULL so the other biconditional holds, and was within reach of any code holding the UPDATE grant. That claim is corrected in the file, and the mechanism that does forbid it is a trigger.

### What replay is instead

A new row: fresh `id`, `replay_of` pointing at the original, the original left byte-identical. `correlation_id` cannot express this on its own — it also groups every unrelated row from the same request.

### And the part that is easy to get wrong

**ADR-0010 keys the consumer's `sent_notifications` on `outbox.id`.** That is correct for redelivery — the same row arriving twice must act once — and **wrong for replay**, because a replay row carries a fresh id and would sail straight past a dedup table keyed on it. Replacing a reset with a new row, and changing nothing else, would convert "replay" from an audit-destroying operation into a **silent double-send**. The second failure is worse than the first.

So the deduplication key is corrected to **`(tenant_id, topic, effect_key)`**, where `effect_key` identifies the *business effect* rather than the row that asked for it: "send the invoice email for sale S once". A replay carries its original's `effect_key` unchanged — enforced by `outbox_enforce_replay()`, which rejects a replay that mints a new one.

The result is that a replay **does not re-send by default**. Genuinely re-performing an effect requires clearing the consumer-side record, which is a deliberate, separately recorded act. That is the right shape: *"I intend to email this customer a second time"* should not be a side effect of fixing a dispatcher.

**ADR-0010's consumer contract test is amended** from *"exercised twice with the same `outbox.id`"* to *"exercised twice with the same `(tenant_id, topic, effect_key)`, including once via a replay row with a different `id`"*. The original form passes against a consumer that would double-send on replay.

---

## Erratum 4 — Redis carries a wake signal, not `{ outboxId }`

**[ADR-0002](ADR-0002-postgresql-and-redis.md) says:** *"A job says `{ outboxId }`, not `{ amount, accountId }`; the worker re-reads the row from PostgreSQL."*

**The schema's dispatcher design puts nothing in the message.** Redis carries only "there is work"; the dispatcher enumerates tenants, opens a `withTenant` transaction per tenant, and claims from `outbox` itself.

ADR-0002's rule is *"identifiers, never financial facts"*, and this is strictly more conservative — it carries no identifier either. Two reasons:

1. **Rule 8, through the back door.** An `{ outboxId }` message invites the worker to look that id up, and the lookup needs a tenant context to run under. The only tenant available at that moment is one inferred from the message. That is the tenant coming from an untrusted payload, which rule 8 forbids — and it would be a *quiet* violation, because the code would look like an ordinary fetch-by-id. With no id in the message there is nothing to infer from.
2. **Redis is not the queue of record.** ADR-0002 already says PostgreSQL is. A message that names a specific row invites treating its delivery as meaningful; a bare wake signal cannot be, so a lost signal costs latency until the next poll and nothing else.

**No contract change to ADR-0002's rule**, which forbids financial facts. This is narrower than what that rule permits.

---

## Additive departures, recorded for completeness

Not divergences — ADR-0010 is silent on them — but they are the mechanisms the above rests on, so a reader comparing schema to record should find them named.

| | |
|---|---|
| `claimed_at` + `lease_id` | The lease and its **fence**. Without a lease, "mark IN_FLIGHT, commit, crash" strands a row forever and ADR-0010's redelivery guarantee is unmeetable. Without a fence, the recovered row is worse than stranded: the original dispatcher wakes and acks a row another dispatcher is actively working. Every ack, failure and reclaim carries `WHERE id = $1 AND lease_id = $2` and asserts `rowcount = 1`. |
| `attempts` cap 10, `reclaims` cap 5 | ADR-0010 requires `FAILED` at the cap; nothing enforced it, so a dispatcher that never capped retried forever and passed every assertion. Two budgets because a deploy that restarts five workers is an **infrastructure event**, not a poison message: different cause, different owner, different remedy. |
| `acknowledged_at` / `acknowledged_by` | ADR-0010's *"alerts on … any `FAILED` row"* against a terminal state with no acknowledgement fires forever from the first poison row and is muted within a week. **The alert is amended to unacknowledged `FAILED` rows.** |
| `payload` bounded to 4096 bytes | Measured on the **normalised** jsonb text, which is not the bytes the client sent — PostgreSQL re-serialises canonically, so a 4096-byte input arrives as 4097 and is refused. Enqueuers should treat 4 KB as a budget with headroom, not an exact boundary. |
| `updated_by` pinned to `created_by` | Every write after the INSERT is machine-driven, and [ADR-0004](ADR-0004-postgresql-row-level-security.md) forbids a system principal. The honest meaning of the column on this table is "the user on whose behalf the effect was enqueued", which never changes. A constraint says that where a comment would leave a slot for a future author to fill. |
| Partitioning deferred | `created_at` RANGE, recorded and not declared. See the migration header and `docs/WAVE_0_REGISTER.md` for both costs, including that the claim query has no `created_at` predicate and so must consider every partition on every poll. |

---

## What is unchanged

Stated explicitly, because an erratum that touches delivery semantics should say what it did **not** touch:

- **At-least-once delivery.** Unchanged.
- **Consumer idempotency is still mandatory.** Only its key changes, from `outbox.id` to `(tenant_id, topic, effect_key)`.
- **The row is written inside the posting transaction and dispatched after it commits.** Unchanged, and the reason the table exists.
- **The payload carries identifiers, never financial truth.** Unchanged, and now bounded as well.
- **No BYPASSRLS dispatcher, no dispatcher policy, no exception.** Unchanged.
- **The transaction never holds a network call open.** Unchanged.

---

## Verification

`database/tests/outbox.spec.ts` — 40 cases, through **direct SQL** rather than a repository, because every guarantee here has to hold against a psql session, a migration, an admin script and a future import. Rule 21 contemplates humans with direct access, and a control that only works when called through the right TypeScript is not a control.

Covering: lease fencing (a stale ack affects zero rows and leaves the new lease intact; a stale failure cannot steal the row); the transition graph through direct `UPDATE`; both caps and the terminal state; replay preserving evidence and refusing a fresh `effect_key`; the payload boundary measured as the database measures it; tenant scoping, batch bounds and the suspended-tenant starvation case; and crash-after-enqueue redelivery.

Two defects in this migration were found by that suite rather than by review:

- **The column-scoped `UPDATE` grant was decorative.** `00-bootstrap.sh` sets `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE`, so the table arrived with table-level UPDATE already granted, which supersedes any column list. The migration now `REVOKE`s it first.
- **The reaper's predicate was off by one.** `reclaims < 5` passes at 4, reclaims to 5, and lands on `PENDING`, which `outbox_reclaims_exhausted_is_failed` rejects. The statement is now written in terms of the resulting value — `reclaims + 1 < 5` — because that is what the constraint is written in terms of.

Applied and verified on both paths: a **fresh installation** (001–004 against a cluster created from nothing) and an **upgrade** (004 applied onto a database holding exactly 001–003, which is staging's current state).

---

## Sign-off

| | |
|---|---|
| Architecture Guardian | ☐ not recorded |
| Product Owner | ☐ not recorded |

`004_create_outbox.sql` does not merge before both are entered. Nothing here is approved by having been written down.
