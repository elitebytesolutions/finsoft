-- 009_create_audit_log.sql
--
-- The audit hash chain. NON_NEGOTIABLES rule 9, ARCHITECTURE §9,
-- ADR-0020 (canonicalisation and chain integrity).
--
-- Numbering: ADR-0020's own text says "007". That number was double-booked
-- across three unmerged branches (Product Owner ruling, 2026-09-26): 006 and
-- 007 went to the auth lane's resolver and users-regrant, 008 to RBAC, and
-- this table to 009. ADR-0020 is amended by a head notice rather than this
-- file being bent to match stale prose — a numbered migration is the
-- expensive place to have a conflict, not the ADR text.
--
-- The deliverable is the VERIFIER, not this table (WAVE_1_REGISTER W1-005). A
-- chain nobody recomputes is a column called `hash`. This file only has to be
-- right enough that the verifier in packages/database/src/audit/ can recompute
-- every hash from the columns below and get the bytes ADR-0020 §4 specifies.
--
-- ---------------------------------------------------------------------------
-- What this table is NOT
--
-- It is not a place modules construct journal lines or stock movements — the
-- kernels own those. It is not application logging (ARCHITECTURE §9: "on its
-- own tables, separate from application logging"). And it carries none of the
-- IMPLEMENTATION §11 mandatory columns: no created_at/created_by/updated_at/
-- updated_by/version. ADR-0020 Compliance is explicit that this is a named
-- exemption, not an omission — occurred_at and actor_user_id already carry
-- when/by-whom as HASHED columns, so created_at/created_by would duplicate
-- them unhashed; and updated_at/updated_by/version describe an UPDATE this
-- table can never have. The exemption is named in
-- database/tests/schema.spec.ts (MANDATORY_COLUMN_SET_ALLOWLIST) rather than
-- left for a migration author to discover by omission.
--
-- ---------------------------------------------------------------------------
-- The anchor row, and why it exists
--
-- Each tenant's chain starts with a synthetic row at seq = 0: previous_hash
-- NULL, hash = 64 zeros, actor_user_id NULL. It is a chain anchor, not a
-- hashed record (ADR-0020 §5) — the verifier starts at seq 1 and treats the
-- 64-zero hash as the genesis constant. Without it, MAX(seq)+1 for a
-- brand-new tenant returns NULL and the first real append fails on a NOT NULL
-- violation naming nothing about the cause; and audit_log_prev_fkey has
-- nothing for seq 1's previous_hash (= 64 zeros) to reference.
--
-- No production tenant-provisioning code exists yet in this repository — 001
-- created the `tenants` table and nothing yet inserts into it outside a test
-- fixture. So there are two places an anchor must be created, and this
-- migration only reaches one of them:
--
--   1. EXISTING tenants, backfilled below, in this file, under the per-tenant
--      terminal advisory lock ADR-0020 §5 specifies (empty on a fresh
--      cluster; not vacuous once a tenant exists ahead of this migration).
--   2. FUTURE tenants, created after this migration by whatever provisioning
--      code a later wave builds. That code does not exist yet, so it cannot
--      be relied on here. `packages/database/src/testing/harness.ts`'s
--      `createTenantFixture` — the ONLY thing in this codebase that creates a
--      tenant today — is updated in this change to call the same
--      `createAuditChainAnchor` helper this migration's backfill uses, so
--      every fixture tenant used by every test suite in this repository has
--      a valid chain from the moment it exists. Flagged for whoever builds
--      real tenant provisioning: call `createAuditChainAnchor` (or
--      equivalent raw SQL, see packages/database/src/audit/anchor.ts) in the
--      SAME transaction as the `tenants` insert, before the tenant is
--      generally visible, exactly as ADR-0020 §5 requires.
--
-- ---------------------------------------------------------------------------
-- Lock footprint
--
-- CREATE TABLE locks nothing that already exists except the two foreign keys:
-- SHARE ROW EXCLUSIVE on `tenants` and on `users` for the duration of the
-- transaction. Both are near-empty at this point in the project's life.
--
-- The backfill DO block at the foot of this file additionally takes, per
-- existing tenant: the position-6 terminal advisory lock ADR-0020 §5 and
-- LOCK_REGISTRY.md define (`pg_advisory_xact_lock` on the folded tenant id).
-- Migration 009 runs under finsoft_migration, which already holds
-- LOCK_REGISTRY position 1 (the migration-runner lock) for the whole apply —
-- so this transaction holds position 1 and then position 6. That ordering is
-- named as safe in LOCK_REGISTRY.md's "one ordering fact that existed only in
-- someone's head": no posting transaction ever wants the migration lock, so
-- the edge cannot close into a cycle. On a fresh cluster `tenants` is empty
-- and the backfill loop runs zero times.
--
-- How this is reversed: it is not, in place (ADR-0013, forward-only).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The no-numbers/no-booleans rule, enforced in the schema
--
-- ADR-0020 §2: "no JSON numbers and no JSON booleans. Every leaf is a string
-- or null." This is a correctness requirement, not a style rule (§2 reason
-- 3): the hash is computed by the application BEFORE insert and recomputed by
-- the verifier AFTER reading back through jsonb, and a JSON number admitted at
-- either end makes that round trip lossy — "one stray number produces a row
-- that can never be verified again."
--
-- A single IMMUTABLE jsonpath expression, not a user-defined recursive
-- plpgsql function — Database Guardian review round 1 rejected the function
-- form on measurement: it called itself unqualified with no search_path
-- pinned, and `pg_dump` sets an EMPTY search_path during restore, so
-- `pg_restore` on a real dump of this table failed outright —
-- "function audit_log_jsonb_all_strings(jsonb) does not exist" — and restored
-- zero rows. `$.** ? (...)` walks every value at every nesting level in one
-- expression, so there is no recursive call, no function, and no
-- search_path for a restore to get wrong. `jsonb_path_exists` is IMMUTABLE
-- (pg_proc.provolatile = 'i'), which a CHECK constraint requires.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL,

  -- Gapless, from 1, allocated by the application under the terminal advisory
  -- lock (ADR-0020 §5). Deliberately NOT a PostgreSQL sequence: §6 treats a
  -- seq gap as evidence of a deleted row, so a sequence would manufacture a
  -- false tamper alert on every ordinary rollback. 0 is reserved for the
  -- per-tenant anchor.
  seq            bigint      NOT NULL CHECK (seq >= 0),

  -- Application-generated, never a database DEFAULT now() (ADR-0020 §4 writer
  -- rule 2): the writer cannot hash a value the database has not produced
  -- yet, and it must construct the six-fractional-digit form itself —
  -- Date.prototype.toISOString() yields three.
  occurred_at    timestamptz NOT NULL,

  -- Nullable: job- and system-originated events have no acting user, and a
  -- NOT NULL here would force a fabricated value hashed into a chain whose
  -- purpose is that its contents are trustworthy.
  actor_user_id  uuid,

  action         text        NOT NULL,
  entity_type    text        NOT NULL,
  entity_id      uuid,

  -- Embedded and hashed as OBJECTS via the JCS pass, not as pre-serialised
  -- strings (ADR-0020 §4).
  before_json    jsonb,
  after_json     jsonb,

  -- `text`, not `inet`, deliberately (ADR-0020 §4). `inet` renders with a
  -- /32 or /128 prefix and abbreviates IPv6 — normalisation the schema would
  -- then own silently, on the one column most exposed to disagreeing between
  -- writer and verifier. `text` stores exactly what was hashed; the
  -- application is what must render addresses normatively (lowercase, RFC
  -- 5952 IPv6 compression, dotted-quad IPv4-mapped forms) before hashing.
  -- Nullable for the same reason as actor_user_id: a job has no client
  -- address, and NOT NULL would force a fabricated one.
  ip             text,
  request_id     uuid,

  -- The format is versioned and the version is inside the hash (ADR-0020
  -- §1). A future ADR may define v2; v1 rows stay verifiable under v1 rules
  -- forever, and the verifier selects its algorithm from the row rather than
  -- from the calendar. Adding a column to this table requires a new
  -- hash_version — the record membership hashed is the closed twelve-column
  -- list in ADR-0020 §4, not "whatever columns exist".
  hash_version   text        NOT NULL CHECK (hash_version IN ('v1')),

  -- hex(SHA-256(previous_hash_ascii || 0x1F || version_ascii || 0x1F ||
  -- jcs_utf8)) — ADR-0020 §4, byte for byte. Computed by the application
  -- before insert; never by a trigger or a generated column, because nothing
  -- in SQL can produce RFC 8785 JCS bytes.
  hash           text        NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),

  -- NULLABLE only for the anchor row (seq = 0). Every other row's
  -- previous_hash is the parent's hash, enforced adjacent-to-seq-1 by
  -- audit_log_genesis_ties and adjacent-to-every-later-row by the
  -- audit_log_link trigger below.
  previous_hash  text        CHECK (previous_hash ~ '^[0-9a-f]{64}$'),

  -- ADR-0020 §4: action is uppercase snake case like outbox.topic; entity_type
  -- is lowercase snake case like the domain entity names it names.
  CONSTRAINT audit_log_action_shape
    CHECK (action ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$' AND length(action) BETWEEN 3 AND 64),
  CONSTRAINT audit_log_entity_type_shape
    CHECK (entity_type ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(entity_type) BETWEEN 2 AND 64),

  -- NOT NULL alone admits a bare scalar or an array; before/after describe a
  -- RECORD, and ADR-0020 §4 says the twelve-column record — including these
  -- two — is embedded as objects.
  CONSTRAINT audit_log_before_json_is_object
    CHECK (before_json IS NULL OR jsonb_typeof(before_json) = 'object'),
  CONSTRAINT audit_log_after_json_is_object
    CHECK (after_json IS NULL OR jsonb_typeof(after_json) = 'object'),

  -- The correctness rule, as a schema fact rather than a writer convention
  -- (ADR-0020 §2 reason 3 and Compliance). `$.**` walks every value at every
  -- nesting level; the predicate matches a JSON number or boolean anywhere,
  -- and `strict` makes the path raise rather than silently match nothing on
  -- an unexpected shape. See the header comment above this table for why
  -- this replaced a recursive plpgsql function.
  CONSTRAINT audit_log_before_json_no_numbers
    CHECK (before_json IS NULL OR NOT jsonb_path_exists(
      before_json, 'strict $.** ? (@.type() == "number" || @.type() == "boolean")')),
  CONSTRAINT audit_log_after_json_no_numbers
    CHECK (after_json IS NULL OR NOT jsonb_path_exists(
      after_json, 'strict $.** ? (@.type() == "number" || @.type() == "boolean")')),

  -- These rows are never deleted (rule 4, and this table grants no DELETE at
  -- all), so an unbounded before/after image is unbounded forever, in every
  -- backup. 8 KiB is a starting budget for a before/after image of a single
  -- record's changed fields, not a byte-for-byte document store — flagged for
  -- the Database Guardian as a value decision ADR-0020 does not itself state
  -- a number for, same footing as outbox's 4 KiB payload bound in 004.
  --
  -- `octet_length`, not `length`: `length()` on the text extracted by
  -- `#>> '{}'` counts CHARACTERS, and a CJK-heavy before/after image can be
  -- three times as many BYTES as characters — measured: 3,000 CJK characters
  -- is 3,012 characters but 9,012 bytes, and `length() <= 8192` accepted it.
  -- `octet_length` counts what is actually stored and backed up.
  -- `#>> '{}'` is IMMUTABLE, which a CHECK requires; `::text` and
  -- `pg_column_size` are not guaranteed to be.
  CONSTRAINT audit_log_before_json_bounded
    CHECK (before_json IS NULL OR octet_length(before_json #>> '{}') <= 8192),
  CONSTRAINT audit_log_after_json_bounded
    CHECK (after_json IS NULL OR octet_length(after_json #>> '{}') <= 8192),

  -- ADR-0020 §5, measured: bounded on BOTH length and character class. A
  -- length bound alone accepts 'not-an-ip; DROP' (15 characters); the
  -- character class is what rejects it, and '<script>x</script>', and
  -- '%s%s%s%n'. It also rejects uppercase, enforcing §4's normative lowercase
  -- rendering rule rather than leaving it to the application alone.
  CONSTRAINT audit_log_ip_bounded
    CHECK (ip IS NULL OR (length(ip) BETWEEN 3 AND 45 AND ip ~ '^[0-9a-f:.]+$')),

  -- Chain integrity, ADR-0020 §5. Each is a few lines and none is redundant
  -- with the linkage trigger below — see the trigger's own comment for which
  -- forgery each one catches when the trigger is disabled.
  CONSTRAINT audit_log_not_self
    CHECK (previous_hash IS NULL OR previous_hash <> hash),
  CONSTRAINT audit_log_anchor_ties
    CHECK ((seq = 0) = (previous_hash IS NULL)),
  CONSTRAINT audit_log_genesis_ties
    CHECK ((seq = 1) = (previous_hash = repeat('0', 64))),

  -- ADR-0021 §1: the surrogate-key exemption is granted on the footing of
  -- this composite key, which carries the tenant-scoped guarantee separately.
  CONSTRAINT audit_log_tenant_id_id_key UNIQUE (tenant_id, id),

  CONSTRAINT audit_log_tenant_seq_key  UNIQUE (tenant_id, seq),
  CONSTRAINT audit_log_tenant_hash_key UNIQUE (tenant_id, hash),

  -- Guarantees at most one child per parent hash. Derivable from the linkage
  -- trigger plus the other constraints here, and kept anyway: it is the one
  -- declarative control against a forked chain that still holds if the
  -- trigger is disabled (ADR-0020 §5). UNIQUE does not constrain NULLs, so
  -- this does not bound the anchor's NULL previous_hash — that is bounded by
  -- audit_log_tenant_seq_key instead (at most one row per tenant at seq 0).
  CONSTRAINT audit_log_tenant_prev_key UNIQUE (tenant_id, previous_hash),

  CONSTRAINT audit_log_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE RESTRICT,

  -- COMPOSITE, like every other table in this repository (ADR-0003). A
  -- single-column REFERENCES users(id) is checked with row security OFF and
  -- would accept an audit row in one tenant naming a user owned by another —
  -- worse here than anywhere else, because actor_user_id is one of the
  -- twelve hashed columns: the chain would faithfully and verifiably attest a
  -- cross-tenant author. MATCH SIMPLE (Postgres' default) means a NULL
  -- actor_user_id is not checked at all, which is exactly the job-originated
  -- case this column is nullable for.
  CONSTRAINT audit_log_actor_fkey FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES users (tenant_id, id) ON DELETE RESTRICT,

  -- The FK gives "every row has a parent"; it cannot express "the parent is
  -- the row at seq - 1" — that is the linkage trigger's job. Together they
  -- are what ADR-0020 §5 calls "not alternatives": the FK is what an owner
  -- with the trigger disabled still cannot defeat (system FK triggers cannot
  -- be disabled by a non-superuser owner; a plpgsql trigger can).
  CONSTRAINT audit_log_prev_fkey FOREIGN KEY (tenant_id, previous_hash)
    REFERENCES audit_log (tenant_id, hash) ON DELETE RESTRICT
);

COMMENT ON TABLE audit_log IS
  'ADR-0020, NON_NEGOTIABLES rule 9. Append-only, hash-chained per tenant. Exempt from the IMPLEMENTATION §11 mandatory column set (database/tests/schema.spec.ts MANDATORY_COLUMN_SET_ALLOWLIST) — occurred_at/actor_user_id already carry when/by-whom as hashed columns, and this table has no UPDATE to record.';
COMMENT ON COLUMN audit_log.seq IS
  'Gapless per tenant, from 1, allocated by the application under the terminal advisory lock (LOCK_REGISTRY.md position 6). Never a PostgreSQL sequence: a seq gap is what the verifier reads as evidence of tampering, and a sequence would manufacture that on every rollback. 0 is the per-tenant anchor.';
COMMENT ON COLUMN audit_log.occurred_at IS
  'Application-generated, never DEFAULT now(). Formatted to exactly six fractional digits before hashing (ADR-0020 §4) — Date.prototype.toISOString() yields three.';
COMMENT ON COLUMN audit_log.ip IS
  'text, not inet (ADR-0020 §4): inet renders with a /32 or /128 prefix and abbreviates IPv6, which would put an unstated normalisation rule between the writer and the verifier. The application renders addresses normatively (lowercase, RFC 5952) before hashing; this column stores exactly that.';
COMMENT ON COLUMN audit_log.hash_version IS
  'The canonicalisation scheme that produced hash, hashed as part of its own input. A future v2 does not invalidate v1 rows; the verifier reads this column rather than the calendar.';
COMMENT ON COLUMN audit_log.hash IS
  'hex(SHA-256(previous_hash || 0x1F || hash_version || 0x1F || JCS(record))) — ADR-0020 §4. Computed by the application before insert.';
COMMENT ON COLUMN audit_log.previous_hash IS
  'The parent row''s hash. NULL only for the seq=0 anchor. 64 zeros for the row at seq=1 (audit_log_genesis_ties).';

-- ---------------------------------------------------------------------------
-- Chain linkage: the parent is the row at seq - 1
--
-- THE PARENT ROW IS READ FOR SHARE, AND THAT IS NOT OPTIONAL (ADR-0020 §5,
-- citing the doctrine at database/migrations/005_create_sessions.sql:114-131
-- and the W1-001 defect it was written for). An unlocked read here lets a
-- concurrent renumbering of the row at seq - 1 slip past a trigger that has
-- already passed: T_A inserts seq 3 and reads seq 2 unlocked; T_B renumbers
-- seq 2 to 99 and commits without blocking; T_A commits. Result: 0, 1, 3, 99
-- — a false gap at seq 2 with nothing deleted, and seq 3's previous_hash now
-- names the hash of a row sitting at seq 99, which is exactly what this
-- trigger claimed to prevent.
--
-- This table additionally revokes UPDATE from every role via the append-only
-- triggers below, which is the DURABILITY half: once written, the row this
-- trigger read stays exactly where it was read. The FOR SHARE lock is what
-- makes the READ correct within one transaction; append-only is what makes
-- that fact stay true forever. The two are one mechanism, not two unrelated
-- controls — a future author touching one must not believe the other still
-- holds alone. See database/tests/audit-log-concurrency.spec.ts for the
-- two-connection test that goes red without FOR SHARE.
--
-- Skipped for seq <= 1: seq 0 is the anchor (previous_hash NULL, checked by
-- audit_log_anchor_ties) and seq 1's previous_hash is pinned to the genesis
-- constant by audit_log_genesis_ties plus audit_log_prev_fkey, which already
-- requires a row with hash = 64 zeros to exist in the same tenant (the
-- anchor). Only seq > 1 needs the explicit "parent is the immediately
-- preceding row" check this trigger performs.
-- ---------------------------------------------------------------------------
-- FOR SHARE AND PRIVILEGE, measured rather than assumed. PostgreSQL's row
-- locking clauses (FOR UPDATE/FOR NO KEY UPDATE/FOR SHARE/FOR KEY SHARE) all
-- require UPDATE privilege on the target, not merely SELECT — the same fact
-- 004's claimBatch comment already states for FOR UPDATE ("which correctly
-- means readonly_support cannot run the claim query"), and it applies equally
-- to FOR SHARE. finsoft_app holds SELECT and INSERT on this table and
-- deliberately no table-level UPDATE (Grants, below) — an ordinary SECURITY
-- INVOKER trigger function inherits the INVOKING role's privileges, so under
-- finsoft_app the FOR SHARE read below fails outright with "permission
-- denied for table audit_log" on every insert past seq 1. Reproduced against
-- this exact migration before this comment was written.
--
-- A FIRST DRAFT MADE THIS FUNCTION SECURITY DEFINER, OWNED BY
-- finsoft_migration, TO SUPPLY THE MISSING PRIVILEGE. Database Guardian
-- review rejected it on two measured grounds and it is recorded here so the
-- next author does not reach for the same fix: (1) finsoft_migration holds
-- BYPASSRLS, so a SECURITY DEFINER function it owns runs with row level
-- security OFF — measured, the function could read and lock another
-- tenant's row by hash even though the surrounding INSERT's own tenant_id
-- would be rejected by WITH CHECK a moment later; the read already happened.
-- (2) ADR-0023's SECURITY DEFINER catalogue rules require a dedicated
-- non-BYPASSRLS, NOLOGIN owner role, which does not exist yet and is an
-- Architecture/Database Guardian decision, not one this migration can make
-- unilaterally.
--
-- THE FIX INSTEAD: a narrow, COLUMN-SCOPED grant (Grants, below) that gives
-- finsoft_app the UPDATE privilege PostgreSQL's row-locking check requires,
-- on a column chosen for being harmless to actually write — and the
-- append-only trigger (audit_log_no_update, below) rejects EVERY update
-- attempt UNCONDITIONALLY regardless of which column, so this grant confers
-- no real capability to mutate the table. The function stays SECURITY
-- INVOKER (the default): it runs as finsoft_app, so row level security
-- applies to its FOR SHARE read exactly as it would to any other finsoft_app
-- query, closing the cross-tenant read the SECURITY DEFINER draft opened.
CREATE FUNCTION audit_log_enforce_linkage() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.seq > 1 AND NOT EXISTS (
    SELECT 1 FROM audit_log
     WHERE tenant_id = NEW.tenant_id AND seq = NEW.seq - 1 AND hash = NEW.previous_hash
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'audit_log: previous_hash does not match the hash at seq %', NEW.seq - 1
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION audit_log_enforce_linkage() IS
  'ADR-0020 §5. The parent row is read FOR SHARE — not optional; an unlocked read lets a concurrent seq renumbering produce a false gap (005:114-131 doctrine). SECURITY INVOKER (the default): runs as finsoft_app, so RLS applies to this read. FOR SHARE requires UPDATE privilege, supplied by a harmless column-scoped grant (Grants, below), not by SECURITY DEFINER — see the comment above this function for why that was rejected.';

CREATE TRIGGER audit_log_link
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_enforce_linkage();

-- ---------------------------------------------------------------------------
-- Append-only, enforced against every role including the table owner
--
-- REVOKE UPDATE from finsoft_app (below, in Grants) handles the application
-- role completely — it is the control against that role, full stop. It does
-- nothing against finsoft_migration, which OWNS this table and holds every
-- privilege on it inherently. These triggers are that control: a BEFORE
-- ROW/STATEMENT trigger fires regardless of who holds the grant, and unlike a
-- system-generated referential-integrity trigger, a non-superuser owner CAN
-- disable a plpgsql trigger (`ALTER TABLE ... DISABLE TRIGGER name`) — which
-- is why the audit_log_link trigger's DURABILITY, not just its check, matters
-- (see that trigger's comment), and why
-- database/tests/audit-log.spec.ts asserts `pg_trigger.tgenabled = 'O'`
-- rather than trusting presence alone.
--
-- DELETE/UPDATE triggers do not see TRUNCATE, hence the separate statement
-- trigger.
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit_log_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (rule 9, ADR-0020): % is forbidden, on every role including the table owner. Correct by reversal and re-entry, never by mutating the audit trail.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

COMMENT ON FUNCTION audit_log_forbid_mutation() IS
  'The control against the OWNING role. finsoft_app has no UPDATE/DELETE grant at all (Grants below); this is what stops finsoft_migration, which owns every privilege on this table inherently.';

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Indexes
--
-- ADR-0003 requires tenant_id first on every index of a tenant-owned table;
-- the four constraint indexes above already give that. These three are for
-- the read paths ADR-0020's own verifier and GET /api/audit need beyond
-- them. Free to declare now, on a table with no rows; a CREATE INDEX later,
-- on a table that is never deleted from, only grows more expensive.
-- ---------------------------------------------------------------------------
CREATE INDEX audit_log_entity_idx
  ON audit_log (tenant_id, entity_type, entity_id, seq);

CREATE INDEX audit_log_occurred_idx
  ON audit_log (tenant_id, occurred_at);

-- GET /api/audit's `actor` filter (audit-query.dto.ts) and any future
-- "what did this user do" support/incident query.
CREATE INDEX audit_log_actor_idx
  ON audit_log (tenant_id, actor_user_id, seq);

-- ---------------------------------------------------------------------------
-- Partitioning: NOT DONE IN 009. Council ruling recorded here rather than
-- only in the review thread, per outbox's own precedent (the cheapest
-- moment this decision will ever be).
--
-- RANGE (occurred_at) — the key ADR-0020 §5's deferred-fallback discussion
-- names — is WITHDRAWN as the intended key, not merely deferred.
-- occurred_at is APPLICATION-SUPPLIED (§4 writer rule 2), not the seq order,
-- and PostgreSQL requires the partition key in every unique index of a
-- partitioned table. Declaring RANGE (occurred_at) would therefore force
-- occurred_at INTO audit_log_tenant_seq_key, admitting two rows at the same
-- seq with different occurred_at values as "not a duplicate" — silently
-- reopening the gap-freedom guarantee ADR-0020 §5 rests on (UNIQUE
-- (tenant_id, seq) is one of the four facts gap-freedom is built from).
-- That is disqualifying on its own, and there is a second, independent
-- reason RANGE (occurred_at) does not even buy retention: DETACH PARTITION
-- removes rows. Removing rows from the MIDDLE of a seq sequence is exactly
-- what §6 defines as tampering — "a seq gap is what the verifier reads as
-- evidence of a deleted row" — so detaching an occurred_at-keyed partition
-- manufactures a false tamper alert on the tenant's live chain the moment
-- retention runs. RANGE (occurred_at) partitioning and this table's own
-- verifier are incompatible, not merely awkward together.
--
-- THE FUTURE PATH, if this table's growth ever forces the question: HASH
-- (tenant_id), which sidesteps the seq/occurred_at conflict entirely because
-- it does not touch ordering within a tenant's chain — but it requires the
-- PRIMARY KEY to become (tenant_id, id), which needs an ADR-0021 §1
-- AMENDMENT: that section currently grants this table's surrogate-key
-- exemption on the footing of the (tenant_id, id) UNIQUE constraint existing
-- ALONGSIDE a single-column `id` PRIMARY KEY, not instead of it.
--
-- RETENTION specifically — as opposed to partitioning for query performance
-- — additionally requires an ADR this repository does not have yet: one
-- defining SEALED CHAIN SEGMENTS, because DETACH is still the only
-- rule-4-compatible mechanism and detaching HASH-partitioned data still
-- removes rows the verifier would otherwise walk. A sealed segment needs its
-- own closing manifest (a final hash, a row count, a detachment record) that
-- a segment-aware verifier checks INSTEAD OF treating the absence as a gap.
-- Until that ADR exists, no partition of this table may be detached.
--
-- REVISIT AT: roughly 50 million rows, or 50 GB, or any single tenant
-- reaching 10 million rows — whichever comes first. Recorded as TD-007 in
-- TECH_DEBT.md with these same thresholds, so the trigger condition lives
-- somewhere a growth dashboard can cite it rather than only in this comment.
-- (Renumbered from TD-006 during M1-INT-1: that number collided with
-- develop's own TD-006 for the ADR-0025 test-only auth hooks.)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_log
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON audit_log IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Backfill the anchor for every tenant that already exists
--
-- Empty on a fresh cluster (001 and this migration are the only things that
-- have touched `tenants` before this point in review). Not vacuous in
-- general: a cluster with tenants already provisioned before this migration
-- runs must not be left with tenants that can never append an audit record.
--
-- Runs as finsoft_migration, which holds BYPASSRLS — so `app.tenant_id` is
-- set explicitly for clarity and to match production provisioning's shape
-- (ADR-0020 §5: "under which app.tenant_id"), not because a policy would
-- otherwise block it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(
      ( ('x' || substr(replace(t.id::text, '-', ''),  1, 16))::bit(64)::bigint
      # ('x' || substr(replace(t.id::text, '-', ''), 17, 16))::bit(64)::bigint )
    );
    PERFORM set_config('app.tenant_id', t.id::text, true);

    INSERT INTO audit_log (
      tenant_id, seq, occurred_at, actor_user_id, action, entity_type, entity_id,
      before_json, after_json, ip, request_id, hash_version, hash, previous_hash
    ) VALUES (
      t.id, 0, now(), NULL, 'AUDIT_CHAIN_ANCHOR', 'audit_chain', NULL,
      NULL, NULL, NULL, NULL, 'v1', repeat('0', 64), NULL
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
--
-- INSERT is table-level and unrestricted by column, unlike sessions/outbox:
-- the application computes every one of these columns itself (id, seq, hash,
-- previous_hash included — there is no DEFAULT the database could compute
-- instead, because nothing in SQL produces RFC 8785 JCS bytes), so there is
-- no column a caller could "smuggle" that the writer was not already going to
-- supply. What makes this table append-only is not a restricted INSERT
-- column list; it is that there is no UPDATE, no DELETE, and the chain
-- mechanism makes a forged INSERT self-defeating or outright rejected.
--
-- THE REVOKE IS NOT OPTIONAL (004's lesson, restated because it bites here
-- exactly as it did there): ALTER DEFAULT PRIVILEGES grants finsoft_app
-- table-level UPDATE on every table finsoft_migration creates. Skipping this
-- REVOKE would leave finsoft_app able to rewrite audit history at the
-- privilege layer even with every trigger above in place.
--
-- A PRIVILEGE-ONLY GRANT, IMMEDIATELY BELOW THE REVOKE. `UPDATE (ip)` exists
-- for exactly one reason: PostgreSQL's row-locking clauses require UPDATE
-- privilege to even attempt (see audit_log_enforce_linkage's header comment
-- for the measurement), and audit_log_link's FOR SHARE read needs that
-- privilege to run as finsoft_app at all. The unconditional
-- audit_log_no_update trigger rejects EVERY UPDATE statement regardless of
-- which column it names, so this grant confers no actual ability to change
-- a stored value while that trigger stands.
--
-- `ip` IS THE RIGHT COLUMN, not an arbitrary one, for a reason beyond being
-- unremarkable: it is one of the twelve HASHED columns (ADR-0020 §4). If
-- `audit_log_no_update` is ever disabled or dropped, a write this grant then
-- makes possible is a write to a column the chain has already committed to
-- — the next `npm run audit:verify` run recomputes the row's hash from its
-- stored columns and reports a break at that row's seq. A column excluded
-- from the twelve (there are none on this table, but the principle is what
-- matters for the next author reaching for this pattern elsewhere) would
-- let a defeated trigger's write go completely undetected. This grant and
-- that trigger are not independent — reconsider them together.
--
-- DELETE is not in the default privilege set (roles.spec.ts's generic
-- "grants DELETE to nobody" assertion holds without an explicit REVOKE here,
-- same as every other table in this schema).
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON audit_log FROM finsoft_app;

GRANT SELECT, INSERT ON audit_log TO finsoft_app;
GRANT UPDATE (ip)     ON audit_log TO finsoft_app;
GRANT SELECT          ON audit_log TO readonly_support;
