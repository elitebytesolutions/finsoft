# ADR-0020: Audit hash chain — canonicalisation and chain integrity

**Status:** Proposed
**Date:** 2026-09-24 · revised 2026-09-25 after guardian review
**Deciders:** Product Owner, Architecture Guardian, Database Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Blocks:** migration 007 (`audit_log`) and everything that writes to it

## Context

[NON_NEGOTIABLES rule 9](../NON_NEGOTIABLES.md) requires an append-only `audit_log`, hash-chained per tenant for tamper evidence:

> `hash = H(previous_hash || canonical(record))`

It does not define `canonical`, and that word is carrying the entire guarantee.

**The failure this ADR exists to prevent is not tampering.** It is the day, three years from now, when the chain fails to verify and nobody can tell whether a row was altered or whether a library started serialising a timestamp differently. At that moment a tamper-evidence scheme that cannot be re-derived is worse than none: it manufactures an unresolvable doubt about records filed with the FBR and used to decide whether a business is solvent.

**An independent party, given only this document and the table contents, must be able to recompute every hash and get the same bytes.** That is the test every decision below is measured against — and the first review verified it by regenerating this document's golden vector from the specification alone, without reference to any implementation.

### What does not work, measured

**`payload::text` in SQL.** PostgreSQL orders `jsonb` keys **length-first**:

```sql
'{"bb":1,"aa":2,"b":3,"a":4,"ccc":5}'::jsonb  →  {"a":4,"b":3,"aa":2,"bb":1,"ccc":5}
RFC 8785 would emit                              a, aa, b, bb, ccc
```

They agree for single-character keys and diverge the moment one is longer — a scheme validated on `{"id":…,"qty":…}` breaks on `{"id":…,"quantity":…}`.

`jsonb` also mangles numbers, **and the first version of this sentence got the mechanism wrong.** It does not "preserve whatever numeric text it was given". It **preserves scale and normalises notation**:

```sql
1.10  →  1.10        0.1000 →  0.1000      scale kept
1e21  →  1000000000000000000000           notation normalised
1E5   →  100000                            -0  →  0
```

Which is a *stronger* indictment than the original claim: `jsonb` keeps lexical detail a value-based scheme would drop **and** discards lexical detail a byte-based scheme would need. Corrected here because a document whose thesis is "measured rather than assumed" cannot carry a measured claim that does not survive measurement.

**`JSON.stringify` in TypeScript.** Key order is insertion order. And:

```js
JSON.stringify(1.10)  →  1.1        trailing zero lost
JSON.stringify(1e21)  →  1e+21
```

A tampered `1.10 → 1.1` would **not** break a chain built on it — the single change such a chain most needs to catch.

---

## Decision

### 1. The format is versioned, and the version is inside the hash

```
audit_log.hash_version  text NOT NULL  CHECK (hash_version IN ('v1'))
```

Every row records the scheme that produced its hash, and the version string is hashed. A future ADR may define `v2`; `v1` rows stay verifiable under `v1` rules forever, and a verifier selects its algorithm from the row rather than from the calendar.

**Adding a column to `audit_log` requires a new `hash_version`.** The record membership in §4 is a closed list, not "whatever columns exist" — otherwise an `ALTER TABLE ADD COLUMN` silently redefines what was hashed and every prior row becomes unverifiable with no signal.

### 2. `canonical(record)` is RFC 8785, with every value a string

[RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785): keys sorted by UTF-16 code unit, no insignificant whitespace, defined escaping, UTF-8 output.

**One restriction that is ours, not JCS's: no JSON numbers and no JSON booleans. Every leaf is a string or `null`.**

| | |
|---|---|
| Money | `"1.1000"` — the fixed-scale form ADR-0011 and ADR-0014 already require |
| Quantity | `"40.000000"` |
| Integer | `"3"` |
| Boolean | `"true"` / `"false"` |
| Timestamp | `"2026-09-24T00:16:59.383214Z"` — see §4's mapping |
| uuid | lowercase canonical |
| Absent | key **omitted** |
| Explicitly null | `null` |

