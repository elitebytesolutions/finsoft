# ADR-0020: Audit hash chain — canonicalisation and chain integrity

**Status:** Accepted
**Date:** 2026-09-24 · revised 2026-09-25 after three rounds of guardian review
**Accepted:** 2026-09-25, by the Product Owner, on the guardian evidence recorded in the Signatures block below
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

**Nullability is stated for all twelve, because §2 distinguishes an omitted key from an explicit `null`** — so it is part of the canonical bytes, not a schema detail. An earlier revision gave it for four columns and left the other eight to be read by omission.

| column | type | null? | canonical value |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | lowercase canonical, `id::text` |
| `tenant_id` | `uuid` | NOT NULL | as above |
| `seq` | `bigint` | NOT NULL | decimal string, no sign for positives: `"1"` |
| `occurred_at` | `timestamptz` | NOT NULL | `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` — **always six fractional digits**, `Z`, never `+00`. Verified to produce `2026-09-24T00:16:59.383000Z` |
| `actor_user_id` | `uuid` | **nullable** | lowercase, or `null` |
| `action` | `text` | NOT NULL | as stored |
| `entity_type` | `text` | NOT NULL | as stored |
| `entity_id` | `uuid` | **nullable** | lowercase, or `null` |
| `before_json` | `jsonb` | **nullable** | the parsed value, JCS-canonicalised, or `null` |
| `after_json` | `jsonb` | **nullable** | as above |
| `ip` | **`text`, not `inet`** | **nullable** | as stored |
| `request_id` | `uuid` | **nullable** | lowercase, or `null` |

**`ip` is nullable deliberately.** Job- and system-originated audit events have no client address, and a `NOT NULL` `ip` would force them to invent one — a fabricated value hashed into a chain whose entire purpose is that its contents are trustworthy.

**`ip` is `text` deliberately.** `inet` renders with a `/32` or `/128` prefix and abbreviates IPv6, so a canonical string would need an unstated normalisation rule on the one column most likely to differ between writer and verifier. `text` stores exactly what is hashed. The cost is larger than "PostgreSQL will not validate the address", which is how an earlier revision framed it. **The real loss is NORMALISATION.** `inet` collapsed `2001:db8:0:0:0:0:0:1` and `2001:db8::1`, and `203.0.113.7` against `::ffff:203.0.113.7`, to a single stored form. Under `text` the canonical bytes depend on whichever proxy or runtime rendered the address, so §3's rule that no layer may normalise between hashing and storage has lost its only database-side backstop on the one column most exposed to it.

This is not a chain break — each row still hashes exactly what it stores — but it is a loss of evidentiary comparability *across* rows: two records of the same client can hash different `ip` bytes. The application must therefore render addresses normatively before hashing: **lowercase, RFC 5952 IPv6 compression, and IPv4-mapped addresses written in dotted-quad form**, with a shape CHECK and length bound in the schema as a floor.

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
seq            bigint NOT NULL CHECK (seq >= 0),
hash           text   NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
previous_hash  text          CHECK (previous_hash ~ '^[0-9a-f]{64}$'),

CONSTRAINT audit_log_tenant_id_id_key UNIQUE (tenant_id, id),
CONSTRAINT audit_log_tenant_seq_key  UNIQUE (tenant_id, seq),
CONSTRAINT audit_log_tenant_hash_key UNIQUE (tenant_id, hash),
CONSTRAINT audit_log_tenant_prev_key UNIQUE (tenant_id, previous_hash),   -- see note

-- COMPOSITE, like every other table in the repository. A single-column
-- `REFERENCES users(id)` is checked with row security OFF, and was measured to
-- accept an audit row in one tenant naming a user owned by another. That is
-- worse here than anywhere else: `actor_user_id` is one of the twelve hashed
-- columns, so the chain would faithfully and verifiably attest a cross-tenant
-- author.
CONSTRAINT audit_log_tenant_fkey     FOREIGN KEY (tenant_id)
                                       REFERENCES tenants (id) ON DELETE RESTRICT,
CONSTRAINT audit_log_actor_fkey      FOREIGN KEY (tenant_id, actor_user_id)
                                       REFERENCES users (tenant_id, id) ON DELETE RESTRICT,

