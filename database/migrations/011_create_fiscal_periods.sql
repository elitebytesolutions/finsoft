-- 011_create_fiscal_periods.sql
--
-- The MVP fiscal calendar. docs/posting-rules/periods.md (PERIODS/monthly-v1,
-- PERIOD_CLOSED@1), ADR-0012 (fiscal period locking), NON_NEGOTIABLES rule 5,
-- Invariant 5.
--
-- Twelve monthly periods per fiscal year, per tenant, contiguous and
-- non-overlapping (periods.md §1). Default fiscal year 1 July - 30 June,
-- labelled by the calendar year it ENDS (periods.md §2): 1 July 2026 -
-- 30 June 2027 is FY2027, matching the FBR "tax year 2027" convention.
--
-- ADR-0012: "there is no system bypass" — every posting, reversal, job,
-- import and admin script resolves to a period and is rejected if it is not
-- OPEN. That check lives twice: in the posting engine (packages/
-- accounting-kernel), and here, as a trigger on journal_entries added in
-- migration 012 (the last line — periods.md §7 and this file's own header
-- reference it, but the trigger itself has to live where journal_entries
-- does).
--
-- ---------------------------------------------------------------------------
-- The transition trigger, in one place
--
-- periods.md §4 and §4.1, exactly:
--
--   OPEN   -> CLOSED   only if every EARLIER period of the tenant is
--                       CLOSED or LOCKED                  (PERIOD_CLOSE_OUT_OF_ORDER)
--   CLOSED -> OPEN      only if no LATER period is CLOSED or LOCKED
--                       (reopen; reason required)          (PERIOD_REOPEN_OUT_OF_ORDER)
--   CLOSED -> LOCKED    only if every EARLIER period is LOCKED
--                       (PERIOD_LOCK_OUT_OF_ORDER)
--   LOCKED -> anything  never, for any role including migration
--
-- The "earlier"/"later" reads take FOR SHARE before counting (PERFORM ...
-- FOR SHARE followed by a separate, lock-clause-free SELECT count(*) — an
-- aggregate cannot itself carry a locking clause in PostgreSQL). This closes
-- the same race migration 009's audit_log_enforce_linkage documents: two
-- concurrent closes of adjacent periods must not both read "is the other one
-- closed yet?" as false and proceed. FOR SHARE needs UPDATE privilege on this
-- table under finsoft_app, which the close/reopen/lock grants below already
-- supply — no separate column-scoped grant is needed here the way audit_log
-- needed one.
-- ---------------------------------------------------------------------------
--
-- Lock footprint: CREATE TABLE locks nothing beyond the tenant_id foreign
-- key (SHARE ROW EXCLUSIVE on `tenants`, transaction-scoped). The exclusion
-- constraint below requires btree_gist; installing an extension takes an
-- ACCESS EXCLUSIVE lock on nothing but its own catalog entry — there is no
-- existing table it touches.
--
-- How this is reversed: it is not, in place (ADR-0013, forward-only).
-- ---------------------------------------------------------------------------

