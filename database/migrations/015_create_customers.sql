-- Owner: modules/customers
--
-- 015_create_customers.sql
--
-- The customer master. First table owned by a feature module
-- (ADR-0028 statement 9). docs/design/M3/modules.md §7, ADR-0026 statement 4,
-- docs/design/M3/open-questions.md M3-Q2.
--
-- ---------------------------------------------------------------------------
-- Numbering note: 015, not 014
--
-- docs/design/M3/README.md §2 and ADR-0028's Compliance table both name this
-- migration 014. It is 015 here: M2-B's follow-up PR (a permissions
-- backfill — packages/permissions role_permissions seeding for
-- account.view/period.view/period.close/period.reopen, raised as a Council
-- ruling 2026-09-29) claimed 014 first. The M3 reservation moves to 015-017
-- by the same rule docs/BOARD.md states for the M1 precedent (2026-09-26):
-- "A lane whose migration is ready before its predecessor has merged waits;
-- it does not renumber." This PR does not merge until 014 exists on
-- `develop` — reported as BLOCKED in this lane's delivery report, not
-- silently worked around. docs/design/M3/README.md §2 and ADR-0028's table
-- are stale by one number and should be corrected when 014 lands; this
-- header is the authoritative record until then.
--
-- ---------------------------------------------------------------------------
-- Shape: ADR-0026 statement 4 — a module table references the kernel-owned
-- parties registry 1:1 by SHARED id, and never the reverse.
--
-- `customers.id` IS the party id: `CreateCustomer` calls
-- `registerParty(tx, 'CUSTOMER')` first (packages/accounting-kernel), in the
-- SAME transaction, and inserts this row with `id` = the returned party id.
-- `id` therefore carries no DEFAULT — a caller-supplied id is normally a red
-- flag (rule "document numbers come from the server"), but this is the one
-- sanctioned case: the value did not come from the client, it came from the
-- kernel's own INSERT earlier in the same transaction, and the immediate
-- composite FK to `parties` makes the order compulsory — an id that was not
-- first registered with the kernel cannot be inserted here at all.
--
-- `party_type` is always 'CUSTOMER' (CHECK), carried on the row rather than
-- inferred, because it is a component of the composite FK target
-- `parties (tenant_id, party_type, id)` — ADR-0026 statement 2's journal-line
-- FK uses the same three columns, so the party's type is verified structurally
-- at every reference, not just at creation.
--
-- ---------------------------------------------------------------------------
-- Code: system-generated, immutable (M3-Q2, Product Owner 2026-09-28)
--
-- `CreateCustomer` assigns `code` from the kernel's TENANT-scope numbering
-- facility (K7, `documentNumbers.next(tx, { series: 'CUST' })`) in the SAME
-- transaction — a rolled-back create consumes no number (rule 12). The
-- create API accepts no code (docs/design/M3/open-questions.md M3-Q2); a
-- request that sends one is rejected at the zod schema (`VALIDATION_FAILED`)
-- before this table is ever reached. `customers_enforce_immutable_identity`
-- below is the database's own backstop: even a direct UPDATE (any role,
-- including the migration role) cannot change a code once assigned.
--
-- ---------------------------------------------------------------------------
-- Balance and settlement are NOT columns
--
-- A customer's balance is read from `journal_lines` at request time (K5,
-- `@finsoft/reporting`'s `controlAccountLedger`) — never cached here, per
-- rule 11 ("the journal is the sole source of truth for balances") and this
-- pack's own "no cached balances" (modules.md §13). Deactivation checks the
-- SAME query before refusing (`CUSTOMER_HAS_BALANCE`), so there is nothing
-- for a cached column to get out of sync with.
--
-- ---------------------------------------------------------------------------
-- Lock footprint: CREATE TABLE takes SHARE ROW EXCLUSIVE on tenants, users
-- and parties for the transaction (foreign keys). All are near-empty at this
-- point in the schema's life relative to this table's own growth.
--
-- How this is reversed: it is not, in place (ADR-0013, forward-only).
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,

  -- ADR-0026 statement 4, verbatim.
  party_type   text        NOT NULL DEFAULT 'CUSTOMER' CHECK (party_type = 'CUSTOMER'),

  code         text        NOT NULL CHECK (code ~ '^CUST-[0-9]{6,}$'),
  name         text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  phone        text        CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 1 AND 50),
  email        text        CHECK (email IS NULL OR length(btrim(email)) BETWEEN 1 AND 200),
  address      text        CHECK (address IS NULL OR length(btrim(address)) BETWEEN 1 AND 500),
  city         text        CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 100),
  -- Stored only — no tax logic in the MVP (modules.md §7).
  ntn          text        CHECK (ntn IS NULL OR ntn ~ '^[0-9]{7}-?[0-9]?$'),
  -- Default due date = invoice date + credit_days (M3-P). No GL effect.
  credit_days  integer     NOT NULL DEFAULT 0 CHECK (credit_days BETWEEN 0 AND 365),
  status       text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),

  -- Create-only idempotency (modules.md §9). There is no post/reverse
  -- idempotency pair: creating a customer is not a posting.
  create_idempotency_key  text NOT NULL CHECK (create_idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  create_fingerprint      text NOT NULL CHECK (create_fingerprint ~ '^[0-9a-f]{64}$'),

  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NOT NULL,
  version      integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT customers_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customers_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT customers_tenant_create_idempotency_key UNIQUE (tenant_id, create_idempotency_key),

  -- ADR-0026 statement 4: the ONE place a module table references the
  -- kernel's party registry, 1:1 by shared id. S3 (ADR-0028): composite,
  -- leading tenant_id, so PostgreSQL's own (RLS-blind) FK check can never
  -- accept another tenant's party.
  CONSTRAINT customers_party_fkey
    FOREIGN KEY (tenant_id, party_type, id)
    REFERENCES parties (tenant_id, party_type, id)
    ON DELETE RESTRICT,

  CONSTRAINT customers_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customers_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- C1's list query: `q` (prefix of code), `status`, ordered by code ascending
-- (api-contract.md §4.1). The unique constraint above already leads with
-- (tenant_id, code), which is this table's whole access path for the MVP's
-- list volumes; name/phone substring search is a sequential scan under
-- tenant_id in the interim (modules.md §13's "no feature flags" sibling
-- decision: no trigram index is added speculatively).
CREATE INDEX customers_tenant_status_idx ON customers (tenant_id, status);

COMMENT ON TABLE customers IS
  'The customer master (M3-C, first modules/ table). id IS the kernel party id (ADR-0026 statement 4); code is system-generated from the tenant CUST series (M3-Q2) and immutable. Balance is never cached here — read from journal_lines via @finsoft/reporting (K5). Tenant-owned, RLS enabled and forced.';
COMMENT ON COLUMN customers.id IS
  'Equal to the id registerParty(tx, ''CUSTOMER'') returned in the same transaction (ADR-0026 statement 4) — never a fresh gen_random_uuid() at this table.';
COMMENT ON COLUMN customers.code IS
  'System-generated at create from documentNumbers.next(tx, { series: ''CUST'' }) (K7), CUST-000001 style, immutable thereafter (customers_enforce_immutable_identity). The create API accepts no code (M3-Q2).';

CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Identity is immutable: id, tenant_id, party_type, code and the creation
-- authorship never change after insert, for any role. Everything else
-- (name, contact fields, ntn, credit_days, status) is the application's
-- ordinary optimistic-locked UPDATE (BaseRepository.scopedUpdate), so this
-- trigger states only what must NEVER change rather than a full transition
-- table — there is no status machine to enforce here (ACTIVE/INACTIVE is a
-- plain toggle, not a posting document's one-way status column).
-- ---------------------------------------------------------------------------
CREATE FUNCTION customers_enforce_immutable_identity() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.party_type <> OLD.party_type
     OR NEW.code <> OLD.code
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'customers: identity of % is immutable (id, tenant_id, party_type, code, created_at, created_by) — % attempted', OLD.id, TG_OP
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'customers: version must increase on every update (customer %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION customers_enforce_immutable_identity() IS
  'M3-Q2 / ADR-0026 statement 4: a customer''s code and party identity never change after create, for any role including the migration role.';

CREATE TRIGGER customers_enforce_immutable_identity
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_enforce_immutable_identity();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customers
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON customers IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- INSERT is column-scoped and explicitly includes `id` — the one table in
-- the schema so far where the application supplies it (the kernel's party
-- id), rather than leaving it to gen_random_uuid(). UPDATE excludes id,
-- tenant_id, party_type, code, create_idempotency_key and create_fingerprint
-- — the trigger above is the backstop if a future edit ever widens this
-- grant by mistake. DELETE to nobody (rule 4).
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON customers FROM finsoft_app;

GRANT SELECT ON customers TO finsoft_app;
GRANT INSERT (
  tenant_id, id, party_type, code, name, phone, email, address, city, ntn,
  credit_days, status, create_idempotency_key, create_fingerprint,
  created_by, updated_by
) ON customers TO finsoft_app;
GRANT UPDATE (name, phone, email, address, city, ntn, credit_days, status, updated_by, version)
  ON customers TO finsoft_app;

GRANT SELECT ON customers TO readonly_support;