-- `ip` is text rather than inet (§4), which removed inet's implicit bound on a
-- column populated from an attacker-influenced header, hashed into the chain,
-- and never deleted. Measured before this CHECK existed: a 100 000-character
-- ip accepted, and 'not-an-ip; DROP' accepted.
--
-- BOTH HALVES ARE NEEDED, and a length bound alone is not the control. An
-- earlier revision had only the length half while citing 'not-an-ip; DROP' as
-- its justification — a value 15 characters long, which that bound accepts.
-- The character class is what rejects it, along with '<script>x</script>' and
-- '%s%s%s%n'. It also rejects uppercase, which enforces §4's normative
-- lowercase rendering rule rather than leaving it to the application.
CONSTRAINT audit_log_ip_bounded      CHECK (ip IS NULL OR (length(ip) BETWEEN 3 AND 45
                                       AND ip ~ '^[0-9a-f:.]+$')),
CONSTRAINT audit_log_not_self        CHECK  (previous_hash IS NULL OR previous_hash <> hash),
CONSTRAINT audit_log_anchor_ties     CHECK  ((seq = 0) = (previous_hash IS NULL)),
CONSTRAINT audit_log_genesis_ties    CHECK  ((seq = 1) = (previous_hash = repeat('0', 64))),
CONSTRAINT audit_log_prev_fkey       FOREIGN KEY (tenant_id, previous_hash)
                                       REFERENCES audit_log (tenant_id, hash) ON DELETE RESTRICT,
```

**Each tenant's chain starts with an ANCHOR row at `seq = 0`**: `previous_hash NULL`, `hash = repeat('0',64)`, `actor_user_id NULL`, a synthetic `action` and `entity_type`. It is a chain anchor, not a hashed record — §6's verifier starts at `seq 1` and continues to treat the 64 zeros as the genesis constant.

**The anchor's lifecycle is normative, because it is a hard precondition of `seq` allocation and an earlier draft left it unstated.** Measured on a tenant with no anchor: `SELECT max(seq)+1 …` returns `NULL` and the append fails on `NOT NULL` with an error that names nothing about the cause.

- **Who writes it.** Tenant provisioning, in the same transaction that inserts the `tenants` row — the [ADR-0013](ADR-0013-kysely-and-sql-migrations.md) `withGlobal` case. Migration 007 backfills one for every tenant that already exists.
- **Under which lock.** **The per-tenant advisory lock of this section**, taken before the anchor insert. Without it two concurrent first-appends race to create the anchor and one fails on `audit_log_tenant_seq_key`. This is [ADR-0018](ADR-0018-stock-state-scopes-and-locking.md) §3's lesson — *a row that does not exist cannot be locked* — arriving at the audit chain; the advisory lock closes it precisely because it is keyed on the tenant rather than on a row.
- **Under which `app.tenant_id`.** The policy's `WITH CHECK` requires it set to the tenant being provisioned, which is not yet committed. Provisioning therefore sets it explicitly for the anchor insert; this is the one write that is ordered *before* the tenant is generally visible.
- **Is the anchor itself audited?** No. It is not a hashed record and represents no actor's action; auditing it would require a chain that does not yet exist.

Migration 007's backfill holds the migration lock (position 1) and then the terminal lock, which [LOCK_REGISTRY](../LOCK_REGISTRY.md) records — safe, because no posting transaction ever wants the migration lock, so that edge cannot close into a cycle.

plus a `BEFORE INSERT` trigger asserting the link is to the immediately preceding row.

**THE PARENT ROW IS READ `FOR SHARE`, AND THAT IS NOT OPTIONAL.** An earlier
draft read it unlocked, and the Database Guardian reproduced the same defect
W1-001 found in `database/migrations/005_create_sessions.sql:114-131` — which is
now the doctrine for this whole class, and is cited here so the next trigger
author inherits it rather than rediscovering it:

```
T_A  BEGIN; INSERT seq 3, previous_hash = <seq 2's hash>
     -> trigger reads seq 2, passes, takes NO lock on it
T_B  UPDATE audit_log SET seq = 99 WHERE seq = 2;   -> UPDATE 1, did not block
T_A  COMMIT

