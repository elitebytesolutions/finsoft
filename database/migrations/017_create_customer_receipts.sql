-- Owner: modules/receivables
--
-- 017_create_customer_receipts.sql
--
-- Customer receipts, their draft allocation proposals, and their posted
-- (LIVE/VOIDED) allocations. docs/design/M3/modules.md §7,
-- docs/posting-rules/customer-receipt.md, ADR-0028 statement 9.
--
-- ---------------------------------------------------------------------------
-- Status machine (customer-receipt.md §1.1, ruling R-1; modules.md §5)
--
--     DRAFT --post--> POSTED --reverse--> REVERSED          (terminal)
--       |
--       +---cancel---> CANCELLED                             (terminal)
--
-- A draft has NO accounting effect: method and amount are nullable while
-- DRAFT and become NOT NULL (by CHECK) once POSTED. Proposed allocations
-- live in a SEPARATE table, `customer_receipt_draft_allocations` — they
-- "reserve nothing" (customer-receipt.md §1.1 rule 3) and are never counted
-- toward any invoice's outstanding. Only `PostReceipt` writes
-- `customer_receipt_allocations`, and only `ReverseReceipt` ever changes a
-- row there again (LIVE -> VOIDED).
--
-- How this is reversed: it is not, in place (ADR-0013, forward-only).
-- ---------------------------------------------------------------------------

