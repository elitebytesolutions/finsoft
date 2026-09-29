-- 012_create_journal.sql
--
-- The general ledger, and the kernel's party register. NON_NEGOTIABLES rules
-- 1, 2, 4, 5, 7, 9, 12, 14; Invariants 1, 2, 4, 5, 6, 8; ADR-0005 (central
-- posting engine), ADR-0006 (immutable posted transactions, reversal),
-- ADR-0012 (period locking), ADR-0011/0014 (money), ADR-0026 (journal-line
-- party dimension). docs/posting-rules/README.md §4/§4.1, journal-voucher.md,
-- reversal.md.
--
-- Three tables: parties (the kernel's register of who a control-account line
-- may name), journal_entries (the document) and journal_lines (its debit/
-- credit rows). journal_lines never changes after insert; journal_entries
-- permits exactly one UPDATE, ADR-0006's POSTED -> REVERSED; parties is
-- INSERT-only.
--
-- ===========================================================================
-- BINDING SOURCE: ADR-0026 — journal-line party dimension (Accepted
-- 2026-09-28)
--
-- The ADR document is on branch feature/M3-000a-party-dimension and is NOT
-- yet on develop. It must land there before this migration merges, so CI
-- and the Council can trace this schema to its decision (reported to the
-- requesting engineer as an OBSERVED item). Until then, the load-bearing
-- decision text, as this migration builds it:
--
--   1. `parties` is a KERNEL table, created in migration 012 BEFORE
--      journal_entries and journal_lines. Columns: id, tenant_id,
--      party_type (CUSTOMER | VENDOR), plus the standard audit columns. No
--      name/status columns. UNIQUE (tenant_id, id) and UNIQUE (tenant_id,
--      party_type, id). RLS enabled and forced. INSERT-only: finsoft_app
--      gets SELECT and INSERT, no UPDATE, no DELETE — a party's identity
--      and type never change. (Council T3, DB R2: additionally a
--      forbid-mutation trigger for UPDATE/DELETE/TRUNCATE on every role,
--      mirroring journal_lines — below.)
--   2. journal_lines references a party ONLY via composite FK
--      (tenant_id, party_type, party_id) REFERENCES parties (tenant_id,
--      party_type, id) MATCH SIMPLE ON DELETE RESTRICT. MATCH SIMPLE is
--      deliberate: party_type/party_id are both NULL on a non-control line,
--      and MATCH FULL would reject every such line because tenant_id is
--      never NULL.
--   3. journal_lines carries account_control NOT NULL, copied from the
--      line's account at posting time. Its composite FK (tenant_id,
--      account_id, account_control) REFERENCES accounts (tenant_id, id,
--      control_kind) is journal_lines' ONLY foreign key to accounts. Two
--      CHECKs tie party to account_control: (party_type IS NULL) =
--      (party_id IS NULL), and AR <=> CUSTOMER, AP <=> VENDOR,
--      NONE/INVENTORY <=> no party. README §4.1's "an AR line must carry a
--      customer" is structural — CHECK + composite FK — not a trigger.
--   4. Module tables (M3+) reference parties 1:1 by SHARED id, never the
--      reverse.
--   5. Only the kernel writes `parties`. The INSERT (registerParty) lives in
--      packages/accounting-kernel, NOT packages/database: packages/database
--      is importable by modules/*/infrastructure, which would let a module
--      write the register directly. (Overruled at Architecture-seat
--      signature from an earlier "packages/database" wording.)
--   6. The posting engine pre-checks the party (PARTY_NOT_FOUND /
--      PARTY_TYPE_MISMATCH); the FK is the backstop.
--   7. accounts.control_kind becomes NOT NULL with 'NONE' as the non-control
--      value (migration 010), and UNIQUE (tenant_id, id, control_kind) is
--      the FK target. "The FK also blocks any change to the control kind of
--      an account that has been posted to."
--
-- ONE DELIBERATE DEVIATION IN SPELLING, NOT IN MEANING. Statement 3's second
-- CHECK, transcribed literally —
--     (account_control = 'AR' AND party_type = 'CUSTOMER')
--  OR (account_control = 'AP' AND party_type = 'VENDOR')
--  OR (account_control IN ('NONE','INVENTORY') AND party_type IS NULL)
-- — evaluates to NULL, not FALSE, for an AR line with party_type NULL
-- ('AR'='AR' AND NULL='CUSTOMER' is NULL; the other two arms are FALSE), and
-- a CHECK that evaluates to NULL PASSES. The literal text therefore admits
-- exactly the row the ADR exists to forbid. journal_lines_party_matches_control
-- below writes the same three arms null-safely (IS NOT DISTINCT FROM), and
-- database/tests/journal-lines.spec.ts proves the AR-without-party row is
-- rejected. Reported for the ADR text to be corrected to match.
-- ===========================================================================
--
-- ---------------------------------------------------------------------------
-- The balance check: a DEFERRED CONSTRAINT TRIGGER, not a CHECK
--
-- Sigma(debit) = Sigma(credit) is an ENTRY-level fact built from several
-- journal_lines rows, which no single-row CHECK can see. The constraint
-- trigger is DEFERRABLE INITIALLY DEFERRED, so it runs just before COMMIT,
-- when every line of the entry exists regardless of insert order or
-- statement count. Invariant 1's database-level enforcement point (rule 1
-- names three: the posting engine before the write, this, and
-- FinancialInvariantSuite).
--
-- A balance trigger on journal_lines cannot see an entry with NO lines — it
-- never fires. journal_entries_check_complete (deferred, on journal_entries)
-- closes that: an entry commits with at least two lines or not at all, and a
-- reversal entry commits only together with its original's POSTED ->
-- REVERSED transition pointing back at it.
--
-- ---------------------------------------------------------------------------
-- Lines are written only in the transaction that created their entry
--
-- journal_lines is INSERT-granted, so without a further rule a later
-- transaction could append a balanced pair of lines to an already-posted
-- (or already-REVERSED) entry — a mutation of a posted document by
-- addition, which rule 2 forbids as surely as an UPDATE. The line trigger
-- requires the entry's created_at to equal this transaction's own
-- transaction_timestamp(). created_at is not INSERT-granted (it is the
-- database's DEFAULT now(), which IS transaction_timestamp()) and the
-- immutability trigger forbids changing it, so for finsoft_app it is exactly
-- "the transaction that created the entry". Residual: a second transaction
-- starting in the SAME MICROSECOND could match — not reachable by a bug,
-- only by deliberate timing, and recorded here rather than claimed away.
--
-- ---------------------------------------------------------------------------
-- The period check: a trigger on journal_entries, reading fiscal_periods
--
-- ADR-0012 / periods.md §7: no journal entry posts into a non-OPEN period,
-- for any actor, and no entry names a period its business date is not in.
-- The trigger reads the period row FOR SHARE, which blocks on a concurrent
-- close's FOR UPDATE and re-reads the committed status when it releases
-- (journal-voucher.md edge cases: "the voucher either commits before the
-- close or is rejected after it"; database/tests/accounting-triggers.spec.ts
-- proves both orders). The posting path has already taken the same FOR
-- SHARE earlier (findPeriodForDate, LOCK_REGISTRY position 5b), so on that
-- path this re-lock is of a row the transaction already holds.
--
-- The date check (occurred_at within [period_start, period_end]) closes a
-- bypass the status check alone leaves open: a caller pairing a CLOSED
-- month's occurred_at with the next OPEN month's fiscal_period_id. Both
-- columns are immutable after insert (journal_entries_enforce_immutability),
-- so checking at INSERT is sufficient. Triggers bind every role, including
-- the BYPASSRLS migration role.
--
-- ---------------------------------------------------------------------------
-- Partitioning — flagged now, not built
--
-- journal_lines is the fastest-growing table in the schema. Intended
-- partition strategy, to be decided by the Database seat before the table
-- passes ~50M rows: RANGE on posting date. That needs the business date ON
-- the line (today it lives on journal_entries); the intended shape is a
-- denormalised journal_lines.occurred_at bound to the entry's by a
-- composite FK (tenant_id, entry_id, occurred_at) — a new column on a large
-- table later is a rewrite, so this is the decision to make early.
--
-- ---------------------------------------------------------------------------
-- Lock footprint: CREATE TABLE takes SHARE ROW EXCLUSIVE on tenants, users,
-- fiscal_periods and accounts for the transaction (foreign keys). The
-- CREATE TRIGGER on accounts takes SHARE ROW EXCLUSIVE on accounts. All of
-- these are near-empty at this point in the schema's life (pre-release); no
-- existing row is rewritten, no index is built on a populated table.
--
-- How this is reversed: it is not, in place (ADR-0013, forward-only). Before
-- release, an unapplied edit; after release, a forward migration.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- parties — ADR-0026 statement 1
-- ===========================================================================
CREATE TABLE parties (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  party_type  text        NOT NULL CHECK (party_type IN ('CUSTOMER', 'VENDOR')),

  -- The standard audit columns (IMPLEMENTATION §11). updated_at/updated_by/
  -- version are kept for schema-wide consistency (schema.spec.ts's mandatory
  -- column set) but can never change: there is no UPDATE grant, and
  -- parties_forbid_mutation (below) refuses UPDATE for every role.
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        NOT NULL,
  version     integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT parties_tenant_id_id_key UNIQUE (tenant_id, id),
  -- The target of journal_lines' party FK (ADR-0026 statement 2).
  CONSTRAINT parties_tenant_type_id_key UNIQUE (tenant_id, party_type, id),

  CONSTRAINT parties_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT parties_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE parties IS
  'ADR-0026. Kernel-owned register of the parties a control-account journal line may name. INSERT-only for every role (grants + parties_forbid_mutation); written only by packages/accounting-kernel (registerParty). Module tables (customers, vendors) reference it 1:1 by shared id. Tenant-owned, RLS enabled and forced.';

-- ---------------------------------------------------------------------------
-- INSERT-only: no UPDATE, no DELETE, no TRUNCATE, for any role including the
-- owner. The same doctrine and shape as journal_lines_forbid_mutation below
-- (and audit_log, 009): the privilege layer stops finsoft_app, this stops
-- the migration role and anything else that owns or is granted the table.
-- Disabling it needs ALTER TABLE by the owner, which parties.spec.ts's
-- tgenabled assertion turns into a CI failure.
-- ---------------------------------------------------------------------------
CREATE FUNCTION parties_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'parties is insert-only (ADR-0026 statement 1, rule 4): % is forbidden, on every role including the table owner. A party''s identity and type never change.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

CREATE TRIGGER parties_no_update
  BEFORE UPDATE ON parties
  FOR EACH ROW EXECUTE FUNCTION parties_forbid_mutation();

CREATE TRIGGER parties_no_delete
  BEFORE DELETE ON parties
  FOR EACH ROW EXECUTE FUNCTION parties_forbid_mutation();

CREATE TRIGGER parties_no_truncate
  BEFORE TRUNCATE ON parties
  FOR EACH STATEMENT EXECUTE FUNCTION parties_forbid_mutation();

-- ===========================================================================
-- journal_entries
-- ===========================================================================
CREATE TABLE journal_entries (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,

  -- README §4: SERIES-FY-NNNNNN, from document_sequences (013) in the
  -- posting transaction. Six digits minimum, not exactly six: the counter
  -- does not stop at 999999, and a tenant's millionth voucher of a year must
  -- not fail a CHECK.
  entry_number         text        NOT NULL CHECK (entry_number ~ '^[A-Z]{2,10}-[0-9]{4}-[0-9]{6,}$'),

  -- The rule id@version this entry was posted under (README §2.4). Never
  -- edited: a rule change is a new version.
  posting_rule         text        NOT NULL CHECK (posting_rule ~ '^[A-Z_]+(/[a-z]+)?@[0-9]+$'),

  -- The FinancialEvent member. A reversal R carries the SAME event as the
  -- entry E it reverses (reversal.md §1) — REVERSAL@1 is distinguished by
  -- posting_rule, not event.
  event                text        NOT NULL CHECK (event ~ '^[A-Z][A-Z_]*$'),

  -- Business date, tenant timezone, server-validated (rule 13).
  occurred_at          date        NOT NULL,

  -- Resolved by the server from occurred_at (periods.md §1).
  fiscal_period_id     uuid        NOT NULL,

  -- Born POSTED: the journal has no draft state (README §4 table: drafts
  -- live in the source document's table). Not INSERT-granted.
  status               text        NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),

  narration            text        NOT NULL CHECK (length(btrim(narration)) > 0 AND length(narration) <= 500),
  reference            text        CHECK (reference IS NULL OR length(reference) <= 100),

  -- Source-document uniqueness (rule 14): one posted entry per source,
  -- ever. 'journal_voucher' for a manual JV; 'reversal' for R (source_id =
  -- E.id); 'sales_invoice', 'customer_receipt' from M3.
  source_type          text        NOT NULL CHECK (source_type ~ '^[a-z][a-z0-9_]*$'),
  source_id            uuid        NOT NULL,

  -- Idempotency (rule 14, README §4). Retained forever, unique per tenant.
  idempotency_key      text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),

  -- README §4 "Fingerprint": sha256 hex of the canonical request.
  request_fingerprint  text        NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  -- Set ONLY on a reversal R: the entry R reverses, and R's reason.
  reversal_of          uuid,
  reversal_reason      text        CHECK (reversal_reason IS NULL OR length(btrim(reversal_reason)) BETWEEN 1 AND 500),

  -- Set ONLY on the reversed entry E, when R posts (reversal.md §8/§99:
  -- "reversed_by = R.id"). reversed_by names the REVERSING ENTRY, not a
  -- user — the acting user of a reversal is R.created_by and E.updated_by.
  reversed_by          uuid,
  reversed_at          timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NOT NULL,
  version              integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  -- A reversal is exactly: posting_rule REVERSAL@n, source ('reversal',
  -- E.id), and a reason — all four or none (reversal.md §1, §6).
  CONSTRAINT journal_entries_reversal_shape
    CHECK (
      (reversal_of IS NOT NULL) = (posting_rule LIKE 'REVERSAL@%')
      AND (reversal_of IS NOT NULL) = (source_type = 'reversal')
      AND (reversal_of IS NOT NULL) = (reversal_reason IS NOT NULL)
      AND (reversal_of IS NULL OR (source_id = reversal_of AND reversal_of <> id))
    ),
  CONSTRAINT journal_entries_reversed_pair
    CHECK (
      (status = 'REVERSED') = (reversed_by IS NOT NULL)
      AND (reversed_by IS NULL) = (reversed_at IS NULL)
      AND (reversed_by IS NULL OR reversed_by <> id)
    ),
  -- reversal.md §6: a reversal cannot itself be reversed.
  CONSTRAINT journal_entries_reversal_not_reversible
    CHECK (reversal_of IS NULL OR reversed_by IS NULL),

  CONSTRAINT journal_entries_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT journal_entries_tenant_number_key UNIQUE (tenant_id, entry_number),
  CONSTRAINT journal_entries_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT journal_entries_tenant_source_key UNIQUE (tenant_id, source_type, source_id),
  -- reversal.md §6: at most one reversal per entry. NULLs are distinct, so
  -- non-reversal rows never collide.
  CONSTRAINT journal_entries_reversal_of_key UNIQUE (tenant_id, reversal_of),

  CONSTRAINT journal_entries_period_fkey
    FOREIGN KEY (tenant_id, fiscal_period_id) REFERENCES fiscal_periods (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT journal_entries_reversal_of_fkey
    FOREIGN KEY (tenant_id, reversal_of) REFERENCES journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT journal_entries_reversed_by_fkey
    FOREIGN KEY (tenant_id, reversed_by) REFERENCES journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT journal_entries_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT journal_entries_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- Period-scoped reads (close review, period reports) and date-range reads
-- (ledger, trial balance joins). No index on status: nothing reads by it,
-- and every read in ledger.ts deliberately includes both statuses.
CREATE INDEX journal_entries_tenant_period_idx ON journal_entries (tenant_id, fiscal_period_id);
CREATE INDEX journal_entries_tenant_occurred_idx ON journal_entries (tenant_id, occurred_at);

COMMENT ON TABLE journal_entries IS
  'The journal (NON_NEGOTIABLES rule 11: sole source of truth for balances). Immutable once posted except the single POSTED->REVERSED transition (ADR-0006). Tenant-owned, RLS enabled and forced.';
COMMENT ON COLUMN journal_entries.event IS
  'The FinancialEvent this entry (or, for a reversal, the ORIGINAL entry) was raised for. A reversal shares its original''s event so event-grouped reports net the pair (reversal.md §1).';
COMMENT ON COLUMN journal_entries.request_fingerprint IS
  'sha256 hex of the canonical (event, referenceType, referenceId, occurredAt, actor, payload) tuple. A replay of idempotency_key with a different fingerprint is IDEMPOTENCY_KEY_REUSED.';
COMMENT ON COLUMN journal_entries.reversed_by IS
  'The REVERSING ENTRY (R.id), per reversal.md — not a user. The acting user is R.created_by / E.updated_by.';

CREATE TRIGGER journal_entries_set_updated_at
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Immutability: the only UPDATE a posted entry ever receives is POSTED ->
-- REVERSED, naming a reversal entry that actually reverses it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_entries_enforce_immutability() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.entry_number <> OLD.entry_number OR NEW.posting_rule <> OLD.posting_rule
     OR NEW.event <> OLD.event OR NEW.occurred_at <> OLD.occurred_at
     OR NEW.fiscal_period_id <> OLD.fiscal_period_id
     OR NEW.narration <> OLD.narration
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.source_type <> OLD.source_type OR NEW.source_id <> OLD.source_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_fingerprint <> OLD.request_fingerprint
     OR NEW.reversal_of IS DISTINCT FROM OLD.reversal_of
     OR NEW.reversal_reason IS DISTINCT FROM OLD.reversal_reason
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'journal_entries: posted rows are immutable except the reversal transition (entry %). Correct by reversal, never by mutation (rule 2, ADR-0006).', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'journal_entries: version must increase on every update (entry %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'journal_entries: entry % is already REVERSED. There is no transition out (reversal.md §6).', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED') THEN
    RAISE EXCEPTION 'journal_entries: % -> % is not a permitted transition (entry %)', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- reversed_by must name the entry that reverses THIS one — not any
  -- entry of the tenant, which the self-referencing FK alone would accept.
  PERFORM 1 FROM journal_entries
   WHERE tenant_id = OLD.tenant_id AND id = NEW.reversed_by AND reversal_of = OLD.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal_entries: reversed_by % is not a reversal of entry % (reversal.md §8)', NEW.reversed_by, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION journal_entries_enforce_immutability() IS
  'NON_NEGOTIABLES rule 2, ADR-0006: the only UPDATE a posted entry ever receives is POSTED->REVERSED, with reversed_by naming an entry whose reversal_of is this one. Everything else, including a second reversal, is rejected.';

CREATE TRIGGER journal_entries_enforce_immutability
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_enforce_immutability();

-- ---------------------------------------------------------------------------
-- The period gate. ADR-0012, periods.md §7 — the database's last line.
-- FOR SHARE needs UPDATE privilege on fiscal_periods, which finsoft_app holds
-- (column-scoped) from migration 011.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_entries_enforce_open_period() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  period_status text;
  p_start       date;
  p_end         date;
BEGIN
  SELECT status, period_start, period_end INTO period_status, p_start, p_end
    FROM fiscal_periods
   WHERE tenant_id = NEW.tenant_id AND id = NEW.fiscal_period_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal_entries: fiscal_period_id % does not belong to tenant % (PERIOD_NOT_FOUND)', NEW.fiscal_period_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.occurred_at < p_start OR NEW.occurred_at > p_end THEN
    RAISE EXCEPTION 'journal_entries: occurred_at % is outside period % [%, %] (entry %) — the period is resolved from the date, never chosen independently of it (periods.md §1)', NEW.occurred_at, NEW.fiscal_period_id, p_start, p_end, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF period_status <> 'OPEN' THEN
    RAISE EXCEPTION 'journal_entries: cannot post into a % period (entry %, period %) — ADR-0012, no system bypass', period_status, NEW.id, NEW.fiscal_period_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION journal_entries_enforce_open_period() IS
  'ADR-0012 / periods.md §1, §7: no journal entry may post into a non-OPEN period, or name a period that does not contain its occurred_at, for any actor including the migration role. FOR SHARE serialises against a concurrent close (FOR UPDATE) of the same period row — LOCK_REGISTRY 5b.';

CREATE TRIGGER journal_entries_enforce_open_period
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_enforce_open_period();

-- ===========================================================================
-- journal_lines — ADR-0026 statements 2 and 3
-- ===========================================================================
CREATE TABLE journal_lines (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  entry_id         uuid        NOT NULL,
  line_number      smallint    NOT NULL CHECK (line_number >= 1),
  account_id       uuid        NOT NULL,

  -- ADR-0026 statement 3: the account's control_kind, copied at posting
  -- time and pinned to it by journal_lines_account_fkey below. The CHECK
  -- duplicates accounts.control_kind's own so a bad value fails as 23514
  -- with a clear name rather than only as an FK miss.
  account_control  text        NOT NULL CHECK (account_control IN ('NONE', 'AR', 'AP', 'INVENTORY')),

  -- numeric(19,4), ADR-0011. NaN is excluded with `<> 'NaN'`, never
  -- `col = col` (PostgreSQL's NaN = NaN is TRUE) — numeric-finite.spec.ts.
  debit            numeric(19,4) NOT NULL DEFAULT 0
                   CHECK (debit >= 0 AND debit <> 'NaN'::numeric),
  credit           numeric(19,4) NOT NULL DEFAULT 0
                   CHECK (credit >= 0 AND credit <> 'NaN'::numeric),

  -- README §4.1 / ADR-0026: a party iff the account is AR or AP control.
  party_type       text        CHECK (party_type IN ('CUSTOMER', 'VENDOR')),
  party_id         uuid,

  memo             text        CHECK (memo IS NULL OR length(memo) <= 500),

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  version          integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  -- Rule 1: exactly one side is greater than zero.
  CONSTRAINT journal_lines_one_side
    CHECK ((debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)),

  -- ADR-0026 statement 3, first CHECK.
  CONSTRAINT journal_lines_party_pair
    CHECK ((party_type IS NULL) = (party_id IS NULL)),

  -- ADR-0026 statement 3, second CHECK — written null-safely. See the file
  -- header: the ADR's literal spelling evaluates to NULL (= pass) for an AR
  -- line with no party.
  CONSTRAINT journal_lines_party_matches_control
    CHECK (
         (account_control = 'AR' AND party_type IS NOT DISTINCT FROM 'CUSTOMER')
      OR (account_control = 'AP' AND party_type IS NOT DISTINCT FROM 'VENDOR')
      OR (account_control IN ('NONE', 'INVENTORY') AND party_type IS NULL)
    ),

  CONSTRAINT journal_lines_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Also the (tenant_id, entry_id) access path — no separate index needed.
  CONSTRAINT journal_lines_tenant_entry_line_key UNIQUE (tenant_id, entry_id, line_number),

  CONSTRAINT journal_lines_entry_fkey
    FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entries (tenant_id, id) ON DELETE RESTRICT,
  -- ADR-0026 statement 3: the ONLY foreign key to accounts. ON UPDATE
  -- RESTRICT makes "change the control kind of an account that has been
  -- posted to" a 23503 for every role (010's header).
  CONSTRAINT journal_lines_account_fkey
    FOREIGN KEY (tenant_id, account_id, account_control)
    REFERENCES accounts (tenant_id, id, control_kind)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- ADR-0026 statement 2. MATCH SIMPLE: all-NULL party columns skip the
  -- check (non-control lines); a half-NULL pair is journal_lines_party_pair's
  -- to reject.
  CONSTRAINT journal_lines_party_fkey
    FOREIGN KEY (tenant_id, party_type, party_id)
    REFERENCES parties (tenant_id, party_type, id)
    MATCH SIMPLE ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT journal_lines_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT journal_lines_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- The account ledger's access path (ledger-and-trial-balance.md §2), and the
-- referencing-side index accounts' FK check needs on an UPDATE of
-- (id, control_kind) — a prefix of the FK's columns is enough.
CREATE INDEX journal_lines_tenant_account_idx ON journal_lines (tenant_id, account_id);
-- The party subledger (Invariant 9's GL half: a customer's balance on the
-- AR control account) — exactly ADR-0026 Compliance row 8, built while the
-- table is empty. Leads tenant_id, then party_id (the customer-ledger
-- predicate), then account_id (the control account). It also serves the
-- referencing-side lookup for journal_lines_party_fkey: (tenant_id, party_id)
-- is a prefix and party_type is a residual filter on one party's rows — and
-- parties rows are never updated or deleted, so that FK action check does
-- not run in practice. The M3 customer-ledger EXPLAIN (ANALYZE, BUFFERS)
-- against production-sized data is the Database seat's M3 gate.
CREATE INDEX journal_lines_tenant_party_account_idx
  ON journal_lines (tenant_id, party_id, account_id) WHERE party_id IS NOT NULL;

COMMENT ON TABLE journal_lines IS
  'Debit/credit rows of a journal entry. Append-only from insert, for every role. Party and control kind are tied structurally (ADR-0026): composite FKs to accounts(tenant_id,id,control_kind) and parties(tenant_id,party_type,id), plus CHECKs. Tenant-owned, RLS enabled and forced.';
COMMENT ON COLUMN journal_lines.account_control IS
  'ADR-0026: the account''s control_kind at posting time, pinned by FK. AR <=> party CUSTOMER, AP <=> party VENDOR, NONE/INVENTORY <=> no party.';

-- ---------------------------------------------------------------------------
-- Append-only: no UPDATE, no DELETE, no TRUNCATE, for any role including the
-- owner (same doctrine as audit_log, migration 009). No set_updated_at
-- trigger: there is no update for it to stamp.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_lines_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'journal_lines is append-only (rule 2, rule 4): % is forbidden, on every role including the table owner. A reversal creates new lines on a new entry; it never touches these.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

CREATE TRIGGER journal_lines_no_update
  BEFORE UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_forbid_mutation();

CREATE TRIGGER journal_lines_no_delete
  BEFORE DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_forbid_mutation();

CREATE TRIGGER journal_lines_no_truncate
  BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION journal_lines_forbid_mutation();

-- ---------------------------------------------------------------------------
-- The line gate: the entry was created in THIS transaction and is POSTED;
-- the account is POSTABLE and active. Party/control pairing is NOT here — it
-- is structural (CHECK + FK, ADR-0026), which is the point of that ADR.
--
-- No locking read of accounts: finsoft_app holds no UPDATE on accounts in M2
-- (so FOR SHARE would fail with permission denied), and nothing can mutate an
-- account concurrently. When Wave 2 grants a column-scoped UPDATE for
-- deactivate, revisit: a deactivate racing a posting to the same account.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_lines_enforce_line_gate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  entry_created_at timestamptz;
  entry_status     text;
  acct_kind        text;
  acct_active      boolean;
BEGIN
  SELECT created_at, status INTO entry_created_at, entry_status
    FROM journal_entries
   WHERE tenant_id = NEW.tenant_id AND id = NEW.entry_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal_lines: entry % does not belong to tenant %', NEW.entry_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF entry_created_at <> transaction_timestamp() OR entry_status <> 'POSTED' THEN
    RAISE EXCEPTION 'journal_lines: lines may only be added in the transaction that created entry % (rule 2 — a posted entry is never extended)', NEW.entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT kind, is_active INTO acct_kind, acct_active
    FROM accounts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal_lines: account % does not belong to tenant % (ACCOUNT_NOT_FOUND)', NEW.account_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF acct_kind <> 'POSTABLE' THEN
    RAISE EXCEPTION 'journal_lines: account % is a HEADER account and cannot take a journal line (ACCOUNT_NOT_POSTABLE)', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT acct_active THEN
    RAISE EXCEPTION 'journal_lines: account % is inactive (ACCOUNT_INACTIVE)', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION journal_lines_enforce_line_gate() IS
  'Rule 2: lines are written only in the transaction that created their (POSTED) entry. coa-standard.md: only an active POSTABLE account takes a line. Party/control pairing is structural (ADR-0026), not here.';

CREATE TRIGGER journal_lines_enforce_line_gate
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_enforce_line_gate();

-- ---------------------------------------------------------------------------
-- The balance check: Invariant 1, at COMMIT.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_lines_check_balance() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  total_debit  numeric;
  total_credit numeric;
BEGIN
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM journal_lines
   WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.entry_id;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'journal_lines: entry % does not balance at commit — debit %, credit %, difference % (Invariant 1)',
      NEW.entry_id, total_debit, total_credit, (total_debit - total_credit)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION journal_lines_check_balance() IS
  'Invariant 1 / NON_NEGOTIABLES rule 1, database enforcement point. Deferred to COMMIT so every line of the entry is present before the sum is taken.';

CREATE CONSTRAINT TRIGGER journal_lines_check_balance
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_lines_check_balance();

-- ---------------------------------------------------------------------------
-- Entry completeness, at COMMIT: at least two lines, and a reversal commits
-- only together with its original's transition pointing back at it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_entries_check_complete() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  line_count integer;
BEGIN
  SELECT count(*) INTO line_count
    FROM journal_lines
   WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'journal_entries: entry % has % line(s) at commit; an entry needs at least two (Invariant 1)', NEW.id, line_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reversal_of IS NOT NULL THEN
    PERFORM 1 FROM journal_entries
     WHERE tenant_id = NEW.tenant_id AND id = NEW.reversal_of
       AND status = 'REVERSED' AND reversed_by = NEW.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'journal_entries: reversal % committed without entry % being marked REVERSED by it (reversal.md §8)', NEW.id, NEW.reversal_of
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION journal_entries_check_complete() IS
  'Deferred to COMMIT. An entry has at least two lines (the line-level balance trigger never fires for an entry with none), and a reversal R commits only with E.status = REVERSED and E.reversed_by = R.id (reversal.md §8).';

CREATE CONSTRAINT TRIGGER journal_entries_check_complete
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entries_check_complete();

-- ---------------------------------------------------------------------------
-- Extending migration 010: once an account has a journal line, its type and
-- kind are immutable (coa-standard.md §5). control_kind is ALSO pinned by
-- journal_lines_account_fkey (ON UPDATE RESTRICT) for every role; it is
-- checked here too so the rejection names the rule rather than an FK.
--
-- Inert for finsoft_app today (no UPDATE grant on accounts); binds the
-- migration role and admin scripts now, and finsoft_app from Wave 2.
-- ---------------------------------------------------------------------------
CREATE FUNCTION accounts_enforce_posted_immutability() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.type <> OLD.type OR NEW.kind <> OLD.kind OR NEW.control_kind <> OLD.control_kind
      OR NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id)
     AND EXISTS (
       SELECT 1 FROM journal_lines
        WHERE tenant_id = OLD.tenant_id AND account_id = OLD.id
     )
  THEN
    RAISE EXCEPTION 'accounts: % has a journal line — type, kind and control_kind are immutable (coa-standard.md §5)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION accounts_enforce_posted_immutability() IS
  'coa-standard.md §5. Added in 012 because it reads journal_lines. control_kind is additionally pinned by journal_lines_account_fkey (ADR-0026).';

CREATE TRIGGER accounts_enforce_posted_immutability
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_enforce_posted_immutability();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE parties         ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties         FORCE  ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE  ROW LEVEL SECURITY;
ALTER TABLE journal_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines   FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON parties
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON journal_entries
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON journal_lines
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON parties IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';
COMMENT ON POLICY tenant_isolation ON journal_entries IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';
COMMENT ON POLICY tenant_isolation ON journal_lines IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- THE REVOKE COVERS INSERT AS WELL AS UPDATE (008's lesson, missed by the
-- first draft of this file). ALTER DEFAULT PRIVILEGES gives every new table
-- TABLE-level SELECT, INSERT, UPDATE to finsoft_app; table-level INSERT
-- would let a caller insert an entry born status = 'REVERSED', or stamp its
-- own id, created_at (defeating the line gate above) or version. The column
-- lists that follow are what survives. DELETE is granted to nobody (rule 4).
--
-- parties: SELECT and INSERT only (ADR-0026 statement 1), column-scoped.
-- journal_entries: UPDATE only the reversal transition's columns.
-- journal_lines: INSERT only, ever.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON parties         FROM finsoft_app;
REVOKE INSERT, UPDATE ON journal_entries FROM finsoft_app;
REVOKE INSERT, UPDATE ON journal_lines   FROM finsoft_app;

GRANT SELECT ON parties TO finsoft_app;
GRANT INSERT (tenant_id, party_type, created_by, updated_by) ON parties TO finsoft_app;

GRANT SELECT ON journal_entries TO finsoft_app;
GRANT INSERT (
  tenant_id, entry_number, posting_rule, event, occurred_at, fiscal_period_id,
  narration, reference, source_type, source_id, idempotency_key,
  request_fingerprint, reversal_of, reversal_reason, created_by, updated_by
) ON journal_entries TO finsoft_app;
GRANT UPDATE (status, reversed_by, reversed_at, updated_at, updated_by, version)
  ON journal_entries TO finsoft_app;

GRANT SELECT ON journal_lines TO finsoft_app;
GRANT INSERT (
  tenant_id, entry_id, line_number, account_id, account_control, debit, credit,
  party_type, party_id, memo, created_by, updated_by
) ON journal_lines TO finsoft_app;

GRANT SELECT ON parties         TO readonly_support;
GRANT SELECT ON journal_entries TO readonly_support;
GRANT SELECT ON journal_lines   TO readonly_support;
