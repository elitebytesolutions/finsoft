# ADR-0022: Refresh rotation has no grace window

**Status:** Accepted
**Date:** 2026-09-25
**Accepted:** 2026-09-25, by the Product Owner, on the guardian evidence recorded in the Signatures block below
**Deciders:** Product Owner, Architecture Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Supersedes:** [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) **in respect of the grace window only**, at three sites: the Decision clause at ADR-0009:83, the words "Handled by the grace window and" in the accepted cost at ADR-0009:138, and the words "beyond the grace window" in the compliance bullet at ADR-0009:162. ADR-0009 remains in force in every other respect — rotation, reuse detection, family revocation, hash-at-rest, and the serialisation half of :138. A permanent supersession scope notice at its head names the three provisions, per [README](README.md) §4.

> **Scope note.** The review that raised this named two sites, :83 and :138. There are three: the compliance bullet at :162 states the test in terms of "beyond the grace window", so leaving it would make ADR-0009's own gate contradict its Decision. All three are named here.

## Signatures

> **Architecture Guardian — author, 2026-09-25.** ADR-0009:83's grace window is un-implementable under hash-at-rest: returning "the already-issued pair" requires the successor's raw value, which ADR-0009:85 deliberately never stores. The two ways to honour it are each refused elsewhere in ADR-0009. Scoped to three named sites, not the whole record.

> **Database Guardian — no objection, 2026-09-25.** Reviewed from the schema side; migration 005 no longer asserts anything about the grace window, and `refresh_tokens_enforce_transition()` makes a window un-simulable in application code.

> **Product Owner — SIGNED, 2026-09-25** — "i accept both".

## Context

ADR-0009:83 reads:

> A short grace window (a few seconds) tolerates a genuine network retry replaying the same refresh, returning the already-issued pair rather than killing the family. Beyond the window, reuse is reuse.

ADR-0009:138 repeats it as an accepted cost — "Handled by the grace window and by serialising refresh per session" — and ADR-0009:162 writes it into the compliance gate.

W1-001 (migration 005, sessions and rotating refresh tokens) is the first work to implement this clause, and it cannot. The finding was raised independently by the Architecture Guardian and the Database Guardian, who rated it blocking. It rests on two arguments. The second was made by the Product Owner before any code was written and is recorded in `docs/WAVE_1_REGISTER.md:271-275`.

### 1. The clause is un-implementable under ADR-0009's own storage decision

Two lines below it, ADR-0009:85 decides that refresh tokens are **stored hashed (SHA-256)** so that "a database read does not yield usable credentials". The grace window requires the server, on a replay, to return **the already-issued pair** — which means re-sending the successor's **raw** value. The server does not have it. It holds `refresh_tokens.token_hash` and nothing else (`database/migrations/005_create_sessions.sql:365-366`), and a SHA-256 digest is not invertible.

There are exactly two ways to honour :83, and both are refused elsewhere in ADR-0009:

- **Retain the raw successor** for the window's duration — in a column, in Redis, or in process memory. This reverses ADR-0009:85 for that duration and puts a live bearer credential somewhere other than the client's cookie. A stolen backup or a compromised cache becomes a breach rather than an incident, which is the exact property :85 exists to buy.
- **Mint a second successor** and return that. This is not "the already-issued pair"; it is a second simultaneously live token in one family. One live token per family is what makes a spent token evidence of compromise, so this does not tolerate the replay — it removes the signal rotation exists to produce. It also answers an attacker's replay with a *fresh valid credential*, which is the indefinite silent foothold ADR-0009:149 rejects non-rotating tokens for.

So :83 is not merely unwise. It is inconsistent with :85, and no implementation satisfies both. A LEVEL 1 record cannot be left in that state for an implementer to resolve in a migration comment.

### 2. The window is a window in which a thief's replay is accepted

The grace window's stated purpose is to distinguish a genuine network retry from an attack. **The server cannot make that distinction, because it is not present in the evidence.** A replayed stolen refresh token and a second browser tab send the same cookie, to the same endpoint, and the server sees one thing in both cases: a token whose `used_at` is already set. OAuth 2.0 security guidance identifies precisely this inability to tell the attacker from the client during replay.