**Arrays are permitted.** JCS handles them and preserves order, and a before/after image legitimately contains one. Array *elements* obey the same no-numbers rule.

Three reasons, the third of which is the decisive one:

1. JCS serialises numbers as ECMAScript does — the lossy path measured above. Admitting no numbers means that rule never applies.
2. `"1.10"` and `"1.1"` become different bytes, which is correct: at scale 4 they are different representations and only one is stored.
3. **It makes the app → `jsonb` → verifier round-trip lossless.** The hash is computed by the application *before* the insert and recomputed by the verifier *after* reading back, so the two forms must be provably identical. With numbers admitted they are not: `{"amount":1.10}` hashes app-side through the ECMAScript rule as `1.1`, and reads back from `jsonb` as `1.10`. **One stray number produces a row that can never be verified again** — precisely the unresolvable doubt this ADR exists to prevent.

Because (3) is a correctness requirement rather than a style rule, it is enforced by a schema `CHECK`, not by convention. See Compliance.

**The representable subset is narrower than JCS's.** `jsonb` rejects `\u0000` (`ERROR: \u0000 cannot be converted to text`) and lone surrogates, both of which RFC 8785 admits. It fails closed — the insert aborts the transaction — but a reimplementer working from this document should know the string space is a strict subset.

### 3. Unicode is PRESERVED, not normalised

**RFC 8785 does not normalise.** `"é"` as U+00E9 and as U+0065 U+0301 are different bytes and hash differently.

This ADR adds no normalisation step. The decisive reason is not Unicode-version drift, though that is real: **NFC is not the identity on all inputs, so normalising would mean hashing bytes different from the bytes stored** — which breaks the "recompute from the stored columns" property §6 depends on.

**So the rule is about where normalisation may happen, not whether users type differently.** The hazard is not two people entering `é` two ways; those are genuinely different stored values and the chain should say so. The hazard is a **driver, ORM or library normalising between hashing and storage, or between storage and verification**. §4's writer rule forbids exactly that.

### 4. The hashed input, byte for byte

```
H = SHA-256
hash = hex( H( previous_hash_ascii || 0x1F || version_ascii || 0x1F || jcs_utf8 ) )
```

| | |
|---|---|
| `previous_hash_ascii` | the parent's `hash` as 64 lowercase hex **ASCII characters**; for genesis, `"0" * 64` |
| `0x1F` | ASCII Unit Separator, one byte, twice |
| `version_ascii` | `"v1"` |
| `jcs_utf8` | RFC 8785 output, UTF-8, no BOM, no trailing newline |
| `hash` | 64 lowercase hex characters |

**On the separators.** The first version justified these as preventing a concatenation ambiguity. That justification was wrong and is withdrawn: `previous_hash` is fixed at 64 hex characters and `jcs_utf8` always begins with `{`, so the concatenation was already unambiguous and the stated attack was not achievable. The separators stay for **forward compatibility** — a `v2` digest of different length would make the framing load-bearing — and the framing is only safe because `hash_version`'s CHECK admits no `0x1F`. `0x1F` cannot occur in JCS output (JSON escapes everything below U+0020) nor arise from UTF-8 (no continuation byte falls below 0x80), verified both ways.

#### The record is these twelve columns, and no others

```
id · tenant_id · seq · occurred_at · actor_user_id · action
entity_type · entity_id · before_json · after_json · ip · request_id
```

**Excluded: `hash`, `previous_hash` and `hash_version`.** `hash` is the output; the other two are already hashed as the framing. The first version said "every audit column except `hash` and `previous_hash`", which contradicted this list because `hash_version` is an audit column — and the two readings give different answers:

```
list as written (12 columns)   →  38e6aa16f94d209ecdf1c21a813d47918982fbd843e19ff01f507d4de4db0d11
with hash_version included     →  50855dd5e5a65cea4279373a6af26962d73f404f6cf955901a9d5cab2b0fa82a
```

The twelve-column list is normative. Where prose and list disagree, the list wins.

