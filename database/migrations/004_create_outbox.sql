-- 004_create_outbox.sql
--
-- The transactional outbox. ADR-0010.
--
-- Every side effect that touches anything outside the database is written as
-- a row HERE, inside the posting transaction, and dispatched by the worker
-- after that transaction commits. Emails, PDFs, FBR pushes, webhooks and
-- cache invalidation all arrive this way.
--
-- The property this table exists to give:
--
--   the business fact and the intent to act on it become true TOGETHER,
--   or neither does.
--
-- An email sent from inside a transaction that then rolls back cannot be
-- recalled. A row written in that transaction simply never existed.
--
-- Follows the 002_create_users.sql template in full:
--
--   ADR-0003  tenant_id uuid NOT NULL REFERENCES tenants(id)
--             an index whose FIRST column is tenant_id
--   ADR-0004  ENABLE *and* FORCE row level security, one policy, with both
--             USING and a non-null WITH CHECK
--   rule 4    no hard delete: status, never DELETE; no DELETE grant
--
-- How this is reversed: it is not, in place. Migrations are forward-only
-- (ADR-0013); undoing this means a later numbered migration.

CREATE TABLE outbox (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ADR-0003. An outbox row is tenant-owned like everything else: a
  -- dispatcher must never be able to read another tenant's pending effects,
  -- and the payload routinely names a customer or an invoice.
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,

  -- INVOICE_EMAIL, FBR_POS_PUSH, CACHE_INVALIDATED, … Deliberately text with
  -- a CHECK on shape rather than an enum: adding a topic must not require a
  -- migration that locks the table, and a typo is still caught.
  topic           text        NOT NULL,

  -- IDENTIFIERS AND MINIMAL FACTS ONLY. ADR-0010 is explicit: `{saleId,
  -- invoiceId}`, never `{amount, accountId}`. The dispatcher re-reads the
  -- committed row, so a payload can never disagree with the ledger and no
  -- financial truth sits in a queue waiting to go stale.
  payload         jsonb       NOT NULL,

  -- Business time: when the thing happened. Distinct from created_at, which
  -- is when the row was written, and from available_at, which is scheduling.
  occurred_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- When the dispatcher may next attempt it. Backoff moves this forward; it
  -- is not a "retry count" masquerading as a timestamp.
  available_at    timestamptz NOT NULL DEFAULT now(),

  status          text        NOT NULL DEFAULT 'PENDING',
  attempts        integer     NOT NULL DEFAULT 0,

  -- Sanitised. Rule 20: a driver error carries host, port, database and role,
  -- and this column is readable by support.
  last_error      text,
  dispatched_at   timestamptz,

  -- ADR-0010 and INFRASTRUCTURE §8. The request id that produced the row,
  -- propagated end to end so a trace survives the queue hop. NOT NULL because
  -- a row without one produces log lines nobody can join to a request.
  correlation_id  text        NOT NULL,

  CONSTRAINT outbox_status_check
    CHECK (status IN ('PENDING', 'IN_FLIGHT', 'DONE', 'FAILED')),

  -- A topic is SCREAMING_SNAKE_CASE, matching the business-event convention
  -- in packages/observability. Catches a typo at write time rather than at
  -- dispatch time, when the transaction has long since committed.
  CONSTRAINT outbox_topic_shape
    CHECK (topic ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$'),

  CONSTRAINT outbox_attempts_nonneg
    CHECK (attempts >= 0),

  -- dispatched_at is set when and only when the row reaches DONE. Without
  -- this the two drift and neither can be trusted to answer "was it sent".
  CONSTRAINT outbox_dispatched_at_matches_status
    CHECK ((status = 'DONE') = (dispatched_at IS NOT NULL))
);

COMMENT ON TABLE outbox IS
  'ADR-0010 transactional outbox. Rows are written INSIDE the posting transaction and dispatched after it commits. Payload carries identifiers, never financial truth.';

-- ---------------------------------------------------------------------------
-- Indexes
--
-- ADR-0003 requires tenant_id first on every index of a tenant-owned table.
-- ---------------------------------------------------------------------------

-- The dispatcher's only query. PARTIAL, so it indexes pending work alone: the
-- table is append-mostly and rows stay forever (rule 4), so an index over all
-- statuses would grow without bound while the useful part stayed small.
CREATE INDEX outbox_pending_idx
  ON outbox (tenant_id, available_at)
  WHERE status = 'PENDING';

-- Operational: "what has failed", which is a real condition someone has to
-- look at rather than a metric. Also partial, for the same reason.
CREATE INDEX outbox_failed_idx
  ON outbox (tenant_id, created_at)
  WHERE status = 'FAILED';

CREATE INDEX outbox_correlation_idx ON outbox (tenant_id, correlation_id);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- ENABLE turns policies on for ordinary roles. FORCE applies them to the
-- table's OWNER too. Without FORCE the owner silently sees every tenant, and
-- ADR-0004:46 treats ENABLE-without-FORCE as unprotected.
--
-- current_setting('app.tenant_id') WITHOUT the missing_ok flag, deliberately:
-- unset must RAISE. With `true` it returns NULL, the comparison becomes NULL,
-- and a loud failure turns into a silent zero-row read that reads as "nothing
-- to dispatch" rather than "no tenant context".
-- ---------------------------------------------------------------------------
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON outbox
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON outbox IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- Restated rather than left to the cluster default privileges, so a reader of
-- this file need not know what the container init script did.
--
-- UPDATE is granted because the dispatcher must move a row through its
-- lifecycle. DELETE is granted to nobody: rule 4, and a dispatched outbox row
-- is the evidence that a side effect was requested.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON outbox TO finsoft_app;
GRANT SELECT                 ON outbox TO readonly_support;
