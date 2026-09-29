-- Owner: modules/receivables
--
-- 016_create_sales_invoices.sql
--
-- Service (non-stock) sales invoices. docs/design/M3/modules.md §7,
-- docs/posting-rules/service-sale.md, ADR-0028 statement 9.
--
-- ---------------------------------------------------------------------------
-- Status machine (service-sale.md §2, ruling R-3; modules.md §5)
--
--     DRAFT --post--> POSTED --reverse--> REVERSED         (terminal)
--       |
--       +---cancel---> CANCELLED                            (terminal)
--
-- `sales_invoices_enforce_transition` below is the ONLY place any of these
-- transitions is permitted. A draft's header and lines may change freely
-- (UpdateInvoiceDraft); once POSTED, every document fact is frozen except
-- the one POSTED -> REVERSED transition's own reversal columns (ADR-0006);
-- CANCELLED and REVERSED are dead ends, for any role, including the
-- migration role.
--
-- ---------------------------------------------------------------------------
-- Numbering (K3, modules.md §10)
--
-- `number` is NULL while DRAFT or CANCELLED and is assigned by
-- `documentNumbers.next(tx, { series: 'INV', occurredAt: invoiceDate })`
-- inside PostInvoice's own transaction, after all validation — a rejected or
-- rolled-back post consumes none (rule 12). The CHECK below ties `number`'s
-- presence to status exactly, so the database itself cannot hold a posted
-- invoice with no number or a draft with one.
--
-- ---------------------------------------------------------------------------
-- Lines are a separate, insert-only table (below): a draft save inserts a
-- complete new revision and bumps `lines_revision`; the current lines are
-- those at `revision = lines_revision`. This keeps money out of jsonb (rule
-- 6) without a DELETE grant.
--
-- ---------------------------------------------------------------------------
-- Outstanding, settlement and the receipts allocated to an invoice are never
-- columns here (modules.md §5 "settlement is derived", §13 "no cached
-- balances") — they are computed from `customer_receipt_allocations`
-- (migration 017) at read time.
--
-- How this is reversed: it is not, in place (ADR-0013, forward-only).
-- ---------------------------------------------------------------------------

CREATE TABLE sales_invoices (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,

  -- Composite FK to modules/customers' own table (S3: tenant_id leads).
  customer_id  uuid        NOT NULL,

  status       text        NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED', 'CANCELLED')),

  number       text        CHECK (number IS NULL OR number ~ '^INV-[0-9]{4}-[0-9]{6,}$'),

  invoice_date date        NOT NULL,
  due_date     date,
  narration    text        CHECK (narration IS NULL OR length(narration) <= 500),

  -- Recomputed server-side on every draft save (§6 of service-sale.md);
  -- > 0 enforced at post, below.
  net_amount   numeric(19,4) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),

  -- Which revision of sales_invoice_lines is "current" (below).
  lines_revision integer   NOT NULL DEFAULT 0 CHECK (lines_revision >= 0),

  posted_at    timestamptz,
  posted_by    uuid,

  reversed_at  timestamptz,
  reversed_by  uuid,
  reversal_reason text     CHECK (reversal_reason IS NULL OR length(btrim(reversal_reason)) BETWEEN 1 AND 500),

  cancelled_at timestamptz,
  cancelled_by uuid,

  create_idempotency_key  text NOT NULL CHECK (create_idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  create_fingerprint      text NOT NULL CHECK (create_fingerprint ~ '^[0-9a-f]{64}$'),
  post_idempotency_key    text CHECK (post_idempotency_key IS NULL OR post_idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  post_fingerprint        text CHECK (post_fingerprint IS NULL OR post_fingerprint ~ '^[0-9a-f]{64}$'),
  reverse_idempotency_key text CHECK (reverse_idempotency_key IS NULL OR reverse_idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  reverse_fingerprint     text CHECK (reverse_fingerprint IS NULL OR reverse_fingerprint ~ '^[0-9a-f]{64}$'),

  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NOT NULL,
  version      integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT sales_invoices_due_after_invoice_date
    CHECK (due_date IS NULL OR due_date >= invoice_date),

  -- number/posted_at/posted_by/post_idempotency_key/post_fingerprint all
  -- appear together, exactly when status is POSTED or REVERSED.
  CONSTRAINT sales_invoices_post_columns_match_status CHECK (
    (status IN ('POSTED', 'REVERSED')) = (number IS NOT NULL)
    AND (status IN ('POSTED', 'REVERSED')) = (posted_at IS NOT NULL)
    AND (status IN ('POSTED', 'REVERSED')) = (posted_by IS NOT NULL)
    AND (status IN ('POSTED', 'REVERSED')) = (post_idempotency_key IS NOT NULL)
    AND (status IN ('POSTED', 'REVERSED')) = (post_fingerprint IS NOT NULL)
  ),
  -- A POSTED invoice has net_amount > 0 (service-sale.md §4 rows 3-6); a
  -- draft may be 0 while empty.
  CONSTRAINT sales_invoices_posted_net_amount_positive
    CHECK (status NOT IN ('POSTED', 'REVERSED') OR net_amount > 0),

  CONSTRAINT sales_invoices_reversal_columns_match_status CHECK (
    (status = 'REVERSED') = (reversed_at IS NOT NULL)
    AND (status = 'REVERSED') = (reversed_by IS NOT NULL)
    AND (status = 'REVERSED') = (reversal_reason IS NOT NULL)
    AND (status = 'REVERSED') = (reverse_idempotency_key IS NOT NULL)
    AND (status = 'REVERSED') = (reverse_fingerprint IS NOT NULL)
  ),
  CONSTRAINT sales_invoices_cancel_columns_match_status CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    AND (status = 'CANCELLED') = (cancelled_by IS NOT NULL)
  ),

  CONSTRAINT sales_invoices_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT sales_invoices_tenant_number_key UNIQUE (tenant_id, number),
  CONSTRAINT sales_invoices_tenant_create_idempotency_key UNIQUE (tenant_id, create_idempotency_key),
  CONSTRAINT sales_invoices_tenant_post_idempotency_key UNIQUE (tenant_id, post_idempotency_key),
  CONSTRAINT sales_invoices_tenant_reverse_idempotency_key UNIQUE (tenant_id, reverse_idempotency_key),

  -- A reference to another module's table, never a write (ADR-0028
  -- statement 9). S3: composite, tenant_id leading.
  CONSTRAINT sales_invoices_customer_fkey
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT sales_invoices_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_invoices_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_invoices_posted_by_fkey
    FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_invoices_reversed_by_fkey
    FOREIGN KEY (tenant_id, reversed_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_invoices_cancelled_by_fkey
    FOREIGN KEY (tenant_id, cancelled_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- I1's filters: customerId (+ status, + open=true oldest-first by
-- invoice_date), and the default invoice_date DESC / number DESC listing
-- (api-contract.md §4.2).
CREATE INDEX sales_invoices_tenant_customer_status_date_idx
  ON sales_invoices (tenant_id, customer_id, status, invoice_date);
CREATE INDEX sales_invoices_tenant_date_number_idx
  ON sales_invoices (tenant_id, invoice_date DESC, number DESC);

COMMENT ON TABLE sales_invoices IS
  'Service (non-stock) sales invoices (M3-P). DRAFT -> POSTED -> REVERSED, or DRAFT -> CANCELLED, enforced by sales_invoices_enforce_transition. Outstanding and settlement are derived from customer_receipt_allocations at read time, never cached here. Tenant-owned, RLS enabled and forced.';
COMMENT ON COLUMN sales_invoices.number IS
  'INV-{FY}-{NNNNNN}, assigned by documentNumbers.next (K3) inside PostInvoice''s own transaction, after validation. NULL while DRAFT/CANCELLED (rule 12: a rejected or rolled-back post consumes none).';

CREATE TRIGGER sales_invoices_set_updated_at
  BEFORE UPDATE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Status-transition and immutability trigger.
-- ---------------------------------------------------------------------------
CREATE FUNCTION sales_invoices_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by
     OR NEW.create_idempotency_key <> OLD.create_idempotency_key
     OR NEW.create_fingerprint <> OLD.create_fingerprint THEN
    RAISE EXCEPTION 'sales_invoices: identity of % is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'sales_invoices: version must increase on every update (invoice %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('POSTED', 'REVERSED', 'CANCELLED') THEN
    IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED' THEN
      -- The ONE permitted change on a non-draft row: POSTED -> REVERSED,
      -- touching only the reversal columns (ADR-0006, reversal.md §5).
      IF NEW.customer_id <> OLD.customer_id OR NEW.number <> OLD.number
         OR NEW.invoice_date <> OLD.invoice_date OR NEW.due_date IS DISTINCT FROM OLD.due_date
         OR NEW.narration IS DISTINCT FROM OLD.narration OR NEW.net_amount <> OLD.net_amount
         OR NEW.lines_revision <> OLD.lines_revision
         OR NEW.posted_at <> OLD.posted_at OR NEW.posted_by <> OLD.posted_by
         OR NEW.post_idempotency_key <> OLD.post_idempotency_key
         OR NEW.post_fingerprint <> OLD.post_fingerprint THEN
        RAISE EXCEPTION 'sales_invoices: reversing % may change only the reversal columns', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'sales_invoices: % is % — no field may change (ADR-0006)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- OLD.status = 'DRAFT' from here.
  IF NEW.status = OLD.status THEN
    -- An ordinary draft edit (UpdateInvoiceDraft): every header field may
    -- change, including customer_id (modules.md §4.1: a changed customer_id
    -- is caught at POST as VERSION_CONFLICT, not blocked at save time).
    RETURN NEW;
  END IF;

  IF NEW.status = 'POSTED' THEN
    RETURN NEW; -- required columns are enforced by the CHECK constraints above.
  END IF;

  IF NEW.status = 'CANCELLED' THEN
    IF NEW.customer_id <> OLD.customer_id OR NEW.net_amount <> OLD.net_amount
       OR NEW.lines_revision <> OLD.lines_revision THEN
      RAISE EXCEPTION 'sales_invoices: cancelling % may not also change its document fields', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'sales_invoices: % -> % is not a permitted transition (invoice %)',
    OLD.status, NEW.status, OLD.id
    USING ERRCODE = 'check_violation';
END;
$fn$;

COMMENT ON FUNCTION sales_invoices_enforce_transition() IS
  'service-sale.md §2 (ruling R-3), modules.md §5: DRAFT -> POSTED -> REVERSED, DRAFT -> CANCELLED, and nothing else, for any role.';

CREATE TRIGGER sales_invoices_enforce_transition
  BEFORE UPDATE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION sales_invoices_enforce_transition();

-- ---------------------------------------------------------------------------
-- sales_invoice_lines — insert-only (modules.md §7).
-- ---------------------------------------------------------------------------
CREATE TABLE sales_invoice_lines (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  invoice_id   uuid        NOT NULL,
  revision     integer     NOT NULL CHECK (revision >= 1),
  line_no      integer     NOT NULL CHECK (line_no >= 1),

  kind         text        NOT NULL DEFAULT 'SERVICE' CHECK (kind = 'SERVICE'),
  description  text        NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  quantity     numeric(19,6) NOT NULL CHECK (quantity > 0),
  unit_price   numeric(19,6) NOT NULL CHECK (unit_price > 0),
  line_net     numeric(19,4) NOT NULL CHECK (line_net > 0),

  -- IMPLEMENTATION §11's mandatory column set, on every tenant-owned table
  -- (modules.md §7 header). updated_at/updated_by/version never change
  -- after insert in practice — there is no UPDATE privilege on this table
  -- for any role (below) — but the columns exist so this table is not a
  -- second, undocumented exemption beside audit_log's reviewed one.
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NOT NULL,
  version      integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT sales_invoice_lines_tenant_invoice_revision_line_key
    UNIQUE (tenant_id, invoice_id, revision, line_no),

  CONSTRAINT sales_invoice_lines_invoice_fkey
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_invoice_lines_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_invoice_lines_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- The current revision's lines, read every time a draft or a posted invoice
-- is shown (api-contract.md §4.2 `Invoice.lines`).
CREATE INDEX sales_invoice_lines_tenant_invoice_revision_idx
  ON sales_invoice_lines (tenant_id, invoice_id, revision);

COMMENT ON TABLE sales_invoice_lines IS
  'Insert-only, revisioned invoice lines (modules.md §7). The CURRENT lines of an invoice are those at revision = sales_invoices.lines_revision — earlier revisions are kept and never read. There is no UPDATE or DELETE privilege on this table for any role — see sales_invoice_lines_enforce_revision.';

-- ---------------------------------------------------------------------------
-- A line insert is allowed only while the parent is DRAFT, and only at
-- exactly lines_revision + 1 — the application then bumps the parent's
-- lines_revision (and net_amount) in a SEPARATE statement, after this
-- insert succeeds (modules.md §7). The FOR UPDATE below takes the parent
-- lock (LOCK_REGISTRY 1c), which the application already holds by the time
-- it writes lines on an existing draft; re-entrant within one transaction.
-- ---------------------------------------------------------------------------
CREATE FUNCTION sales_invoice_lines_enforce_revision() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  parent_status   text;
  parent_revision integer;
BEGIN
  SELECT status, lines_revision INTO parent_status, parent_revision
  FROM sales_invoices
  WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sales_invoice_lines: invoice % was not found for tenant %', NEW.invoice_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'sales_invoice_lines: invoice % is % — lines are insert-only while DRAFT', NEW.invoice_id, parent_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revision <> parent_revision + 1 THEN
    RAISE EXCEPTION 'sales_invoice_lines: revision % does not extend invoice %''s current revision %',
      NEW.revision, NEW.invoice_id, parent_revision
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION sales_invoice_lines_enforce_revision() IS
  'modules.md §7: a line insert is accepted only while the parent invoice is DRAFT and only at lines_revision + 1.';

CREATE TRIGGER sales_invoice_lines_enforce_revision
  BEFORE INSERT ON sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION sales_invoice_lines_enforce_revision();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoices FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sales_invoices
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON sales_invoices IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

ALTER TABLE sales_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoice_lines FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sales_invoice_lines
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON sales_invoice_lines IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants. DELETE to nobody, anywhere (rule 4). sales_invoice_lines has no
-- UPDATE grant either — insert-only (modules.md §7).
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON sales_invoices FROM finsoft_app;

GRANT SELECT ON sales_invoices TO finsoft_app;
GRANT INSERT (
  tenant_id, id, customer_id, status, invoice_date, due_date, narration,
  net_amount, lines_revision, create_idempotency_key, create_fingerprint,
  created_by, updated_by
) ON sales_invoices TO finsoft_app;
GRANT UPDATE (
  customer_id, status, number, invoice_date, due_date, narration, net_amount,
  lines_revision, posted_at, posted_by, reversed_at, reversed_by,
  reversal_reason, cancelled_at, cancelled_by,
  post_idempotency_key, post_fingerprint, reverse_idempotency_key, reverse_fingerprint,
  updated_by, version
) ON sales_invoices TO finsoft_app;

GRANT SELECT ON sales_invoices TO readonly_support;

GRANT SELECT ON sales_invoice_lines TO finsoft_app;
GRANT INSERT (
  tenant_id, id, invoice_id, revision, line_no, kind, description, quantity,
  unit_price, line_net, created_by, updated_by
) ON sales_invoice_lines TO finsoft_app;

GRANT SELECT ON sales_invoice_lines TO readonly_support;