`before_json` and `after_json` are embedded as **objects** and canonicalised by the same JCS pass, not as pre-serialised strings.

#### Column → canonical value

**This table is normative, and its absence was the single biggest defect in the first version.** The canonical record is defined over *logical values*; §6 requires the verifier to recompute from *stored columns*. Without a stated mapping the two are not the same thing, and PostgreSQL's default rendering does not produce the specified strings:

```sql
'2026-09-24T00:16:59.383214Z'::timestamptz::text  →  2026-09-24 00:16:59.383214+00   space, +00
'2026-09-24T00:16:59.383000Z'::timestamptz::text  →  2026-09-24 00:16:59.383         trailing zeros GONE
'203.0.113.7'::inet::text                         →  203.0.113.7/32                  prefix appended
'2001:db8:0:0:0:0:0:1'::inet::text                →  2001:db8::1/128                 abbreviated
```

**Under an `inet` column, this ADR's own golden vector did not verify.**

| column | type | canonical value |
|---|---|---|
| `id` | `uuid` | lowercase canonical, `id::text` |
| `tenant_id` | `uuid` | as above |
| `seq` | `bigint` | decimal string, no sign for positives: `"1"` |
| `occurred_at` | `timestamptz` | `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` — **always six fractional digits**, `Z`, never `+00`. Verified to produce `2026-09-24T00:16:59.383000Z` |
| `actor_user_id` | `uuid` | lowercase, or `null` |
| `action` | `text` | as stored |
| `entity_type` | `text` | as stored |
| `entity_id` | `uuid` | lowercase, or `null` |
| `before_json` | `jsonb` | the parsed value, JCS-canonicalised, or `null` |
| `after_json` | `jsonb` | as above |
| `ip` | **`text`, not `inet`** | as stored |
| `request_id` | `uuid` | lowercase, or `null` |

**`ip` is `text` deliberately.** `inet` renders with a `/32` or `/128` prefix and abbreviates IPv6, so a canonical string would need an unstated normalisation rule on the one column most likely to differ between writer and verifier. `text` stores exactly what is hashed. The cost is that PostgreSQL will not validate the address, so the application does — a bounded, stated trade.

#### Two writer-side rules that make §6 true

1. **The hash is computed over the values exactly as they will be stored.** No layer may transform a value between hashing and storage, or between storage and verification. This is where §3's Unicode rule bites.
2. **`occurred_at` is generated by the application, never by a database `DEFAULT now()`.** The writer cannot hash a value the database has not produced yet. And `Date.prototype.toISOString()` yields **three** fractional digits, not six — so the application constructs the microsecond form explicitly and sends it as a string. Verified: `new Date(…).toISOString()` → `2026-09-24T00:16:59.383Z`.

### 5. Chain integrity

Deterministic bytes are necessary and nowhere near sufficient.

#### What the constraints actually give — corrected

The first version claimed "forks are structurally impossible". **That was false, and it was demonstrated.** With only `UNIQUE (tenant_id, seq)` and `UNIQUE (tenant_id, previous_hash)`, all three of these insert cleanly:

| | |
|---|---|
| `previous_hash` referencing no row, `seq = 500` | **accepted** — a detached segment |
| a second row carrying a `hash` the tenant already has | **accepted** — the chain stops being a function |
| `previous_hash = hash` | **accepted** — a self-link |

`UNIQUE (tenant_id, previous_hash)` guarantees *at most one child per parent hash*. It does not guarantee the parent exists, that `hash` is unique, or that linkage agrees with `seq`. `finsoft_app` holds `INSERT` by design, so a buggy or compromised append path reaches all three.

Stating a protection the mechanism does not provide is the defect `004` draft 2 was rejected for. It is corrected here rather than repeated.

#### The mechanism, as built and tested

