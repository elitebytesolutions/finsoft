-- 013_create_document_sequences.sql
--
-- Server-side document numbering. NON_NEGOTIABLES rule 12 ("Forbidden:
-- MAX(id) + 1, client-generated numbers, application-side counters without a
-- lock"), docs/posting-rules/README.md §4 ("Numbering"), PO decision K7
-- (2026-09-28).
--
-- Two scopes of counter:
--
--   FISCAL_YEAR  one counter per (tenant, series, fiscal year), reset each
--                year: JV, RV, JE from M2; INV, RCT from M3.
--                Formatted SERIES-FY-NNNNNN, e.g. JV-2027-000001.
--   TENANT       one counter per (tenant, series) for the life of the
--                tenant (K7): customer codes, CUST-000001, from M3.
--                Formatted SERIES-NNNNNN.
--
-- fiscal_year is NOT NULL exactly when scope = 'FISCAL_YEAR'
-- (document_sequences_scope_shape). Uniqueness is two PARTIAL unique indexes
-- rather than one UNIQUE ... NULLS NOT DISTINCT — deliberately portable, and
-- each is a precise ON CONFLICT arbiter for its scope's UPSERT
-- (packages/database/src/accounting/sequences.ts). A series is bound to ONE
-- scope per tenant (document_sequences_series_single_scope): without it,
-- CUST could exist both as a life-of-tenant row and as per-year rows, and
-- two code paths would hand out overlapping CUST numbers.
--
-- ---------------------------------------------------------------------------
-- Why an UPSERT, not a PostgreSQL SEQUENCE
--
-- A SEQUENCE per (tenant, series[, year]) would be created dynamically —
-- DDL on the posting path. One row per counter, incremented by
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING, takes the same row lock an
-- explicit SELECT ... FOR UPDATE would: two concurrent callers for the same
-- counter serialise on the conflicting row (including the first-ever call,
-- where both race to INSERT and the loser waits on the winner's index entry
-- and then takes the UPDATE path). Gaps are acceptable (a rolled-back
-- posting consumes a number, README §4); duplicates are not — and the
-- unique constraints on the numbered documents themselves
-- (journal_entries_tenant_number_key) are the backstop.
--
-- `last_number` is the number most recently handed out. A new row is born
-- with DEFAULT 1 — its insertion IS the assignment of number 1 — and every
-- later call increments it and returns the new value. It is not
-- INSERT-granted: no caller can seed a counter to an arbitrary value
-- (legacy-number continuity for Wave 10 imports is a migration-role
-- operation, reviewed as a data migration).
--
-- Lock footprint: CREATE TABLE locks only its foreign-key targets (SHARE ROW
-- EXCLUSIVE on tenants and users, transaction-scoped). The runtime row lock
-- is registered in docs/LOCK_REGISTRY.md at position 5b.
--
-- How this is reversed: it is not, in place (ADR-0013, forward-only).
-- ---------------------------------------------------------------------------

CREATE TABLE document_sequences (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,

  series       text        NOT NULL CHECK (series ~ '^[A-Z]{2,10}$'),
  scope        text        NOT NULL CHECK (scope IN ('FISCAL_YEAR', 'TENANT')),
  fiscal_year  integer     CHECK (fiscal_year BETWEEN 2000 AND 9999),

  -- The number most recently assigned. Born 1: inserting the row assigns 1.
  last_number  bigint      NOT NULL DEFAULT 1 CHECK (last_number >= 1),

  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NOT NULL,
  version      integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  -- K7: a FISCAL_YEAR counter names its year; a TENANT counter never does.
  CONSTRAINT document_sequences_scope_shape
    CHECK (
         (scope = 'FISCAL_YEAR' AND fiscal_year IS NOT NULL)
      OR (scope = 'TENANT'      AND fiscal_year IS NULL)
    ),

  CONSTRAINT document_sequences_tenant_id_id_key UNIQUE (tenant_id, id),

  -- One scope per series per tenant. btree_gist is installed by 011.
  CONSTRAINT document_sequences_series_single_scope
    EXCLUDE USING gist (tenant_id WITH =, series WITH =, scope WITH <>),

  CONSTRAINT document_sequences_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_sequences_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- The two ON CONFLICT arbiters — one per scope. These rows ARE the lock.
CREATE UNIQUE INDEX document_sequences_tenant_series_fy_key
  ON document_sequences (tenant_id, series, fiscal_year) WHERE fiscal_year IS NOT NULL;
CREATE UNIQUE INDEX document_sequences_tenant_series_key
  ON document_sequences (tenant_id, series) WHERE fiscal_year IS NULL;

COMMENT ON TABLE document_sequences IS
  'Server-side document numbering (rule 12, K7). One counter per tenant/series/fiscal year (scope FISCAL_YEAR) or per tenant/series for life (scope TENANT), incremented via INSERT ... ON CONFLICT DO UPDATE (packages/database/src/accounting/sequences.ts) — never MAX(id)+1. Tenant-owned, RLS enabled and forced.';
COMMENT ON COLUMN document_sequences.last_number IS
  'The number most recently assigned. Gaps are acceptable (a rolled-back posting consumes a number); duplicates are not.';

-- The counter row is only ever advanced; the transition trigger keeps it
-- that way for every role, not just finsoft_app's column grant.
CREATE FUNCTION document_sequences_enforce_advance() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.series <> OLD.series
     OR NEW.scope <> OLD.scope OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'document_sequences: identity of counter % is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.last_number <= OLD.last_number THEN
    RAISE EXCEPTION 'document_sequences: counter % may only advance (% -> %) — a lower value reissues numbers (rule 12)', OLD.id, OLD.last_number, NEW.last_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_sequences_enforce_advance
  BEFORE UPDATE ON document_sequences
  FOR EACH ROW EXECUTE FUNCTION document_sequences_enforce_advance();

CREATE TRIGGER document_sequences_set_updated_at
  BEFORE UPDATE ON document_sequences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_sequences FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON document_sequences
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON document_sequences IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- INSERT, UPDATE and SELECT are all needed by the UPSERT (ON CONFLICT DO
-- UPDATE requires SELECT on the arbiter columns). INSERT is column-scoped
-- and excludes last_number (see the header). The REVOKE covers INSERT as
-- well as UPDATE — 008's lesson, missed by this file's first draft. DELETE
-- to nobody (rule 4).
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON document_sequences FROM finsoft_app;

GRANT SELECT ON document_sequences TO finsoft_app;
GRANT INSERT (tenant_id, series, scope, fiscal_year, created_by, updated_by)
  ON document_sequences TO finsoft_app;
GRANT UPDATE (last_number, updated_at, updated_by, version)
  ON document_sequences TO finsoft_app;

GRANT SELECT ON document_sequences TO readonly_support;