CREATE TABLE customer_receipts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,

  -- A draft needs a customer (modules.md §7); composite FK below.
  customer_id  uuid        NOT NULL,

  status       text        NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED', 'CANCELLED')),

  number       text        CHECK (number IS NULL OR number ~ '^RCT-[0-9]{4}-[0-9]{6,}$'),

  receipt_date date        NOT NULL,
  method       text        CHECK (method IS NULL OR method IN ('CASH', 'BANK')),
  amount       numeric(19,4) CHECK (amount IS NULL OR amount > 0),
  reference    text        CHECK (reference IS NULL OR length(reference) <= 100),
  narration    text        CHECK (narration IS NULL OR length(narration) <= 500),

  -- Which revision of customer_receipt_draft_allocations is "current".
  proposals_revision integer NOT NULL DEFAULT 0 CHECK (proposals_revision >= 0),

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

  -- number/posted_at/posted_by/post_idempotency_key/post_fingerprint are
  -- NEVER touched before posting (bidirectional: present iff POSTED or
  -- REVERSED). method/amount are DIFFERENT: customer-receipt.md §1.1 rule 4
  -- lets a DRAFT carry either optional field already ("may be saved
  -- incomplete") — only a ONE-WAY implication holds for them (posted =>
  -- present; present on a draft is fine).
  CONSTRAINT customer_receipts_post_columns_match_status CHECK (
    (status IN ('POSTED', 'REVERSED')) = (number IS NOT NULL)
    AND (status NOT IN ('POSTED', 'REVERSED') OR method IS NOT NULL)
    AND (status NOT IN ('POSTED', 'REVERSED') OR amount IS NOT NULL)
    AND (status IN ('POSTED', 'REVERSED')) = (posted_at IS NOT NULL)
    AND (status IN ('POSTED', 'REVERSED')) = (posted_by IS NOT NULL)
    AND (status IN ('POSTED', 'REVERSED')) = (post_idempotency_key IS NOT NULL)
    AND (status IN ('POSTED', 'REVERSED')) = (post_fingerprint IS NOT NULL)
  ),
  CONSTRAINT customer_receipts_reversal_columns_match_status CHECK (
    (status = 'REVERSED') = (reversed_at IS NOT NULL)
    AND (status = 'REVERSED') = (reversed_by IS NOT NULL)
    AND (status = 'REVERSED') = (reversal_reason IS NOT NULL)
    AND (status = 'REVERSED') = (reverse_idempotency_key IS NOT NULL)
    AND (status = 'REVERSED') = (reverse_fingerprint IS NOT NULL)
  ),
  CONSTRAINT customer_receipts_cancel_columns_match_status CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    AND (status = 'CANCELLED') = (cancelled_by IS NOT NULL)
  ),

  CONSTRAINT customer_receipts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customer_receipts_tenant_number_key UNIQUE (tenant_id, number),
  CONSTRAINT customer_receipts_tenant_create_idempotency_key UNIQUE (tenant_id, create_idempotency_key),
  CONSTRAINT customer_receipts_tenant_post_idempotency_key UNIQUE (tenant_id, post_idempotency_key),
  CONSTRAINT customer_receipts_tenant_reverse_idempotency_key UNIQUE (tenant_id, reverse_idempotency_key),

  CONSTRAINT customer_receipts_customer_fkey
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT customer_receipts_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipts_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipts_posted_by_fkey
    FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipts_reversed_by_fkey
    FOREIGN KEY (tenant_id, reversed_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipts_cancelled_by_fkey
    FOREIGN KEY (tenant_id, cancelled_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- R1's filters: customerId, status(es), method, receiptDate range, default
-- receiptDate DESC / number DESC listing (api-contract.md §4.3).
CREATE INDEX customer_receipts_tenant_customer_status_idx
  ON customer_receipts (tenant_id, customer_id, status);
CREATE INDEX customer_receipts_tenant_date_number_idx
  ON customer_receipts (tenant_id, receipt_date DESC, number DESC);

COMMENT ON TABLE customer_receipts IS
  'Customer receipts (M3-P). DRAFT -> POSTED -> REVERSED, or DRAFT -> CANCELLED, enforced by customer_receipts_enforce_transition. A DRAFT has no GL, allocation or numbering effect (customer-receipt.md §1.1). Tenant-owned, RLS enabled and forced.';
COMMENT ON COLUMN customer_receipts.number IS
  'RCT-{FY}-{NNNNNN}, assigned by documentNumbers.next (K3) inside PostReceipt''s own transaction, after validation. NULL while DRAFT/CANCELLED.';

CREATE TRIGGER customer_receipts_set_updated_at
  BEFORE UPDATE ON customer_receipts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION customer_receipts_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by
     OR NEW.create_idempotency_key <> OLD.create_idempotency_key
     OR NEW.create_fingerprint <> OLD.create_fingerprint THEN
    RAISE EXCEPTION 'customer_receipts: identity of % is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'customer_receipts: version must increase on every update (receipt %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('POSTED', 'REVERSED', 'CANCELLED') THEN
    IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED' THEN
      IF NEW.customer_id <> OLD.customer_id OR NEW.number <> OLD.number
         OR NEW.receipt_date <> OLD.receipt_date OR NEW.method <> OLD.method
         OR NEW.amount <> OLD.amount OR NEW.reference IS DISTINCT FROM OLD.reference
         OR NEW.narration IS DISTINCT FROM OLD.narration
         OR NEW.proposals_revision <> OLD.proposals_revision
         OR NEW.posted_at <> OLD.posted_at OR NEW.posted_by <> OLD.posted_by
         OR NEW.post_idempotency_key <> OLD.post_idempotency_key
         OR NEW.post_fingerprint <> OLD.post_fingerprint THEN
        RAISE EXCEPTION 'customer_receipts: reversing % may change only the reversal columns', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'customer_receipts: % is % — no field may change (ADR-0006)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- OLD.status = 'DRAFT' from here.
  IF NEW.status = OLD.status THEN
    -- UpdateReceiptDraft: every header field may change.
    RETURN NEW;
  END IF;

  IF NEW.status = 'POSTED' THEN
    RETURN NEW; -- required columns are enforced by the CHECK constraints above.
  END IF;

  IF NEW.status = 'CANCELLED' THEN
    IF NEW.customer_id <> OLD.customer_id OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.method IS DISTINCT FROM OLD.method
       OR NEW.proposals_revision <> OLD.proposals_revision THEN
      RAISE EXCEPTION 'customer_receipts: cancelling % may not also change its document fields', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'customer_receipts: % -> % is not a permitted transition (receipt %)',
    OLD.status, NEW.status, OLD.id
    USING ERRCODE = 'check_violation';
END;
$fn$;

COMMENT ON FUNCTION customer_receipts_enforce_transition() IS
  'customer-receipt.md §1.1 (ruling R-1), modules.md §5: DRAFT -> POSTED -> REVERSED, DRAFT -> CANCELLED, and nothing else, for any role.';

CREATE TRIGGER customer_receipts_enforce_transition
  BEFORE UPDATE ON customer_receipts
  FOR EACH ROW EXECUTE FUNCTION customer_receipts_enforce_transition();

-- ---------------------------------------------------------------------------
-- customer_receipt_draft_allocations — insert-only proposals (modules.md
-- §6, §7). PROPOSED in spirit; there is no `status` column because this
-- table holds ONLY proposals — "why proposals are a separate table" (§6).
-- ---------------------------------------------------------------------------
CREATE TABLE customer_receipt_draft_allocations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  receipt_id   uuid        NOT NULL,
  revision     integer     NOT NULL CHECK (revision >= 1),
  invoice_id   uuid        NOT NULL,
  amount       numeric(19,4) NOT NULL CHECK (amount > 0),

  -- IMPLEMENTATION §11's mandatory column set (modules.md §7 header). See
  -- the identical note on sales_invoice_lines, migration 016.
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NOT NULL,
  version      integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT customer_receipt_draft_allocations_tenant_receipt_rev_inv_key
    UNIQUE (tenant_id, receipt_id, revision, invoice_id),

  CONSTRAINT customer_receipt_draft_allocations_receipt_fkey
    FOREIGN KEY (tenant_id, receipt_id) REFERENCES customer_receipts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_draft_allocations_invoice_fkey
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_draft_allocations_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_draft_allocations_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX customer_receipt_draft_allocations_tenant_receipt_rev_idx
  ON customer_receipt_draft_allocations (tenant_id, receipt_id, revision);

COMMENT ON TABLE customer_receipt_draft_allocations IS
  'Insert-only proposed allocations of a receipt DRAFT (modules.md §6-§7). Reserve nothing: never read by any outstanding or Invariant-9 query. The CURRENT proposals are those at revision = customer_receipts.proposals_revision.';

CREATE FUNCTION customer_receipt_draft_allocations_enforce_revision() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  parent_status   text;
  parent_revision integer;
BEGIN
  SELECT status, proposals_revision INTO parent_status, parent_revision
  FROM customer_receipts
  WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_receipt_draft_allocations: receipt % was not found for tenant %', NEW.receipt_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'customer_receipt_draft_allocations: receipt % is % — proposals are insert-only while DRAFT', NEW.receipt_id, parent_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revision <> parent_revision + 1 THEN
    RAISE EXCEPTION 'customer_receipt_draft_allocations: revision % does not extend receipt %''s current revision %',
      NEW.revision, NEW.receipt_id, parent_revision
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION customer_receipt_draft_allocations_enforce_revision() IS
  'modules.md §7: a proposal insert is accepted only while the parent receipt is DRAFT and only at proposals_revision + 1.';

CREATE TRIGGER customer_receipt_draft_allocations_enforce_revision
  BEFORE INSERT ON customer_receipt_draft_allocations
  FOR EACH ROW EXECUTE FUNCTION customer_receipt_draft_allocations_enforce_revision();

-- ---------------------------------------------------------------------------
-- customer_receipt_allocations — real, posted allocations (modules.md §6).
-- Rows are inserted ONLY by PostReceipt, LIVE -> VOIDED ONLY by
-- ReverseReceipt. No PROPOSED status here — that is the whole point of
-- keeping proposals in a separate table (§6).
-- ---------------------------------------------------------------------------
CREATE TABLE customer_receipt_allocations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  receipt_id   uuid        NOT NULL,
  invoice_id   uuid        NOT NULL,
  amount       numeric(19,4) NOT NULL CHECK (amount > 0),
  status       text        NOT NULL DEFAULT 'LIVE' CHECK (status IN ('LIVE', 'VOIDED')),
  voided_at    timestamptz,
  voided_by    uuid,

  -- IMPLEMENTATION §11's mandatory column set (modules.md §7 header). See
  -- the identical note on sales_invoice_lines, migration 016. version DOES
  -- move here: LIVE -> VOIDED is a real UPDATE (below), so this one
  -- actually uses its optimistic-lock column.
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NOT NULL,
  version      integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT customer_receipt_allocations_voided_columns_match_status CHECK (
    (status = 'VOIDED') = (voided_at IS NOT NULL)
    AND (status = 'VOIDED') = (voided_by IS NOT NULL)
  ),

  CONSTRAINT customer_receipt_allocations_tenant_receipt_invoice_key
    UNIQUE (tenant_id, receipt_id, invoice_id),

  CONSTRAINT customer_receipt_allocations_receipt_fkey
    FOREIGN KEY (tenant_id, receipt_id) REFERENCES customer_receipts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_allocations_invoice_fkey
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_allocations_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_allocations_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_allocations_voided_by_fkey
    FOREIGN KEY (tenant_id, voided_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- The outstanding computation: invoice.net_amount - SUM(amount) WHERE
-- invoice_id = ? AND status = 'LIVE' (modules.md §6).
CREATE INDEX customer_receipt_allocations_tenant_invoice_live_idx
  ON customer_receipt_allocations (tenant_id, invoice_id)
  WHERE status = 'LIVE';
CREATE INDEX customer_receipt_allocations_tenant_receipt_idx
  ON customer_receipt_allocations (tenant_id, receipt_id);

COMMENT ON TABLE customer_receipt_allocations IS
  'Posted allocations: "this money settled this invoice" (LIVE) or "it did until the receipt was reversed" (VOIDED) (modules.md §6). Rows are written only by PostReceipt and voided only by ReverseReceipt. Σ LIVE amounts of a POSTED receipt equals its amount, enforced at commit by customer_receipt_allocations_check_sum.';

CREATE TRIGGER customer_receipt_allocations_set_updated_at
  BEFORE UPDATE ON customer_receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION customer_receipt_allocations_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  parent_status text;
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.receipt_id <> OLD.receipt_id
     OR NEW.invoice_id <> OLD.invoice_id OR NEW.amount <> OLD.amount
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'customer_receipt_allocations: identity and amount of % are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'customer_receipt_allocations: version must increase on every update (allocation %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'VOIDED' THEN
    RAISE EXCEPTION 'customer_receipt_allocations: % is already VOIDED', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'VOIDED' THEN
    RAISE EXCEPTION 'customer_receipt_allocations: the only transition is LIVE -> VOIDED (allocation %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT status INTO parent_status FROM customer_receipts
  WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id
  FOR UPDATE;
  IF parent_status NOT IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'customer_receipt_allocations: receipt % is % — allocations void only around a reversal', NEW.receipt_id, parent_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION customer_receipt_allocations_enforce_transition() IS
  'modules.md §5/§6: LIVE -> VOIDED only, only inside ReverseReceipt, never deleted.';

CREATE TRIGGER customer_receipt_allocations_enforce_transition
  BEFORE UPDATE ON customer_receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION customer_receipt_allocations_enforce_transition();

-- ---------------------------------------------------------------------------
-- Deferred constraint trigger: Σ LIVE allocations = receipt.amount, checked
-- at COMMIT so every row PostReceipt inserts in one statement (or every row
-- ReverseReceipt voids) is visible together (modules.md §7: "This is the
-- one subledger rule the database can check for itself, so it does").
-- Skipped while the receipt is not POSTED: a REVERSED receipt's LIVE sum is
-- expected to fall to 0 once every allocation is voided.
-- ---------------------------------------------------------------------------
CREATE FUNCTION customer_receipt_allocations_check_sum() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  receipt_status text;
  receipt_amount numeric(19,4);
  live_sum       numeric(19,4);
BEGIN
  SELECT status, amount INTO receipt_status, receipt_amount
  FROM customer_receipts
  WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id;

  IF receipt_status IS DISTINCT FROM 'POSTED' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO live_sum
  FROM customer_receipt_allocations
  WHERE tenant_id = NEW.tenant_id AND receipt_id = NEW.receipt_id AND status = 'LIVE';

  IF live_sum <> receipt_amount THEN
    RAISE EXCEPTION 'customer_receipt_allocations: receipt % LIVE allocations sum to %, not its amount %',
      NEW.receipt_id, live_sum, receipt_amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION customer_receipt_allocations_check_sum() IS
  'modules.md §7: deferred to COMMIT so a multi-row PostReceipt insert (or ReverseReceipt void) is checked as a whole.';

CREATE CONSTRAINT TRIGGER customer_receipt_allocations_check_sum
  AFTER INSERT OR UPDATE ON customer_receipt_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION customer_receipt_allocations_check_sum();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE customer_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_receipts FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_receipts
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
COMMENT ON POLICY tenant_isolation ON customer_receipts IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

ALTER TABLE customer_receipt_draft_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_receipt_draft_allocations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_receipt_draft_allocations
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
COMMENT ON POLICY tenant_isolation ON customer_receipt_draft_allocations IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

ALTER TABLE customer_receipt_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_receipt_allocations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_receipt_allocations
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
COMMENT ON POLICY tenant_isolation ON customer_receipt_allocations IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants. DELETE to nobody, anywhere (rule 4). Proposals are insert-only.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON customer_receipts FROM finsoft_app;

GRANT SELECT ON customer_receipts TO finsoft_app;
GRANT INSERT (
  tenant_id, id, customer_id, status, receipt_date, method, amount,
  reference, narration, proposals_revision, create_idempotency_key,
  create_fingerprint, created_by, updated_by
) ON customer_receipts TO finsoft_app;
GRANT UPDATE (
  customer_id, status, number, receipt_date, method, amount, reference,
  narration, proposals_revision, posted_at, posted_by, reversed_at,
  reversed_by, reversal_reason, cancelled_at, cancelled_by,
  post_idempotency_key, post_fingerprint, reverse_idempotency_key,
  reverse_fingerprint, updated_by, version
) ON customer_receipts TO finsoft_app;

GRANT SELECT ON customer_receipts TO readonly_support;

GRANT SELECT ON customer_receipt_draft_allocations TO finsoft_app;
GRANT INSERT (
  tenant_id, id, receipt_id, revision, invoice_id, amount, created_by, updated_by
) ON customer_receipt_draft_allocations TO finsoft_app;
GRANT SELECT ON customer_receipt_draft_allocations TO readonly_support;

GRANT SELECT ON customer_receipt_allocations TO finsoft_app;
GRANT INSERT (
  tenant_id, id, receipt_id, invoice_id, amount, status, created_by, updated_by
) ON customer_receipt_allocations TO finsoft_app;
GRANT UPDATE (status, voided_at, voided_by, updated_by, version) ON customer_receipt_allocations TO finsoft_app;
GRANT SELECT ON customer_receipt_allocations TO readonly_support;