```sql
seq            bigint NOT NULL CHECK (seq >= 1),
hash           text   NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
previous_hash  text   NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),

CONSTRAINT audit_log_tenant_seq_key  UNIQUE (tenant_id, seq),
CONSTRAINT audit_log_tenant_hash_key UNIQUE (tenant_id, hash),
CONSTRAINT audit_log_tenant_prev_key UNIQUE (tenant_id, previous_hash),
CONSTRAINT audit_log_not_self        CHECK  (previous_hash <> hash),
CONSTRAINT audit_log_genesis_ties    CHECK  ((seq = 1) = (previous_hash = repeat('0', 64))),
```

plus a `BEFORE INSERT` trigger asserting the link:

```sql
IF NEW.seq > 1 AND NOT EXISTS (
  SELECT 1 FROM audit_log
   WHERE tenant_id = NEW.tenant_id AND seq = NEW.seq - 1 AND hash = NEW.previous_hash
) THEN RAISE EXCEPTION 'audit_log: previous_hash does not match the hash at seq %', NEW.seq - 1;
```

**`previous_hash` is `NOT NULL`, and that is load-bearing.** `UNIQUE` does not constrain NULLs — three `(tenant, NULL)` rows insert happily — so a nullable genesis marker voids the fork constraint entirely and silently.

**The trigger, not a self-referencing foreign key.** A self-FK plus a per-tenant anchor row at `seq = 0` is the declarative alternative and was tested to work. It is rejected because the anchor row needs a `created_by` and 002 already rejected a per-tenant system user, making tenant provisioning carry an authorship problem to solve a linkage one. The trigger has a known limit — the owning role can `ALTER TABLE … DISABLE TRIGGER` — but the append-only control below already depends on a trigger and already requires a test asserting triggers are enabled, so this adds no new class of weakness.

Measured with exactly this scheme: the orphan is rejected with `previous_hash does not match the hash at seq 499`, the duplicate hash by `audit_log_tenant_hash_key`, the self-link by `audit_log_not_self`, a second genesis by `audit_log_tenant_seq_key`, and a legitimate append succeeds.

#### `seq` allocation

**Transactional, gapless, from 1, allocated under the lock, and explicitly NOT a PostgreSQL sequence.**

`MAX(seq) + 1` for the tenant, read under the advisory lock. This is the one sanctioned `MAX+1` in the codebase and the exception is narrow: rule 12 forbids it for *document numbers*, where the risk is a gap or a duplicate in a user-facing series. Here gaplessness is the point — **§6 treats a `seq` gap as evidence of a deleted row**, so a sequence would manufacture a false tamper alert on every ordinary rollback.

#### Concurrency, and the isolation level it depends on

```sql
SELECT pg_advisory_xact_lock( ('x' || substr(replace(tenant_id::text, '-', ''), 1, 16))::bit(64)::bigint );
```

**The one-argument form, keyed on the tenant's own bits** — not `(4919, hashtext(tenant_id::text))`. Two reasons: `hashtext` is an undocumented internal function with no stability contract, and its `int4` output collides (2 collisions in 200k random uuids), which couples unrelated tenants — tenant A's posting could wait on tenant B's long import and time out because of it. That is an availability coupling in the posting path, cheaply removed. The cost is losing the namespace idea; see the debt note below.

**The scheme depends on READ COMMITTED, and the first version never said so.** Measured, same harness, only the isolation level changed:

```
READ COMMITTED    T2 blocks on the lock, T1 commits, T2 re-reads the head, links → seq 2
REPEATABLE READ   T2 acquires the lock instantly, reads the head through its OLD snapshot,
                  sees nothing → ERROR: duplicate key … (tenant_id, seq)=(…, 1)
```

It fails closed, which is the right direction. [ARCHITECTURE §5](../ARCHITECTURE.md) fixes READ COMMITTED system-wide, so this is not live today — but a future ADR raising isolation on the posting path would turn every concurrent append into a posting error, and nothing would have warned them.

That divergence is also the proof that the constraints are **not** redundant with the lock: under REPEATABLE READ the lock granted instantly and the unique constraint was the only thing standing between that transaction and a duplicate.

#### Lock placement is normative, not an implementation detail

`pg_advisory_xact_lock` cannot be released before COMMIT, so hold time is everything from acquisition to commit.