A time bound does not supply the missing evidence. It only decides how long the indistinguishable case is resolved *in the attacker's favour*. And the attacker chooses when to replay: exfiltration-to-use latency on a stolen cookie is typically short, so a window measured in seconds preferentially covers the fast automated replay, while the legitimate case it was written for — a retry after a failed request — is not reliably inside it either.

The same fact is already executable in the suite:

```
tests/integration/refresh-rotation.spec.ts:197   the loser is indistinguishable from an attacker
```

Both presentations of the spent token return `[]`. There is no input on which an application branch could be written, so a window is not a rule about intent — it is a rule about the clock.

## Decision

### 1. There is no grace window, and no tolerance of any duration

Rotation is atomic and single-use. **Presenting a spent refresh token revokes its family, whoever presented it, at any interval after the spend.** The server does not attempt to infer intent, because the evidence that would support the inference never reaches it.

This is not "a grace window configured to zero". No window exists as a concept, a column, a GUC, an environment variable, a tenant setting or a code path. A configurable tolerance is a decision surface, and this decision is not the tenant's, the operator's, or a future deadline's to reopen; reopening it is a superseding ADR.

The other half of ADR-0009:138 stands: refresh **is** serialised per session — by the row lock on the spend statement, not by a window.

```sql
UPDATE refresh_tokens
   SET used_at = now(), updated_by = $2, version = version + 1
 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING id, family_id;
```

- rowcount 1 — this caller won and may rotate.
- rowcount 0 — read the row. `used_at IS NOT NULL` is **reuse**: revoke the family. `expires_at <= now()` is expired, and an unknown hash is unknown; both are a bare 401.

Two concurrent callers cannot both see rowcount 1: the second blocks on the row lock and re-evaluates `used_at IS NULL` against the committed row (`database/migrations/005_create_sessions.sql:85-88`).

### 2. What replaces it: the client coordinates, and the loser retries explicitly

The legitimate case the window was written for is real, and it is handled where the necessary information exists — in the client, which knows how many of its own tabs are asking.

1. **One in-flight refresh per browser context.** Concurrent callers that observe an expired access token do not each `POST /auth/refresh`. They await a single shared in-flight refresh. Within a tab that is one shared promise; across tabs of one origin it is a cross-context lock (Web Locks, with a `BroadcastChannel` fallback).
2. **An explicit retry policy for the loser.** A caller that did not initiate the refresh awaits the winner's outcome and retries its *original request* with the new access token. It never retries the refresh itself with a token it has already seen presented.
3. **A lost refresh response is a re-authentication, not a retry.** If the client never receives the response, it holds no successor and its cookie still carries the spent value. It must **not** replay it; it re-authenticates. Replaying is the one action guaranteed to revoke the family, and the client is the only party that knows the difference between "I never saw the answer" and "I am presenting this for the second time".
4. **The server does not participate in any of this.** It has no notion of tab, retry, attempt count or client identity on this path, and no client-supplied value influences the decision.

### 3. What this ADR does not decide

It does not touch rotation, reuse detection, family revocation, hash-at-rest, token lifetime, `SameSite`/path scoping, or MFA. It does not decide the user-facing presentation of a forced re-authentication, which belongs to W1-003 and `apps/web`. It does not decide the alert triage runbook beyond requiring that the false-positive source named below is written into it.

## Consequences

### Positive

- Reuse detection becomes unconditional: one rule, no branch, and no clock on a security decision. Time-dependent security branches are the hardest kind to test deterministically and the easiest kind to widen by one configuration change.
- The ADR and the schema agree. ADR-0009:83 and ADR-0009:85 no longer require opposite things of the same code path.
- No raw refresh token exists server-side for any duration. The property in :85 becomes absolute rather than "absolute except for a few seconds after every rotation".
- The server's behaviour is determined entirely by data it can trust — the same principle as ADR-0009:60-61 on `tenant_id`.

### Negative / accepted costs

- **A lost refresh response costs a re-authentication.** The user is signed out and signs in again. This is precisely the cost the grace window was written to avoid, and it is accepted rather than engineered away, because every mechanism that avoids it also accepts the thief's replay. Mitigated in likelihood, not in kind, by refreshing proactively at roughly 75% of the access token's life rather than on a 401, so a failure lands in the background instead of mid-action.
- **Reuse alerts have a non-zero false-positive rate.** A dropped response followed by a client that ignores rule 3 above produces a family revocation and a security alert with no attacker behind it. The runbook must say so; an alert channel assumed to be 100% true positives is ignored the first time it is not. The rate is itself a signal — a rising one means a client coordination bug or a degraded network path, and is triaged as that.
- **The single-flight requirement is real client work**, in `apps/web` and in any later non-browser client, and a client that omits it will revoke families under ordinary multi-tab use. It is therefore a tested requirement, not a note in a README.
- Mobile and non-browser clients must implement the same coordination without Web Locks. Stated now so it is designed rather than discovered.