committed state:  seq 0, 1, 3, 99
```

Three things the ADR claims to prevent, all reachable: **a false gap at `seq` 2**,
which §6 defines as evidence of a deleted row — a false tamper alert with no
deletion; row 3's `previous_hash` naming the hash of a row now sitting at
`seq` 99, so the invariant the trigger asserted is **false in the committed
state, with the trigger enabled and having passed**; and a reordered pair the
trigger permitted.

**Neither other mechanism covers it.** The advisory lock serialises *appenders*,
and T_B is not an appender — it takes no advisory lock, so there is no
interaction at all. The foreign key does not help either, for the reason 005's
header already documents: RI checks take `FOR KEY SHARE` on the parent, the
referenced key is `(tenant_id, hash)`, and `seq` is not in it — so a `seq`
rewrite is not a key update and the FK's lock does not conflict with it. The FK
is real protection against `DELETE` and against a `hash` rewrite, both measured,
and none against this.

With `FOR SHARE`, the same interleaving serialises: T_B waited 4.04 s and
committed after T_A. Measured.

**This trigger's assertion is snapshot-scoped; its DURABILITY comes from
`audit_log` being append-only** — `UPDATE` revoked from `finsoft_app` plus the
append-only trigger in Compliance. An earlier draft presented the linkage
trigger (§5) and the append-only posture (Compliance) as separate concerns in
separate sections, so an author weakening one would not know they had broken the
other. They are one mechanism. The repro above is owner-only in the intended
deployment — but §5 reasons explicitly and at length about the
owner/trigger-disabled regime, and in that regime this is live.

```sql
IF NEW.seq > 1 AND NOT EXISTS (
  SELECT 1 FROM audit_log
   WHERE tenant_id = NEW.tenant_id AND seq = NEW.seq - 1 AND hash = NEW.previous_hash
   FOR SHARE
) THEN RAISE EXCEPTION 'audit_log: previous_hash does not match the hash at seq %', NEW.seq - 1;
```

**`UNIQUE (tenant_id, previous_hash)` is now derivable from the other four constraints plus the trigger — and it stays, for a better reason than the one first given.** It is the single constraint that still holds if the trigger is disabled, which makes it the last declarative line against a forked chain rather than a redundant one. A future author reading it as duplicated by the linkage trigger would be removing exactly the control that survives the trigger's removal.

**`UNIQUE` does not constrain NULLs** — three `(tenant, NULL)` rows insert happily — so the nullable `previous_hash` the anchor requires cannot be bounded by the prev-hash index. It is bounded by `seq` instead; see below.

**BOTH the foreign key and the trigger. They are not alternatives and the first version of this section was wrong to treat them as such.**

They answer different questions. The FK gives *every row has a parent*; the trigger gives *the parent is the row at `seq − 1`*, which an FK cannot express. Each is a few lines.

The first version chose the trigger alone and gave two reasons, **both of which were wrong**:

- *"The anchor row needs a `created_by`, and 002 rejected a per-tenant system user."* Void by this ADR's own Compliance section: `audit_log` is exempt from the §11 mandatory column set, so it carries no `created_by` and there is no authorship problem to import. The objection was against a column set this revision removes.
- *"Adds no new class of weakness."* **False, and measured.** FK enforcement runs on *system* triggers, and a non-superuser owner cannot disable them:

```
ALTER TABLE audit_log DISABLE TRIGGER audit_log_link;  →  ALTER TABLE   (succeeds)
ALTER TABLE audit_log DISABLE TRIGGER ALL;             →  ERROR: permission denied:
                                                          "RI_ConstraintTrigger_c_…" is a system trigger