> **The audit append is the LAST write before commit. The lock is acquired at that point. No external call — HTTP, SMTP, queue — happens while it is held. A `lock_timeout` bounds the queue so contention surfaces as a bounded error rather than an unbounded stall.**

This is stated normatively because the difference is roughly 40×. Against [ARCHITECTURE §11](../ARCHITECTURE.md)'s posting P95 < 800 ms: a lock held across a ~200 ms posting transaction caps one tenant at ~5 postings/second, and a month-end with 20 concurrent users in one tenant blows the budget on queueing alone. Held for the last few milliseconds, the same load is comfortable. Leaving that to "before reading the chain head" would have let Wave 2 discover it as a performance incident rather than choose it as a design.

The mechanism itself is not the cost — the head read measures 0.027 ms, 3 buffers, `Index Scan Backward using audit_log_tenant_seq_key`, which also confirms the constraint index serves the append path and no extra index is needed for it.

#### Row level security

`audit_log` is tenant-owned, so, exactly as `004`:

```sql
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

The first version of this ADR mentioned RLS zero times while authorising a new tenant-owned table.

### 6. Verification

```
npm run audit:verify -- --tenant <id>
```

Walks the chain in `seq` order and reports **the first break, with its `seq` and `id`** — not a boolean. A verifier that answers yes/no is useless during an incident, when the question is always "from where".

It recomputes from stored columns using each row's own `hash_version`, and reads through `readonly_support` — a verifier needing write access can repair what it is checking.

Detects, each with a test that plants exactly this: an altered field; a deleted row (`seq` gap, and the successor links to nothing); a reordered pair; an appended forgery.

---

## The normative examples

### Example 1 — genesis

```json
{"action":"SESSION_CREATED","actor_user_id":"6f1e9e1a-0d3e-4a5b-8c7d-2e4f6a8b0c1d","after_json":{"mfa":"false"},"before_json":null,"entity_id":"9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d","entity_type":"session","id":"11111111-2222-4333-8444-555555555555","ip":"203.0.113.7","occurred_at":"2026-09-24T00:16:59.383214Z","request_id":"d87bba6f-e498-495e-acc5-1fb75e5fc075","seq":"1","tenant_id":"00000000-0000-4000-8000-000000000001"}
```

```
JCS length    = 426 bytes
previous_hash = "0000000000000000000000000000000000000000000000000000000000000000"
framed input  = 494 bytes
hash          = 38e6aa16f94d209ecdf1c21a813d47918982fbd843e19ff01f507d4de4db0d11
```

**Computed, not asserted — and independently regenerated during review from this specification alone, with input keys deliberately shuffled.** That reproduction is the ADR's central claim tested rather than stated.

### Example 2 — the trailing zero, in full

The first version gave this with an ellipsis under a heading calling it normative, and used `"1.1"` — a value §2, ADR-0011 and ADR-0014 all forbid on the wire. A normative example depicting a record that cannot legitimately exist is worse than no example.

```json
{"action":"PRICE_OVERRIDDEN","actor_user_id":"6f1e9e1a-0d3e-4a5b-8c7d-2e4f6a8b0c1d","after_json":{"amount":"1.1100"},"before_json":{"amount":"1.1000"},"entity_id":"9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d","entity_type":"price","id":"22222222-3333-4444-8555-666666666666","ip":"203.0.113.7","occurred_at":"2026-09-24T00:17:04.120000Z","request_id":"d87bba6f-e498-495e-acc5-1fb75e5fc075","seq":"2","tenant_id":"00000000-0000-4000-8000-000000000001"}
```

```
JCS length    = 444 bytes
previous_hash = 38e6aa16f94d209ecdf1c21a813d47918982fbd843e19ff01f507d4de4db0d11   (Example 1)
hash          = bc41ce062e558a0ebe4bd967937aa9db9bed5241e7df9c26bc7357db20546343
```

Both amounts at scale 4, and this record chains onto Example 1 — so the two together are a two-link chain a verifier can walk end to end, which is what the first version's ellipsis made impossible.

`"1.1000"` and `"1.1100"` are different strings and hash differently; under `JSON.stringify` they would have become `1.1` and `1.11`, and a tampered `1.1000 → 1.1` would have been invisible.

Golden vectors ship as `packages/audit/src/canonical.vectors.json` with expected JCS bytes and hash for each, so a reimplementation in another language is checked without reading the code.

---

## Consequences

**Positive.** Reproducible by anyone with the table and this document. Versioned, so the scheme can change without invalidating history. Forks are caught by named constraints. Money cannot silently change representation.

**Negative, and accepted.**

- **Every audited write serialises per tenant** — not just posting. The genesis example is `SESSION_CREATED`, so logins contend with postings for the same tenant, and with argon2id at 23.4 ms that is a real interaction. **The measurement is deferred to Wave 2; the lock placement is decided here**, because it is the variable the measurement depends on and building it wrong first is how Wave 2 inherits a 40× problem.
  - Recorded fallback, so Wave 2 chooses between options rather than inventing one under pressure: a per-tenant `audit_chain_head` row updated with `UPDATE … RETURNING`, which serialises identically, yields gapless `seq` transactionally in one round trip, and fails closed under any isolation level.
- **A JCS implementation is a dependency** in a security-critical path. Small, and the golden vectors are the defence.
- **Unicode composition differences produce different hashes.** §3.
- **Every value a string makes `after_json` less pleasant to query.** The audit log is evidence, not a reporting surface.
- **`ip` as `text` loses PostgreSQL's address validation.** §4.

---

## Alternatives considered

**`jsonb::text`.** Rejected on measurement — length-first key ordering, and number notation normalised by the store.

**`JSON.stringify` with sorted keys.** Rejected: the number rule remains, and `1.10 → 1.1` would hide a monetary change from the chain built to detect it.

**Self-referencing FK plus an anchor row**, instead of the linkage trigger. Tested and works; rejected because the anchor row needs an authorship that 002 deliberately does not provide.

**`(4919, hashtext(tenant_id))` advisory lock.** Rejected for the cross-tenant contention coupling and `hashtext`'s lack of a stability contract.

**Signing each record.** Stronger against an attacker who controls the database, and rejected for now: it needs a key the application holds, and an attacker with the database usually has the application. Available as a superseding ADR if the threat model changes.

**Merkle tree.** Disproportionate — efficient inclusion proofs for a log nobody queries that way, at the cost of a structure much harder to verify by hand.

**Normalising to NFC.** Rejected in §3: it would hash bytes different from the stored bytes.

---

## Compliance

### Schema facts migration 007 must carry

- `hash_version` `NOT NULL` with `CHECK (hash_version IN ('v1'))`.
- The five constraints and the linkage trigger of §5, by name.
- `previous_hash` and `hash` `NOT NULL` with `^[0-9a-f]{64}$`.
- **`REVOKE UPDATE ON audit_log FROM finsoft_app;` before any grant.** The first version said `UPDATE`/`DELETE` are granted "to nobody … because a future `ALTER DEFAULT PRIVILEGES` could re-grant". **That mechanism is wrong.** Default privileges apply at `CREATE TABLE`: a table created by `finsoft_migration` arrives with `finsoft_app` already holding `UPDATE`, and nothing re-grants later. Nothing "re-granted" on `outbox` — draft 2 simply never revoked. The wrong mechanism implies the wrong remedy, because an author satisfies "granted to nobody" by writing no `GRANT` and ships a table whose application role can rewrite audit history.
- **The append-only trigger is the control against the OWNING role**, not belt-and-braces for `finsoft_app` — the REVOKE handles that role completely. `finsoft_migration` owns the table and holds `DELETE`/`TRUNCATE` inherently. Its limit, measured: the owner cannot `SET session_replication_role = replica`, but **can** `ALTER TABLE … DISABLE TRIGGER` and then delete. So a schema test asserting `pg_trigger.tgenabled = 'O'` is part of the control, not an extra.
- A **`BEFORE TRUNCATE` statement trigger**; `DELETE`/`UPDATE` triggers do not see TRUNCATE.
- `ENABLE` **and** `FORCE` RLS, `tenant_isolation` with both `USING` and `WITH CHECK`.
- A `CHECK` enforcing §2's no-numbers/no-booleans rule on `before_json` and `after_json`, via an `IMMUTABLE` recursive function. Not a style rule — see §2 reason (3).
- Indexes beyond the constraint indexes: `(tenant_id, entity_type, entity_id, seq)` and `(tenant_id, occurred_at)`.
- `action` shape CHECK, following `004`'s `topic` precedent. Size bounds on `before_json`/`after_json`, following `004`'s `payload` bound — with more force here, because these rows are never deleted.
- `004`-style lock-footprint header; forward-only rollback note; `CHECKSUMS` manifest line.

### The mandatory column set — `audit_log` is exempt

[IMPLEMENTATION §11](../IMPLEMENTATION.md) and `database/tests/schema.spec.ts` require `created_at · created_by · updated_at · updated_by · version` on every tenant-owned table. **`audit_log` carries none of them**, and the exemption is named in `schema.spec.ts` rather than left to the migration author.

The reasoning: `occurred_at` and `actor_user_id` already carry when and by whom, so `created_at`/`created_by` would duplicate hashed fields with unhashed copies. And `updated_at`/`updated_by`/`version` on an INSERT-only table are nonsense on their face — there is no update, so there is no optimistic lock and no last writer. Including them unhashed would put five mutable, unverifiable columns on the one table whose entire purpose is that its contents cannot change without detection.

### Tests

- Golden vectors reproduced by the implementation.
- A planted altered field, deleted row and reordered pair, each named by `seq` by the verifier.
- **A concurrent append test running as `finsoft_app` under RLS**, not as the migration role — a fork test running with `BYPASSRLS` is not testing the table the application writes to.
- **A variant that deliberately omits the advisory lock** and asserts the unique constraint fires. That turns "never remove this as redundant" from an instruction into an executable fact.
- A test asserting both triggers are still enabled.
- The verifier runs as `readonly_support`, asserted.

### Deferred, and recorded rather than discovered

- **Partitioning.** Intended key: RANGE on `occurred_at`. Not declared in 007. `UNIQUE (tenant_id, seq)` and the linkage trigger narrow the options **permanently** at 007, so this is the cheapest moment it will ever be — recorded now for that reason.
- **Retention.** Rule 9 says statute, not disk. With `DELETE` granted to nobody the only compatible mechanism is `DETACH PARTITION`, which depends on the above. A detached partition is retained and archived, never dropped.
- **Advisory-lock namespace registry.** Does not exist; this ADR is the first claimant and uses the one-argument space. Owed before the second claimant.
- **A named domain error at the audit-append boundary** for `jsonb`'s rejection of `U+0000` and lone surrogates, which currently surfaces as an opaque database error aborting a posting transaction.

## Related

- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rule 9, which this implements; rule 12, which §5 carves a narrow exception to
- [../ARCHITECTURE.md](../ARCHITECTURE.md) §9 audit, §5 isolation level, §11 the P95 budget this constrains
- [ADR-0011](ADR-0011-money-representation.md), [ADR-0014](ADR-0014-decimal-js.md) — why money is a fixed-scale string before it arrives
- [ADR-0018](ADR-0018-stock-state-scopes-and-locking.md) — rejects advisory locks for stock state. **No conflict:** that objection is that a lock released on commit never protected the prior row, and here there is no prior row — the lock guards a read-then-insert, which is the case advisory locks are correct for.
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — correction by reversal, which is what the chain records
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)

## Signatures

| | |
|---|---|
| **Architecture Guardian** | ☐ not recorded — REJECTED 2026-09-25, 15 required changes, all addressed above |
| **Database Guardian** | ☐ not recorded — REJECTED 2026-09-25, 12 required changes, all addressed above |
| **Product Owner** | ☐ not recorded |

Migration 007 does not merge before all three.
