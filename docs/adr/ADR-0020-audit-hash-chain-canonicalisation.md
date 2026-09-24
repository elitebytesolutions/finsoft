# ADR-0020: Audit hash chain canonicalisation

**Status:** Proposed
**Date:** 2026-09-24
**Deciders:** Product Owner, Architecture Guardian, Database Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Blocks:** migration 007 (`audit_log`) and everything that writes to it

## Context

[NON_NEGOTIABLES rule 9](../NON_NEGOTIABLES.md) requires an append-only `audit_log`, hash-chained per tenant for tamper evidence:

> `hash = H(previous_hash || canonical(record))`

It does not define `canonical`, and that word is carrying the entire guarantee.

**The failure this ADR exists to prevent is not tampering.** It is the day, three years from now, when the chain fails to verify and nobody can tell whether a row was altered or whether a library started serialising a timestamp differently. At that moment a tamper-evidence scheme that cannot be re-derived is worse than none: it manufactures an unresolvable doubt about records that are filed with the FBR and used to decide whether a business is solvent.

So the requirement is stronger than "pick a serialisation". **An independent party, given only this document and the table contents, must be able to recompute every hash and get the same bytes.** That is the test every decision below is measured against.

### What does not work, measured rather than assumed

Two obvious approaches were tested against the running engine and both fail.

**`payload::text` in SQL.** PostgreSQL's `jsonb` sorts object keys by **length first**, then bytewise:

```sql
SELECT '{"b":1,"aa":2}'::jsonb::text;   →  {"b": 1, "aa": 2}
```

RFC 8785 sorts by UTF-16 code unit, which puts `aa` before `b`. The two orderings agree for single-character keys and diverge the moment a key is longer — so a scheme validated on `{"id":…,"qty":…}` would break on `{"id":…,"quantity":…}`. `jsonb` also preserves whatever numeric text it was given (`1.10` stays `1.10`, `1.0` stays `1.0`), so the bytes depend on how the caller wrote the number rather than on its value.

**`JSON.stringify` in TypeScript.** Key order is insertion order, not sorted. And numbers go through ECMAScript `Number::toString`:

```js
JSON.stringify(1.10)  →  1.1        trailing zero lost
JSON.stringify(1e21)  →  1e+21      exponential notation
```

A money value of `1.10` and one of `1.1` are the same amount and different bytes. Worse, they are the same bytes after `JSON.stringify`, so a tampered `1.10 → 1.1` would not break the chain.

Neither is a canonicalisation. Both are a serialisation that happens to be stable until it isn't.

## Decision

### 1. The format is versioned, and the version is inside the hash

```
audit_log.hash_version   text NOT NULL   -- 'v1' for everything this ADR defines
```

Every record records the scheme that produced its hash, and the version string is part of the hashed input. A future ADR may define `v2`; rows written under `v1` remain verifiable under the `v1` rules **forever**, and a verifier selects its algorithm from the row rather than from the calendar.

Without this, changing the scheme means either rewriting history — which rule 9 forbids and which would destroy the evidence — or leaving a chain nobody can verify from either end.

### 2. `canonical(record)` is RFC 8785 (JCS), with every value a string

[RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) is the base: sorted keys by UTF-16 code unit, no insignificant whitespace, defined string escaping, UTF-8 output.

**With one restriction that is ours, not JCS's: the canonical record contains no JSON numbers and no JSON booleans. Every value is a string or `null`.**

| | |
|---|---|
| A money amount | `"1.1000"` — the fixed-scale serialisation ADR-0011 and ADR-0014 already require |
| A quantity | `"40.000000"` |
| An integer | `"3"` |
| A boolean | `"true"` / `"false"` |
| A timestamp | RFC 3339 with `Z` and microsecond precision: `"2026-09-24T00:16:59.383214Z"` |
| A uuid | lowercase canonical form |
| Absent | the key is **omitted**, never `"null"` |
| Explicitly null | `null` |

The reason is JCS's number rule: it serialises numbers as ECMAScript does, which is exactly the lossy path measured above. By admitting no numbers, that rule never applies and the trailing-zero question never arises. **`"1.10"` and `"1.1"` become different bytes, which is correct — for a monetary amount at scale 4 they are different representations and only one of them is the stored value.**

`null` and absent are distinguished deliberately: "the field was cleared" and "the field does not apply" are different facts about a financial record, and collapsing them loses evidence.

### 3. Unicode is PRESERVED, not normalised — and that is a limitation, stated

**RFC 8785 does not normalise Unicode.** It escapes what JSON requires escaping and passes every other code point through unchanged. `"é"` as U+00E9 and `"é"` as U+0065 U+0301 render as different bytes and hash differently.

This ADR does **not** add a normalisation step, and the reason is that normalisation is itself a versioned, evolving specification: NFC under Unicode 15 and NFC under Unicode 17 can differ for newly assigned code points, which would reintroduce exactly the "did it change or did the library change" problem in the one place it must not exist.