SET session_replication_role = replica;                →  ERROR: permission denied
```

So an owner can defeat the plpgsql trigger but **not** the FK. It can only `DROP CONSTRAINT`, which changes the catalog and therefore fails `schema.spec.ts` and the codegen diff — whereas a disabled trigger changes nothing but `pg_trigger.tgenabled`, which a CI-only assertion never sees on the cluster where someone disabled it.

And with the trigger disabled, **the orphan is the one forgery that becomes reachable** — every other is still caught by a constraint. It is precisely the case the linkage mechanism uniquely covers. With the FK present it is rejected anyway, measured: `violates foreign key constraint "audit_log_prev_fkey"`.

The nullable `previous_hash` the anchor reintroduces is **bounded to exactly one row per tenant by `UNIQUE (tenant_id, seq)`** — not by the prev-hash index, which does not constrain NULLs. That is where the "NOT NULL is load-bearing" argument goes: the bound comes from `seq`, not from the nullability.

**The residual control against the owner was never schema-level and was never meant to be: it is the chain itself.** An owner who drops every constraint and inserts a forgery still cannot make the hashes link, and `audit:verify` running as `readonly_support` names the first break by `seq`. **Constraints stop accidents; the hash catches intent.**

**Which control catches what, by regime.** `BEFORE` row triggers do run before `CHECK` constraints, so the trigger wins every race it *enters* — but an earlier version of this table over-read that into "the trigger catches everything". **The trigger checks LINKAGE ONLY, so it does not enter the duplicate-hash or self-link races at all**; those are caught by the constraint in both regimes, measured. The correction runs in the direction of keeping the constraints: `audit_log_tenant_hash_key` and `audit_log_not_self` are live controls with the trigger enabled, not fallbacks for a disabled one.

| forgery | trigger enabled | trigger disabled |
|---|---|---|
| fork (two children of one parent) | trigger | `audit_log_tenant_prev_key` |
| duplicate `hash` | **`audit_log_tenant_hash_key`** | `audit_log_tenant_hash_key` |
| self-link | **`audit_log_not_self`** | `audit_log_not_self` |
| second genesis | `audit_log_tenant_seq_key` | same |
| **orphan** | trigger | **`audit_log_prev_fkey`** |

Measured with exactly this scheme: the orphan is rejected with `previous_hash does not match the hash at seq 499`, the duplicate hash by `audit_log_tenant_hash_key`, the self-link by `audit_log_not_self`, a second genesis by `audit_log_tenant_seq_key`, and a legitimate append succeeds.

#### `seq` allocation

**Transactional, gapless, from 1, allocated under the lock, and explicitly NOT a PostgreSQL sequence.**

**GAP-FREEDOM DOES NOT COME FROM THE LOCK, and an earlier revision implied it did.** Measured three ways: two appenders with the lock omitted → `audit_log_tenant_seq_key` fires on one, the chain is `0,1,2`, no gap; three appenders with the lock → `0,1,2,3,4,5`, correctly chained; an append that allocates and then rolls back → head unchanged, no gap. Gap-freedom follows from four facts, and the lock is none of them: `MAX` reads only committed rows; no row is ever deleted; **`seq` is never updated**; `UNIQUE (tenant_id, seq)`.

The lock is a **liveness and throughput** device — it converts a `23505` retry storm into an ordered queue. Saying so matters because the third of those four facts is exactly what the `FOR SHARE` defect above breaks, and wording that hides the dependency behind the lock hides the dependency that actually fails.

`MAX(seq) + 1` for the tenant, read under the advisory lock.

**Rule 12 does not reach this, and this ADR does not except it from rule 12.** Rule 12 governs *document numbers* — "generated server/database-side, never client-side" — and `seq` is neither a document number nor client-generated. A locked per-tenant counter satisfies rule 12's actual requirement in any case. The first version of this paragraph called itself "a narrow exception to rule 12", which would have been a LEVEL 1 record asserting authority over a LEVEL 0 one, and would have needed the Accounting Guardian's signature that this block does not carry.

Why not a sequence: **§6 treats a `seq` gap as evidence of a deleted row**, so a sequence would manufacture a false tamper alert on every ordinary rollback.

#### Concurrency, and the isolation level it depends on

```sql
SELECT pg_advisory_xact_lock(
  ( ('x' || substr(replace(tenant_id::text, '-', ''),  1, 16))::bit(64)::bigint
  # ('x' || substr(replace(tenant_id::text, '-', ''), 17, 16))::bit(64)::bigint )
);
```

**The one-argument form, keyed on the tenant's own bits** — not `(4919, hashtext(tenant_id::text))`. `hashtext` is an undocumented internal function with no stability contract, and its `int4` output collides: 199 997 distinct in 200 000 random uuids, measured. A collision puts tenant A's posting behind tenant B's long import until `lock_timeout` fires — an availability coupling across a tenant boundary, in the posting path, in a multi-tenant ERP.

**Both halves are XORed, and that is not decoration.** Reading only the first 64 bits works in production, where `001_create_tenants.sql` mints tenants with `gen_random_uuid()`, but it collapses on exactly the fixtures a cross-tenant test would use:

```
00000000-0000-4000-8000-000000000001   first 64 bits →  16384
00000000-0000-4000-8000-000000000002   first 64 bits →  16384
00000000-0000-4000-8000-000000000003   first 64 bits →  16384

                                       folded        →  …759423 / …759422 / …759421
```

That would reintroduce the coupling `hashtext` was dropped to avoid, in the one place Compliance mandates testing for it — and would let the omitted-lock test variant pass for the wrong reason. Folded: 200 000 distinct in 200 000.

**What dropping `4919` actually costs is less than it sounds.** PostgreSQL's one- and two-argument advisory spaces are provably disjoint — `pg_locks.objsubid` is **1 for the one-argument form and 2 for the two-argument form** — re-measured on PostgreSQL 17.10, labelled by `classid` so the rows cannot be confused; an earlier revision stated this backwards while calling it measured — so no future two-argument claimant can collide with this chain at all. That is a stronger separation than an unenforced namespace convention gave.

**The scheme depends on READ COMMITTED, and the first version never said so.** Measured, same harness, only the isolation level changed:

```
READ COMMITTED    T2 blocks on the lock, T1 commits, T2 re-reads the head, links → seq 2
REPEATABLE READ   T2 acquires the lock instantly, reads the head through its OLD snapshot,
                  sees nothing → ERROR: duplicate key … (tenant_id, seq)=(…, 1)
```

It fails closed, which is the right direction. [ARCHITECTURE §7](../ARCHITECTURE.md), line 302, fixes READ COMMITTED system-wide, so this is not live today — but a future ADR raising isolation on the posting path would turn every concurrent append into a posting error, and nothing would have warned them.

That divergence is also the proof that the constraints are **not** redundant with the lock: under REPEATABLE READ the lock granted instantly and the unique constraint was the only thing standing between that transaction and a duplicate.

#### Lock placement is normative, not an implementation detail

`pg_advisory_xact_lock` cannot be released before COMMIT, so hold time is everything from acquisition to commit.

> **The audit appendS are the LAST writes before commit. The lock is acquired at the first of them. No external call — HTTP, SMTP, queue — happens while it is held. A `lock_timeout` is intended to bound the queue so contention surfaces as a bounded error rather than an unbounded stall.**
>
> **`lock_timeout` IS NOT SET IN THIS REPOSITORY TODAY**, so that last sentence states a protection no mechanism provides — the defect class this section corrects twice elsewhere, appearing once more inside it. The only bound in force is `statement_timeout = 15_000` ms (`packages/database/src/pool.ts:222`), roughly nineteen times the 800 ms P95 posting budget and sized for slow queries rather than lock waits. Recorded as [TECH_DEBT](../TECH_DEBT.md) TD-001, which is a merge condition on migration 007: either the value is named and set, or this sentence is withdrawn.
>
> **Two appends in one transaction are permitted and chain correctly.** `pg_advisory_xact_lock` is re-entrant within a transaction, and `MAX(seq)` sees the transaction's own uncommitted row — measured, head `2` before the first append and `3` after it, from inside the same transaction. An earlier singular wording made a correct implementation look like a violation.
>
> **This advisory lock is TERMINAL in the global acquisition order — position 6 in [LOCK_REGISTRY](../LOCK_REGISTRY.md), which publishes that order. Nothing may be acquired after it**, with three named exceptions: the implicit `KEY SHARE` row locks the audit row's own foreign keys take on `tenants`, `users` and **`audit_log`** itself.
>
> The third was missing from an earlier revision, which said "one named exception" while this section's own schema creates three. `audit_log_prev_fkey` is self-referential, so every append takes `KEY SHARE` on the tenant's previous audit row. It is harmless — same tenant, already serialised by this lock, and the parent can never be modified on an append-only table — but a normative sentence that omits a lock the ADR itself creates is the class of error this section corrects twice elsewhere.

#### The divergence from ADR-0018 §6, stated rather than denied

[ADR-0018](ADR-0018-stock-state-scopes-and-locking.md) §6 says: *"**No lock is acquired after the first write.** All locking happens in the ordered acquisition phase, before any row is modified. A write-then-lock sequence reintroduces the ordering problem the sort in §4(a) exists to solve."*

Acquire-last **is** write-then-lock. That is a direct divergence, and an earlier draft of this ADR asserted "no conflict" while answering a different ADR-0018 objection entirely.

The reconciliation, which the Architecture Guardian must rule on rather than this record assuming:

- ADR-0018 §6 guards against **deadlock from unordered acquisition**. A lock that is *always last and never followed* cannot participate in a cycle, because a cycle requires the holder to wait on something.
- The locks acquired after it are FK `KEY SHARE` locks, and **`KEY SHARE` does not conflict with `FOR NO KEY UPDATE`** — measured: a `KEY SHARE` reader acquired immediately while a `FOR NO KEY UPDATE` holder sat on the row for two seconds. So an ordinary `UPDATE tenants SET name = …` or `UPDATE users SET last_login_at = …` never waits, and the routine case has no edge at all. An earlier revision said a cycle needs "an exclusive lock on that same `tenants` row", which both understated the safety and named the wrong table.
- The reachable cycle needs an explicit `SELECT … FOR UPDATE`, a key-column update, or a `DELETE` on the same row, followed by an audit append in that transaction. `DELETE` is forbidden by rule 2. What remains is **an admin path taking `FOR UPDATE` on a `users` row and then audit-appending, racing that user's own posting.** Reachable, on `users` rather than `tenants`, and it aborts one transaction: **availability, not corruption.**
- ADR-0018 is `Proposed`, not Accepted, so nothing binds today. That is a reason to resolve the divergence before it is accepted, not a reason to leave it unstated.

**Also diverges from [ARCHITECTURE](../ARCHITECTURE.md):302**, which sanctions *"an advisory lock keyed by `(tenant_id, entity)`"* — the two-part shape this ADR abandons. The one-argument form is the right call for the reasons measured above, and a LEVEL 1 record departing from ARCHITECTURE's stated shape should say so plainly rather than let a deferred registry imply it.

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

Detects, each with a test that plants exactly this: an altered field; a **missing or renumbered** row (`seq` gap, and the successor links to nothing); a reordered pair; an appended forgery. A gap is *not* evidence of a deletion specifically — a `seq` rewrite produces an identical gap with nothing deleted, which is what the unlocked-read defect above produced: `0, 1, 3, 99`.

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

**Self-referencing FK plus an anchor row, INSTEAD OF the linkage trigger — and this entry is kept only to record that it was got wrong.** An earlier revision rejected it "because the anchor row needs an authorship that 002 deliberately does not provide". That reason is void: §5 exempts `audit_log` from the mandatory column set, so there is no `created_by` and no authorship problem. **The Decision adopts the FK *and* the anchor *and* the trigger**, because they answer different questions — the FK gives *every row has a parent*, which an owner cannot disable; the trigger gives *the parent is the row at `seq − 1`*, which an FK cannot express. What was genuinely rejected is the FK **instead of** the trigger, and the reason is that it cannot express adjacency.

**`(4919, hashtext(tenant_id))` advisory lock.** Rejected for the cross-tenant contention coupling and `hashtext`'s lack of a stability contract.

**Signing each record.** Stronger against an attacker who controls the database, and rejected for now: it needs a key the application holds, and an attacker with the database usually has the application. Available as a superseding ADR if the threat model changes.

**Merkle tree.** Disproportionate — efficient inclusion proofs for a log nobody queries that way, at the cost of a structure much harder to verify by hand.

**Normalising to NFC.** Rejected in §3: it would hash bytes different from the stored bytes.

---

## Compliance

### Schema facts migration 007 must carry

- `hash_version` `NOT NULL` with `CHECK (hash_version IN ('v1'))`.
- The constraints and the linkage trigger of §5, by name. (No count: §5 now declares eleven, and a prose number that must agree with a list is the consistency obligation `4818d6d` deleted from ADR-0021 for exactly this reason.)
- `hash` `NOT NULL` with `^[0-9a-f]{64}$`. **`previous_hash` is NULLABLE**, with the same shape CHECK. An earlier revision of this bullet required it `NOT NULL`, contradicting §5 — and a migration author following Compliance would have shipped a table no tenant could ever write to: `audit_log_anchor_ties` defines the anchor as `previous_hash IS NULL`, so under `NOT NULL` the anchor insert fails, and with no anchor there is no genesis and `MAX(seq)+1` returns `NULL`. The "NOT NULL is load-bearing" argument was a survival from the pre-anchor draft; §5 retracts it and this bullet had not been updated with it. The one nullable row per tenant is bounded by `UNIQUE (tenant_id, seq)`, not by nullability.
- `UNIQUE (tenant_id, id)` — ADR-0021 §1 grants the surrogate-primary-key exemption *on the footing* that this key carries the tenant-scoped guarantee separately. Every other table in the repository has it.
- Composite foreign keys `(tenant_id, actor_user_id) → users` and `tenant_id → tenants`, both `ON DELETE RESTRICT`.
- `ip` bounded by CHECK. It is `text` rather than `inet` (§4), so the database-side bound `inet` gave for free has to be restored explicitly.
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
- **A two-connection test for the linkage trigger's `FOR SHARE`** — the one that FAILS against an unlocked read. T_A inserts `seq n` while T_B renumbers `seq n-1`; without the lock T_B does not block and the committed chain carries a false gap. This is the test that would have caught the defect, and it cannot be written before migration 007 creates the table, so it is a **merge condition on 007** rather than a test that exists today. Cite `database/migrations/005_create_sessions.sql:114-131` as the doctrine.
- A test asserting both triggers are still enabled (`pg_trigger.tgenabled = 'O'`) **and that every constraint exists and is `convalidated`**. The same owner argument that reaches `DISABLE TRIGGER` reaches `NOT VALID`, so presence alone is not the assertion. **The `tgenabled` assertion needs a production-reachable counterpart**, because a CI-only check runs against a freshly migrated database and never sees the cluster where a trigger was disabled to run a bulk fix.
- **A multi-row single-statement insert is ORDER-DEPENDENT, and an earlier revision asserted only the lucky direction.** Measured: `INSERT … VALUES (seq 3),(seq 4)` → `INSERT 0 2`; the same two rows as `VALUES (seq 4),(seq 3)` → `ERROR: audit_log: previous_hash does not match the hash at seq 3`. The forward case works because a `BEFORE INSERT … FOR EACH ROW` trigger sees rows inserted earlier in the same command — but the property it rests on is **row processing order within a statement**, which PostgreSQL does not contract for an `INSERT … SELECT`. An ORM batching two audit appends in an unlucky order therefore produces a *tamper-worded* exception on a legitimate write. **Required:** either forbid multi-row audit inserts, or require `seq` order explicitly in the writer rules — and test **both** directions, not just the one that passes.
- The verifier runs as `readonly_support`, asserted.

### Deferred, and recorded rather than discovered

- **Partitioning.** Intended key: RANGE on `occurred_at`. Not declared in 007. `UNIQUE (tenant_id, seq)` and the linkage trigger narrow the options **permanently** at 007, so this is the cheapest moment it will ever be — recorded now for that reason.
- **Retention.** Rule 9 says statute, not disk. With `DELETE` granted to nobody the only compatible mechanism is `DETACH PARTITION`, which depends on the above. A detached partition is retained and archived, never dropped.
- **A named domain error at the audit-append boundary** for `jsonb`'s rejection of `U+0000` and lone surrogates, which currently surfaces as an opaque database error aborting a posting transaction.

## Related

- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rule 9, which this implements. **Rule 12 is not reached by `seq`** and is not excepted; see §5
- [../ARCHITECTURE.md](../ARCHITECTURE.md) §9 audit, **§7 line 302** the READ COMMITTED commitment this scheme's liveness rests on, and the advisory-lock line **this ADR amends**, §11 the P95 budget it constrains
- [ADR-0011](ADR-0011-money-representation.md), [ADR-0014](ADR-0014-decimal-js.md) — why money is a fixed-scale string before it arrives
- [ADR-0018](ADR-0018-stock-state-scopes-and-locking.md) — **two separate interactions, and only one of them is a non-conflict.** Its objection to advisory locks for *stock state* does not reach here: that objection is that a lock released on commit never protected the prior row, and here there is no prior row. Its **§6 "no lock is acquired after the first write" directly diverges** from this ADR's acquire-last placement. **RULED by the Architecture Guardian, 2026-09-25: acquire-last stands, and ADR-0018 §6 is the record that must change.** §6 states a kernel-local discipline in whole-transaction language; read literally it forbids every implementable form of rule 9's per-tenant chain, including this ADR's own recorded fallback. Replacement text is held against ADR-0018's acceptance pass, to be applied by its own deciders — **ADR-0018 must not be signed carrying §6 as written.**
- [ADR-0021](ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md) — **§1 is engaged**, by `id uuid PRIMARY KEY` on a tenant-owned table. §2 is not: all three unique constraints here lead with `tenant_id`, so no `GLOBALLY_UNIQUE_INDEX_ALLOWLIST` entry is needed. §1 grants the surrogate-key exemption on the footing of the `UNIQUE (tenant_id, id)` key that §5 now carries.
- [../LOCK_REGISTRY.md](../LOCK_REGISTRY.md) — the global acquisition order this ADR's lock is terminal in, and the second claimant of the one-argument advisory space
- [../TECH_DEBT.md](../TECH_DEBT.md) — TD-001 `lock_timeout` unset, TD-002 the audit lock serialises logins against postings
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — correction by reversal, which is what the chain records
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)

## Signatures

| | |
|---|---|
| **Architecture Guardian** | ✅ **APPROVED WITH CONDITIONS**, 2026-09-25 — round 2's four conditions landed; round 3's ruling on §5 (acquire-last, the `ARCHITECTURE.md:302` amendment and the lock registry) applied |
| **Database Guardian** | ✅ **APPROVED**, 2026-09-25 — three review rounds, every finding re-measured rather than taken on report |
| **Product Owner** | ✅ **SIGNED**, 2026-09-25 |

> Architecture Guardian — canonicalisation, chain integrity and boundary review, 2026-09-25 — accepted on independent reproduction of both golden vectors from the specification alone; conditional on four corrections: READ COMMITTED is ARCHITECTURE §7:302 not §5, the advisory-lock key must fold all 128 tenant bits, apply.ts:72 already claims the one-argument space, and rule 12 is not reached by `seq` rather than excepted for it.

### Round 3 — what the third pass found, and it was not in the canonicalisation

**§1–§4 were approved on independent reproduction.** Both guardians regenerated the golden vectors from the specification alone, one with the input record's keys deliberately shuffled, and got `38e6aa16…`, `bc41ce06…` and the rejected 13-column reading `50855dd5…`. The part that has to be right forever is right.

**Everything else was in §5's mechanism, and the blocking finding was the one W1-001 had already taught.** The linkage trigger read its parent row without a lock, so a concurrent `seq` rewrite slipped past a trigger that had already passed — committed state `0, 1, 3, 99`, which is a **false gap** and therefore, under §6, a false tamper alert with nothing deleted. Neither of the other two mechanisms covered it: the advisory lock serialises *appenders* and the mutator is not one; the foreign key's `KEY SHARE` does not conflict, because `seq` is not in the referenced `(tenant_id, hash)` key. `FOR SHARE` closes it, re-measured at a 4.0 s serialised wait against the form as finally written — a locking clause inside `NOT EXISTS` being exactly the kind of thing that parses and locks nothing.

This is the third time in this repository that a document claimed a protection its mechanism did not provide: migration 004 draft 2, migration 005 draft 1, and §5 here. The rule drawn from it, now doctrine at `005:114-131`: **any row a trigger reads other than its own must be read `FOR SHARE`** — and this ADR additionally records that the trigger's assertion is snapshot-scoped, with its durability coming from `audit_log` being append-only, so the two are one mechanism rather than two sections.

Two further corrections worth naming because both were stated as *measured* and were wrong: `pg_locks.objsubid` had the one- and two-argument forms inverted, and `audit_log_ip_bounded` bounded length only while citing `'not-an-ip; DROP'` — a fifteen-character value that the length bound accepts — as its justification.

**Round 2's four conditions landed**, each measured rather than asserted: the citation corrected to §7 line 302; the key folded and verified to separate the structured fixtures that collapsed to `16384` and to give 200 000 distinct in 200 000; `apply.ts:72` named as the prior claimant with the registry moved from "owed before the second claimant" to owed now; and the rule 12 wording withdrawn, since an ADR cannot except a LEVEL 0 rule and this one does not need to.

> Database Guardian — 2026-09-25 — approved for ADR-0020 as it stands, and for the schema facts migration 007 must carry. §1–§4 on independent reproduction of both golden vectors and the rejected 13-column reading from the specification alone, with the input keys shuffled; §5 on measurement — five forgeries rejected as `finsoft_app` under `FORCE` RLS, and the `FOR SHARE` read re-measured **against the form as finally written** at a 4.0 s serialised wait, because a locking clause inside `NOT EXISTS` is exactly the kind of thing that parses and locks nothing.

> Product Owner — 2026-09-25 — "adr 0020 is signed from my side". Accepted on both guardian signatures above: independent reproduction of the golden vectors from the specification alone, and measurement of the chain-integrity mechanism against forgery.

### Three conditions carried to migration 007

**Signing this ADR is not signing 007.** The Database Guardian holds:

1. **The two-connection `FOR SHARE` test must go RED against an unlocked read before it counts.** Same standard as migration 005's grant defect injection, where six named tests had to fail before the control counted. A test that passes against both forms is testing nothing.
2. **[TD-001](../TECH_DEBT.md) resolved either way** — `lock_timeout` named and set, or §5's sentence withdrawn. Not carried forward a third time.
3. **Multi-row audit inserts** — forbidden outright, or `seq` order pinned in the writer rules with **both** directions tested.

And the partitioning decision narrows permanently at 007, so it is made there rather than inherited: `occurred_at` is application-supplied by §4's writer rule 2, so the intended RANGE key is neither client-independent nor monotonic with `seq`; and `DETACH PARTITION` — the only retention mechanism the deferral leaves open — manufactures exactly the `seq`-gap signal §6 teaches operators to read as tampering.

Migration 007 does not merge before all three signatures.