## Alternatives considered

**Keep the window and store the raw successor briefly (Redis, a few seconds, keyed by the presented hash).** The strongest alternative, and rejected on both arguments. It reverses ADR-0009:85 for the window's duration by putting a live credential in a store chosen for being disposable (ADR-0002), and it still resolves the indistinguishable case in the attacker's favour for as long as it runs. It buys a rare UX event with a standing credential store.

**Keep the window, re-minting a fresh successor on replay instead of returning the old one.** Rejected. Two live tokens in one family is not tolerance of a retry; it is the removal of the reuse signal, and it answers a theft with a working credential.

**A "configurable grace window", defaulting to zero.** Rejected, and named explicitly because it is the form in which this decision would most plausibly be reopened. Zero-by-default is dead code on the authentication path that becomes live under deadline pressure, and it puts a LEVEL 1 security decision behind a configuration key a LEVEL 3 change can flip. If the decision should change, the path is a superseding ADR.

**A client-supplied idempotency key on the refresh request.** Rejected. Whoever holds the cookie can also supply the key; an attacker replaying a stolen cookie replays the header beside it. It adds an attacker-controlled input to the one path that must depend on none.

**Tolerating the replay when the device fingerprint matches.** Rejected. `sessions.device_id` is computed from request-supplied material (`database/migrations/005_create_sessions.sql:165-169`) and is forgeable by anyone positioned to have taken the cookie. It restates "trust the client" as a column.

**Server-side serialisation alone, with the second caller blocking until the first commits and then receiving the first's result.** The row lock already gives the first half, and the second half is impossible for the reason in Context §1: the loser cannot be handed the winner's raw token, because the server does not hold it. The lock prevents a double spend; it cannot manufacture a credential.

## Compliance

- `tests/integration/refresh-rotation.spec.ts:197` — `the loser is indistinguishable from an attacker`: a second presentation of a spent token and a replay of that same token return identical empty results, so no branch on intent can exist. Already passing; it becomes this record's primary gate rather than an incidental assertion.
- **A new test asserting no tolerance at any delay**, in the same file: a replay presented immediately after the spend, within the same millisecond, revokes the family exactly as a replay an hour later does. This is the assertion a re-introduced window would fail, and it must exist before W1-002 ships the endpoint.
- `database/migrations/005_create_sessions.sql:557-563` — `refresh_tokens_enforce_transition()` makes `used_at` one-way, so a window cannot be simulated in application code by clearing or re-dating the spend. The column grant at `005:751` bounds which columns move; the trigger bounds which direction.
- **No grace period exists as a named thing.** A lint or grep gate over `packages/auth`, `apps/api` and `database/` fails the build on a `grace`-named symbol, column, configuration key or environment variable on the refresh path. A dead configuration surface is how this decision comes back.
- `apps/web` — a test asserting that N concurrent 401-driven callers produce exactly one `POST /auth/refresh`, and that a caller losing the race re-issues its original request rather than the refresh.
- Every family revocation writes an audit record in the same transaction with a reason distinguishing `REUSE_DETECTED` (rule 9) and raises the alert ADR-0009:162 requires. The runbook records the false-positive source named above.
- From acceptance, ADR-0009:162 is read without the words "beyond the grace window": replaying a consumed refresh token revokes the whole family, ends its sessions, writes an audit record and raises an alert.

## Related

- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — :83, :138 and :162, superseded here; :85 (hash at rest), which :83 contradicts; :60-61 on trusting only server-asserted input
- [ADR-0002](ADR-0002-postgresql-and-redis.md) — why Redis is not where a live credential lives
- [ADR-0021](ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md) — the other LEVEL 1 record migration 005 is blocked on
- [../WAVE_1_REGISTER.md](../WAVE_1_REGISTER.md) — W1-001 finding R3; W1-002 §271-275, where the Product Owner's correction is recorded
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 8, 9, 20