**The consequence, stated rather than hidden:** two audit records whose text differs only by Unicode composition are different records to this chain. A customer name re-entered from a different keyboard produces a different `after_json` and a different hash. That is correct for tamper evidence — the stored bytes did change — and it means the chain answers "have these bytes changed", not "does this mean the same thing". The second question is not one a hash can answer, and claiming otherwise is the overstatement this repository's reviews keep finding.

### 4. The hashed input, byte for byte

```
H = SHA-256

hash = hex( H( previous_hash_bytes || 0x1F || version_bytes || 0x1F || jcs_bytes ) )
```

| | |
|---|---|
| `previous_hash_bytes` | the parent's `hash`, as its 64 lowercase hex **ASCII characters**. For the genesis row, the 64-character string `"0" * 64` |
| `0x1F` | ASCII Unit Separator, one byte, twice |
| `version_bytes` | `"v1"` in ASCII |
| `jcs_bytes` | the RFC 8785 output of the record object, UTF-8, no BOM, no trailing newline |
| `hash` | 64 lowercase hex characters |

The separators are not decoration. Without them, concatenating a previous hash and a record is ambiguous: a crafted record beginning with hex characters could in principle produce the same byte sequence as a different (hash, record) pair. `0x1F` cannot occur in JCS output — JSON requires escaping every code point below U+0020 — so the framing is unambiguous by construction.

**The record object contains every audit column except `hash` and `previous_hash`.** Both are excluded: `hash` because it is the output, and `previous_hash` because it is already hashed as the first field, and including it twice would mean a verifier that omitted one got a different answer with no way to know which was intended.

```
id, tenant_id, seq, occurred_at, actor_user_id, action,
entity_type, entity_id, before_json, after_json, ip, request_id
```

`before_json` and `after_json` are **embedded as objects**, not as pre-serialised strings, and are canonicalised by the same JCS pass. Embedding them as strings would make the hash depend on how the caller serialised them, which is the defect this whole document exists to remove.

### 5. The chain is ordered by `seq`, and cannot fork

Deterministic bytes are necessary and **nowhere near sufficient**. The harder problem is concurrency: two transactions both read the current head, both compute `previous_hash = H`, and both insert. The result is two rows claiming the same parent — a **forked chain**, in which both branches verify perfectly and the log has silently lost its total order.

Three mechanisms, and all three are required:

```sql
seq          bigint NOT NULL,
CONSTRAINT audit_log_tenant_seq_key      UNIQUE (tenant_id, seq),
CONSTRAINT audit_log_tenant_prev_key     UNIQUE (tenant_id, previous_hash),
```

1. **`seq`**, a per-tenant monotonic counter, gives the chain an order that does not depend on `occurred_at` — two records in the same microsecond are still ordered, and a clock adjustment cannot reorder history.
2. **`UNIQUE (tenant_id, previous_hash)`** makes a fork impossible rather than unlikely. The second concurrent insert claiming the same parent fails with a unique violation. This is the backstop, and it must never be removed as "redundant with the lock".
3. **A transaction-scoped advisory lock per tenant**, taken before reading the head:

```sql
SELECT pg_advisory_xact_lock(4919, hashtext(tenant_id::text));
```

so the second writer **waits** rather than failing. Without it the unique constraint turns ordinary concurrency into user-visible errors; without the constraint the lock is the only thing standing between a dropped advisory lock and a forked chain. `4919` is a namespace constant reserved for the audit chain, so these locks never collide with any other advisory-lock user.

**The lock serialises audit appends per tenant, and that is a deliberate cost.** Rule 9 requires the audit record to be written in the same transaction as the change, so this serialises *posting* per tenant. That is acceptable — and it is a real constraint on Wave 2's throughput, recorded here rather than discovered there.

### 6. Verification

```
npm run audit:verify -- --tenant <id>
```

Walks a tenant's chain in `seq` order and reports **the first break, with its `seq` and `id`** — not a boolean. A verifier that answers yes/no is useless during an incident, when the question is always "from where".

It recomputes every hash from the stored columns using the row's own `hash_version`. It reads through the `readonly_support` role, because a verifier that needs write access is a verifier that can repair what it is checking.

It must detect, and each has a test that plants exactly this:

| | |
|---|---|
| An altered field | the row's own hash no longer matches its content |
| A deleted row | `seq` gap, and the successor's `previous_hash` matches nothing |
| A reordered pair | `previous_hash` linkage breaks even though both hashes are individually valid |
| An appended forgery | rejected at insert by the unique constraint; if introduced by direct SQL, the chain from that point does not link |

## The fixed examples an independent verifier must reproduce

Normative. An implementation that does not produce these bytes is wrong, whatever its tests say.

### Example 1 — genesis record

Record object:

```json
{"action":"SESSION_CREATED","actor_user_id":"6f1e9e1a-0d3e-4a5b-8c7d-2e4f6a8b0c1d","after_json":{"mfa":"false"},"before_json":null,"entity_id":"9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d","entity_type":"session","id":"11111111-2222-4333-8444-555555555555","ip":"203.0.113.7","occurred_at":"2026-09-24T00:16:59.383214Z","request_id":"d87bba6f-e498-495e-acc5-1fb75e5fc075","seq":"1","tenant_id":"00000000-0000-4000-8000-000000000001"}
```

Note what the JCS pass produced: keys sorted by code unit (`action` … `tenant_id`), no whitespace, `seq` as the string `"1"`, `before_json` as `null` and not `"null"`.

```
previous_hash = "0000000000000000000000000000000000000000000000000000000000000000"
hashed bytes  = <previous_hash ASCII> 1F "v1" 1F <JCS UTF-8 above>
JCS length    = 426 bytes

hash = 38e6aa16f94d209ecdf1c21a813d47918982fbd843e19ff01f507d4de4db0d11
```

**That hash was computed, not asserted.** An implementation that produces anything else for this input is wrong, and this value is the first thing a reimplementation in another language should be checked against.

### Example 2 — the trailing zero that must not be lost

```json
{"after_json":{"amount":"1.1000"},"before_json":{"amount":"1.1"},…}
```

`"1.1000"` and `"1.1"` are different strings and hash differently. Under `JSON.stringify` both would have become the number `1.1` and the change would have been invisible — which is the concrete reason for the no-numbers rule.

The implementation ships these as golden vectors in `packages/audit/src/canonical.vectors.json`, with the expected JCS bytes and the expected hash for each, so a future reimplementation in another language can be checked against them without reading the code.

## Consequences

**Positive.** The chain is reproducible by anyone with the table and this document. The format is versioned, so it can change without invalidating history. Forks are structurally impossible rather than unlikely. Money cannot silently change representation.

**Negative, and accepted.**

- **Audit appends serialise per tenant**, and because rule 9 puts the audit write in the posting transaction, so does posting. Measured in Wave 2 against the P95 budget; if it binds, the answer is a per-tenant chain shard, which is a superseding ADR and not a quiet change.
- **A JCS implementation is a dependency**, in a security-critical path. It is small, and the golden vectors are the defence against a bad one.
- **Unicode composition differences produce different hashes.** Section 3.
- **Every value being a string makes `after_json` less pleasant to query.** Accepted: the audit log is evidence, not a reporting surface, and a report that needs typed values reads the source table.

## Alternatives considered

**PostgreSQL `jsonb::text`.** Rejected on measurement — key ordering is length-first and number text is caller-dependent. It also puts the canonicalisation in the database, where a major-version upgrade could change it.

**`JSON.stringify` with sorted keys.** Rejected: the number rule remains, and the measured `1.10 → 1.1` collapse would hide a monetary change from the chain built to detect it.

**Signing each record rather than chaining.** Stronger against an attacker who controls the database, and rejected for now: it needs a key the application holds, and an attacker who has the database usually has the application. Chaining plus append-only grants plus an offline verifier is the proportionate control, and signing remains available as a superseding ADR if the threat model changes.

**Merkle tree instead of a linear chain.** Rejected as disproportionate: it buys efficient inclusion proofs for a log nobody queries that way, at the cost of a structure that is much harder to verify by hand.

**Normalising Unicode to NFC before hashing.** Rejected in §3 — it makes the scheme depend on a Unicode version, reintroducing the exact ambiguity the versioned format exists to remove.

## Compliance

- `hash_version` is `NOT NULL` with a `CHECK` constraint listing known versions. An unknown version is a row no verifier claims to understand.
- `UNIQUE (tenant_id, seq)` and `UNIQUE (tenant_id, previous_hash)`, both non-negotiable.
- `audit_log` grants: `INSERT` and `SELECT` only for `finsoft_app`; `SELECT` for `readonly_support`; `UPDATE` and `DELETE` to nobody, plus a trigger that raises on either — belt and braces, because a future `ALTER DEFAULT PRIVILEGES` could re-grant what a migration revoked, as it did on `outbox`.
- Golden vectors committed, and a test asserts the implementation reproduces every one.
- A test plants an altered field, a deleted row and a reordered pair, and asserts the verifier names the first break by `seq`.
- A **concurrent** test: two transactions appending for the same tenant at once produce two correctly-linked rows, never a fork. Concurrent by construction, like `tenant-isolation-concurrent.spec.ts`.
- The verifier runs as `readonly_support`, asserted.

## Related

- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rule 9, which this implements
- [../ARCHITECTURE.md](../ARCHITECTURE.md) §9 — audit architecture
- [ADR-0011](ADR-0011-money-representation.md), [ADR-0014](ADR-0014-decimal-js.md) — why money is a fixed-scale string before it reaches this
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — correction by reversal, which is what the chain records rather than an edit
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) — JSON Canonicalization Scheme

## Signatures

| | |
|---|---|
| **Architecture Guardian** | ☐ not recorded |
| **Database Guardian** | ☐ not recorded |
| **Product Owner** | ☐ not recorded |

Migration 007 does not merge before all three.