-- Needed for the EXCLUDE constraint below: a GiST index over a uuid equality
-- column plus a range overlap needs the operator classes btree_gist adds for
-- non-range types. Without it `tenant_id WITH =` has no GiST operator class
-- and CREATE TABLE fails outright, not silently.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE fiscal_periods (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,

  -- The calendar year the fiscal year ENDS in (periods.md §2). Immutable
  -- once created — enforced by the transition trigger below.
  fiscal_year    integer     NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 9999),

  -- 1..12, chronological within the fiscal year (1 = the first month after
  -- fiscal_year_start_month, e.g. July for the default calendar).
  period_index   smallint    NOT NULL CHECK (period_index BETWEEN 1 AND 12),

  period_start   date        NOT NULL,
  period_end     date        NOT NULL CHECK (period_end >= period_start),

  -- The ISO month, periods.md §2: '2026-07' .. '2027-06'.
  label          text        NOT NULL CHECK (label ~ '^\d{4}-(0[1-9]|1[0-2])$'),

  status         text        NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN', 'CLOSED', 'LOCKED')),

  closed_at      timestamptz,
  closed_by      uuid,
  -- Reopen is audited with a reason (ADR-0012). Cleared is never legal once
  -- set — reopened_at/reopened_by record the MOST RECENT reopen only; the
  -- full history lives in audit_log, which is append-only and this is not.
  reopened_at    timestamptz,
  reopened_by    uuid,
  reopen_reason  text        CHECK (reopen_reason IS NULL OR length(btrim(reopen_reason)) BETWEEN 1 AND 500),
  locked_at      timestamptz,
  locked_by      uuid,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  version        integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT fiscal_periods_closed_requires_stamp
    CHECK (status = 'OPEN' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  CONSTRAINT fiscal_periods_locked_requires_stamp
    CHECK (status <> 'LOCKED' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
  CONSTRAINT fiscal_periods_reopen_pair
    CHECK ((reopened_at IS NULL) = (reopened_by IS NULL)),
  CONSTRAINT fiscal_periods_reopen_has_reason
    CHECK (reopened_at IS NULL OR reopen_reason IS NOT NULL),

  CONSTRAINT fiscal_periods_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_periods_tenant_fy_index_key UNIQUE (tenant_id, fiscal_year, period_index),
  CONSTRAINT fiscal_periods_tenant_label_key UNIQUE (tenant_id, label),

  -- Contiguity (no gap, no overlap) is asserted by createFiscalYear at
  -- creation time (packages/database/src/accounting/periods.ts) — twelve
  -- rows inserted together, each starting the day after the previous ends.
  -- This exclusion constraint is the declarative backstop against any INSERT
  -- path, present or future, producing two overlapping ranges for the same
  -- tenant.
  CONSTRAINT fiscal_periods_no_overlap
    EXCLUDE USING gist (tenant_id WITH =, daterange(period_start, period_end, '[]') WITH &&),

  CONSTRAINT fiscal_periods_closed_by_fkey
    FOREIGN KEY (tenant_id, closed_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fiscal_periods_reopened_by_fkey
    FOREIGN KEY (tenant_id, reopened_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fiscal_periods_locked_by_fkey
    FOREIGN KEY (tenant_id, locked_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fiscal_periods_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fiscal_periods_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- The posting-time lookup: "which period contains this date" (periods.md
-- §1), and the order-check reads inside the transition trigger below both
-- filter on (tenant_id, period_start) — this index serves both.
CREATE INDEX fiscal_periods_tenant_start_idx ON fiscal_periods (tenant_id, period_start);
CREATE INDEX fiscal_periods_tenant_status_idx ON fiscal_periods (tenant_id, status);

COMMENT ON TABLE fiscal_periods IS
  'PERIODS/monthly-v1, PERIOD_CLOSED@1 (docs/posting-rules/periods.md). Twelve monthly periods per fiscal year per tenant. Tenant-owned, RLS enabled and forced.';
COMMENT ON COLUMN fiscal_periods.fiscal_year IS
  'The calendar year the fiscal year ENDS in (periods.md §2) — 1 Jul 2026-30 Jun 2027 is FY2027.';
COMMENT ON COLUMN fiscal_periods.status IS
  'OPEN -> CLOSED -> LOCKED. CLOSED may reopen to OPEN (reason required). LOCKED never transitions again, for any role (ADR-0012).';

CREATE TRIGGER fiscal_periods_set_updated_at
  BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Transition enforcement — see the file header for the rules this encodes.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fiscal_periods_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  blocking_count integer;
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.fiscal_year <> OLD.fiscal_year OR NEW.period_index <> OLD.period_index
     OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end
     OR NEW.label <> OLD.label
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'fiscal_periods: identity and calendar fields are immutable (period %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'fiscal_periods: version must increase on every update (period %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'LOCKED' THEN
    RAISE EXCEPTION 'fiscal_periods: % is LOCKED. No transition out, for any role, ever (ADR-0012).', OLD.label
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = OLD.status THEN
    -- Every mutable column is a transition stamp; there is no legitimate
    -- UPDATE that leaves status unchanged. Rejected outright: the pairing
    -- CHECKs alone would NOT catch, for example, a CLOSED period's
    -- closed_by being rewritten to a different user with no transition —
    -- a silent edit of who closed the books.
    RAISE EXCEPTION 'fiscal_periods: an update must be a status transition (period %, status %)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Each transition writes only its own stamps. Anything else changing
  -- alongside it is an edit of history, not part of the transition.
  IF NEW.status <> 'OPEN'
     AND (NEW.reopened_at IS DISTINCT FROM OLD.reopened_at
          OR NEW.reopened_by IS DISTINCT FROM OLD.reopened_by
          OR NEW.reopen_reason IS DISTINCT FROM OLD.reopen_reason) THEN
    RAISE EXCEPTION 'fiscal_periods: only a reopen may write the reopen stamps (period %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'LOCKED'
     AND (NEW.locked_at IS DISTINCT FROM OLD.locked_at
          OR NEW.locked_by IS DISTINCT FROM OLD.locked_by) THEN
    RAISE EXCEPTION 'fiscal_periods: only a lock may write the lock stamps (period %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'OPEN' AND NEW.status = 'CLOSED' THEN
    PERFORM 1 FROM fiscal_periods
      WHERE tenant_id = NEW.tenant_id AND period_start < NEW.period_start
      FOR SHARE;
    SELECT count(*) INTO blocking_count FROM fiscal_periods
      WHERE tenant_id = NEW.tenant_id AND period_start < NEW.period_start AND status = 'OPEN';
    IF blocking_count > 0 THEN
      RAISE EXCEPTION 'fiscal_periods: cannot close % — an earlier period is still OPEN (PERIOD_CLOSE_OUT_OF_ORDER)', NEW.label
        USING ERRCODE = 'check_violation';
    END IF;

  ELSIF OLD.status = 'CLOSED' AND NEW.status = 'OPEN' THEN
    PERFORM 1 FROM fiscal_periods
      WHERE tenant_id = NEW.tenant_id AND period_start > NEW.period_start
      FOR SHARE;
    SELECT count(*) INTO blocking_count FROM fiscal_periods
      WHERE tenant_id = NEW.tenant_id AND period_start > NEW.period_start AND status IN ('CLOSED', 'LOCKED');
    IF blocking_count > 0 THEN
      RAISE EXCEPTION 'fiscal_periods: cannot reopen % — a later period is CLOSED or LOCKED (PERIOD_REOPEN_OUT_OF_ORDER)', NEW.label
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reopened_at IS NULL OR NEW.reopened_by IS NULL OR NEW.reopen_reason IS NULL THEN
      RAISE EXCEPTION 'fiscal_periods: reopening % requires reopened_at, reopened_by and a reason', NEW.label
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.closed_at IS NOT NULL OR NEW.closed_by IS NOT NULL THEN
      RAISE EXCEPTION 'fiscal_periods: reopening % must clear closed_at/closed_by', NEW.label
        USING ERRCODE = 'check_violation';
    END IF;

  ELSIF OLD.status = 'CLOSED' AND NEW.status = 'LOCKED' THEN
    PERFORM 1 FROM fiscal_periods
      WHERE tenant_id = NEW.tenant_id AND period_start < NEW.period_start
      FOR SHARE;
    SELECT count(*) INTO blocking_count FROM fiscal_periods
      WHERE tenant_id = NEW.tenant_id AND period_start < NEW.period_start AND status <> 'LOCKED';
    IF blocking_count > 0 THEN
      RAISE EXCEPTION 'fiscal_periods: cannot lock % — an earlier period is not LOCKED (PERIOD_LOCK_OUT_OF_ORDER)', NEW.label
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.locked_at IS NULL OR NEW.locked_by IS NULL THEN
      RAISE EXCEPTION 'fiscal_periods: locking % requires locked_at and locked_by', NEW.label
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closed_by IS DISTINCT FROM OLD.closed_by THEN
      RAISE EXCEPTION 'fiscal_periods: locking % must not alter its original closed_at/closed_by', NEW.label
        USING ERRCODE = 'check_violation';
    END IF;

  ELSE
    RAISE EXCEPTION 'fiscal_periods: % -> % is not a permitted transition (period %)',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION fiscal_periods_enforce_transition() IS
  'ADR-0012, periods.md §4/§4.1. The database-level backstop: OPEN<->CLOSED->LOCKED only, in calendar order, LOCKED is terminal. Order checks read sibling periods FOR SHARE before counting (PostgreSQL forbids a locking clause on an aggregate query) — same doctrine as audit_log_enforce_linkage (migration 009).';

CREATE TRIGGER fiscal_periods_enforce_transition
  BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION fiscal_periods_enforce_transition();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE fiscal_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_periods FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON fiscal_periods
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON fiscal_periods IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- UPDATE is column-scoped to exactly the transition fields: a close, reopen
-- or lock changes status and its own stamp, never the calendar fields — the
-- trigger above is the belt, this grant is the braces. DELETE to nobody
-- (rule 4; periods are never removed, only locked).
--
-- INSERT is revoked as well as UPDATE: the default privileges grant both at
-- table level (008's lesson), and table-level INSERT would let a caller
-- create a period born CLOSED or LOCKED, or stamp its own id/version.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON fiscal_periods FROM finsoft_app;

GRANT SELECT ON fiscal_periods TO finsoft_app;
GRANT INSERT (
  tenant_id, fiscal_year, period_index, period_start, period_end, label,
  created_by, updated_by
) ON fiscal_periods TO finsoft_app;
GRANT UPDATE (
  status, closed_at, closed_by, reopened_at, reopened_by, reopen_reason,
  locked_at, locked_by, updated_at, updated_by, version
) ON fiscal_periods TO finsoft_app;

GRANT SELECT ON fiscal_periods TO readonly_support;
