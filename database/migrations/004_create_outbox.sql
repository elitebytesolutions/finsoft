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
-- Follows the 002_create_users.sql template: the mandatory column set in
-- full (IMPLEMENTATION §11), composite authorship foreign keys, ENABLE and
-- FORCE row level security with both USING and WITH CHECK, no DELETE grant
-- to anyone (rule 4), and COMMENTs on the columns whose meaning is not
-- obvious from the name.
--
-- ---------------------------------------------------------------------------
-- Lock footprint
--
-- The `tenant_id` foreign key takes SHARE ROW EXCLUSIVE on `tenants` for the
-- duration of this transaction, which blocks WRITES to `tenants` — not merely
-- DDL. The authorship foreign keys take the same on `users`. Both tables are
-- near-empty in Wave 0, so this is microseconds; it would not be on a live
-- system, and a later migration adding a foreign key to a large table must
-- say so here in its own header.
--
-- Nothing existing is altered. The runner wraps this file in one transaction,
-- so an aborted apply leaves nothing behind. Plain CREATE INDEX is correct:
-- the table is created empty in this same transaction, and CONCURRENTLY
-- cannot run inside a transaction block at all.
--
-- How this is reversed: it is not, in place. Migrations are forward-only
-- (ADR-0013); undoing this means a later numbered migration that drops the
-- table, which the verifier flags as destructive.
-- ---------------------------------------------------------------------------

CREATE TABLE outbox (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ADR-0003. An outbox row is tenant-owned like everything else: a
  -- dispatcher must never read another tenant's pending effects, and the
  -- payload routinely names a customer or an invoice.
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,

  -- INVOICE_EMAIL, FBR_POS_PUSH, CACHE_INVALIDATED, … Text with a shape
  -- CHECK rather than an enum: adding a topic must not require a migration
  -- that locks the table, and a typo is still caught.
  topic           text        NOT NULL,

  -- IDENTIFIERS AND MINIMAL FACTS ONLY. ADR-0010 is explicit: `{saleId,
  -- invoiceId}`, never `{amount, accountId}`. The dispatcher re-reads the
  -- committed row, so a payload can never disagree with the ledger and no
  -- financial truth sits in a queue going stale.
  payload         jsonb       NOT NULL,

  -- Business time: when the thing happened. Distinct from created_at, which
  -- is when the row was written.
  --
  -- Rule 13: the server never uses the client's clock. Nothing in a column
  -- type can enforce that, so it is stated as the obligation it is — the
  -- posting path sets this from server time or from a business date the
  -- domain owns, never from a value a request supplied.
  occurred_at     timestamptz NOT NULL,

  -- When the dispatcher may next attempt it. Backoff moves this forward; it
  -- is not a retry count wearing a timestamp's clothes.
  available_at    timestamptz NOT NULL DEFAULT now(),

  status          text        NOT NULL DEFAULT 'PENDING',
  attempts        integer     NOT NULL DEFAULT 0,

  -- Set when and only when a dispatcher claims the row. This is what makes
  -- IN_FLIGHT recoverable rather than terminal — see the reaper note below.
  claimed_at      timestamptz,

  -- Sanitised BEFORE it is written, by `redactError` in
  -- packages/observability: a driver error carries host, port, database and
  -- role, and a 401 body can carry a bearer token. This column is readable by
  -- readonly_support and is in every backup, so an unsanitised write here is
  -- a rule 20 breach that outlives the incident that caused it.
  --
  -- The length bound is a second line of defence, not the control: it bounds
  -- the blast radius of a redactor that misses something.
  last_error      text,
  dispatched_at   timestamptz,

  -- ADR-0010 and INFRASTRUCTURE §8. The request id that produced the row,
  -- propagated end to end so a trace survives the queue hop.
  --
  -- uuid, not text: request ids are randomUUID() (packages/observability
  -- context.ts), and the type rejects the empty string for free — which a
  -- NOT NULL text column does not, and an empty correlation id produces
  -- exactly the unjoinable log line this column exists to prevent.
  correlation_id  uuid        NOT NULL,

  -- ---------------------------------------------------------------------
  -- The mandatory column set. IMPLEMENTATION §11.
  -- ---------------------------------------------------------------------
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,

  -- Optimistic locking. Bumped by the application in its UPDATE's WHERE
  -- clause, never by a trigger — a trigger would make the version a record of
  -- writes rather than a concurrency check.
  version         integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT outbox_status_check
    CHECK (status IN ('PENDING', 'IN_FLIGHT', 'DONE', 'FAILED')),

  -- Single-word topics are legal. An earlier version required at least one
  -- underscore, which rejected PING and RESYNC and would have cost a
  -- migration to allow — the exact cost the text-with-a-CHECK design avoids.
  --
  -- This is NOT tied to the business-event vocabulary in
  -- packages/observability. SALE_POSTED is a log event; INVOICE_EMAIL is a
  -- dispatch topic. They look alike and are not the same list.
  CONSTRAINT outbox_topic_shape
    CHECK (topic ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$' AND length(topic) BETWEEN 3 AND 64),

  -- NOT NULL alone admits 'null'::jsonb, a bare scalar and an array, all of
  -- which satisfy the column and none of which is a payload.
  CONSTRAINT outbox_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object'),

  CONSTRAINT outbox_attempts_nonneg
    CHECK (attempts >= 0),

  CONSTRAINT outbox_last_error_bounded
    CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 2000),

  -- claimed_at exists exactly while the row is claimed. This is what the
  -- reaper keys on, and keeping the biconditional means a row cannot be
  -- IN_FLIGHT without a lease to expire.
  CONSTRAINT outbox_claimed_at_matches_status
    CHECK ((status = 'IN_FLIGHT') = (claimed_at IS NOT NULL)),

  -- dispatched_at is set when and only when the row reaches DONE.
  --
  -- This deliberately forbids resetting a DONE row to PENDING for replay
  -- (ADR-0010:121), because doing so would null dispatched_at and erase the
  -- evidence that the effect was already performed once — which is the
  -- evidence this row exists to hold.
  --
  -- REPLAY IS A NEW ROW. It gets a fresh id, which is the consumer's
  -- idempotency key, so the replay actually re-delivers instead of being
  -- deduplicated away as a repeat of the original; it carries the same
  -- correlation_id, so the two are joinable; and the first dispatch's record
  -- survives untouched.
  CONSTRAINT outbox_dispatched_at_matches_status
    CHECK ((status = 'DONE') = (dispatched_at IS NOT NULL)),

  -- Composite on tenant_id, exactly as users does. A single-column
  -- `REFERENCES users(id)` is checked with row security OFF and would happily
  -- accept another tenant's user as the author.
  CONSTRAINT outbox_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT outbox_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE outbox IS
  'ADR-0010 transactional outbox. Rows are written INSIDE the posting transaction and dispatched after it commits. Payload carries identifiers, never financial truth.';

COMMENT ON COLUMN outbox.tenant_id IS
  'ADR-0003. Never from a request body or header; from the authenticated session only (rule 8).';
COMMENT ON COLUMN outbox.status IS
  'PENDING -> IN_FLIGHT -> DONE, or -> FAILED at the attempt cap. IN_FLIGHT is leased: see claimed_at.';
COMMENT ON COLUMN outbox.payload IS
  'Identifiers and minimal facts. Never an amount, an account or any figure that must agree with the ledger (ADR-0010).';
COMMENT ON COLUMN outbox.claimed_at IS
  'When a dispatcher claimed the row. An IN_FLIGHT row whose lease has expired is returned to PENDING by the reaper; without this column a dispatcher crash strands the row forever.';
COMMENT ON COLUMN outbox.last_error IS
  'Sanitised by packages/observability redactError BEFORE writing. readonly_support can read this and it is in every backup (rule 20).';
COMMENT ON COLUMN outbox.correlation_id IS
  'The request id that produced this row, propagated end to end (INFRASTRUCTURE §8).';
COMMENT ON COLUMN outbox.version IS
  'Optimistic lock. The application bumps it in the UPDATE WHERE clause; no trigger touches it.';

-- ---------------------------------------------------------------------------
-- Indexes
--
-- ADR-0003 requires tenant_id first on every index of a tenant-owned table.
--
-- DIVERGENCE FROM ADR-0010:152, recorded so the next reader does not
-- "restore" it: that line specifies (status, available_at). ADR-0003 binds
-- harder, and a dispatch query can only ever see one tenant's rows anyway
-- because RLS confines it — so tenant_id leads. An ADR-0010 erratum is owed
-- for that line.
--
-- The corollary, also recorded: "oldest pending row globally" is not
-- reachable by construction. A single query sees one tenant. Fairness across
-- tenants is the dispatcher's scheduling problem — round-robin with a
-- per-tenant batch cap — and the ARCHITECTURE §10 alert is a max over
-- per-tenant measurements, not one query.
-- ---------------------------------------------------------------------------

-- The dispatcher's claim query. PARTIAL, because rule 4 means DONE rows never
-- leave: an index over all statuses would grow without bound while the
-- working set stayed small.
--
-- `id` is the third column so the dispatcher can ORDER BY available_at, id.
-- Many rows share available_at = now() from the default, and without a
-- tiebreak the order among them is arbitrary — which permits a starved row
-- and makes the plan irreproducible.
CREATE INDEX outbox_pending_idx
  ON outbox (tenant_id, available_at, id)
  WHERE status = 'PENDING';

-- The reaper's query. Without this index an expired claim can only be found
-- by a sequential scan of a forever-growing table, which means in practice it
-- is never found.
CREATE INDEX outbox_in_flight_idx
  ON outbox (tenant_id, claimed_at)
  WHERE status = 'IN_FLIGHT';

-- Operational: "what has failed" is a condition someone must look at.
CREATE INDEX outbox_failed_idx
  ON outbox (tenant_id, created_at)
  WHERE status = 'FAILED';

-- The one NON-partial index, so it alone grows with the table and will
-- dominate the index footprint. That is accepted deliberately: tracing a
-- request has to find DONE rows, which is most of them.
CREATE INDEX outbox_correlation_idx ON outbox (tenant_id, correlation_id);

-- ---------------------------------------------------------------------------
-- The IN_FLIGHT lease, and why it exists
--
-- The dispatcher MUST commit the IN_FLIGHT mark before performing the side
-- effect. Holding a transaction open across an HTTP call is the thing
-- ADR-0010 exists to prevent, and idle_in_transaction_session_timeout would
-- kill it regardless.
--
-- That leaves a window: mark IN_FLIGHT, commit, crash. Without a lease the
-- row is then stranded forever — not in the pending index, not matched by the
-- claim query, not counted by the oldest-pending alert. Silently gone, with
-- the side effect possibly never performed, which contradicts ADR-0010's
-- redelivery guarantee and makes its mandated crash test unpassable.
--
-- The reaper, which the dispatcher runs:
--
--   UPDATE outbox
--      SET status       = 'PENDING',
--          claimed_at   = NULL,
--          attempts     = attempts + 1,
--          available_at = now() + backoff(attempts),
--          updated_at   = now(),
--          version      = version + 1
--    WHERE status = 'IN_FLIGHT'
--      AND claimed_at < now() - interval '5 minutes';
--
-- attempts is incremented, so a row that repeatedly kills its dispatcher
-- still reaches the cap and becomes FAILED rather than cycling forever.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Partitioning: DEFERRED, with the key recorded now
--
-- Rule 4 forbids DELETE and the grants below withhold it, so the archival
-- policy ADR-0010 requires has exactly one compatible mechanism: DETACH
-- PARTITION. The key is `created_at`.
--
-- It is NOT declared here. Declaring it would require PRIMARY KEY
-- (id, created_at) — losing `id` as a single-column foreign key target — and
-- would need partition creation running as a scheduled job from day one, for
-- a table that will hold no rows until posting exists. Inserts fail outright
-- when no partition matches, so that job is not optional.
--
-- The cost of deferring is recorded honestly: converting a populated
-- forever-growing table later is a full rewrite with an exclusive lock, and
-- this is the cheapest moment it will ever be. The decision to defer is
-- deliberate, and the next person to touch this table should weigh it again
-- before the first real row lands.
-- ---------------------------------------------------------------------------

-- set_updated_at() comes from 001. An updated_at the application must
-- remember to set is an updated_at that will eventually be wrong.
CREATE TRIGGER outbox_set_updated_at
  BEFORE UPDATE ON outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- ENABLE turns policies on for ordinary roles. FORCE applies them to the
-- table's OWNER too; without FORCE the owner silently sees every tenant, and
-- ADR-0004 treats ENABLE-without-FORCE as unprotected.
--
-- current_setting('app.tenant_id') WITHOUT the missing_ok flag, deliberately:
-- unset must RAISE. With `true` it returns NULL, the comparison becomes NULL,
-- and a loud failure turns into a silent zero-row read that reads as "nothing
-- to dispatch" rather than "no tenant context".
--
-- How the dispatcher works WITH this rather than around it (ADR-0010, and the
-- sanctioned withGlobal use in packages/database transaction.ts): it
-- enumerates active tenants from the global `tenants` table under withGlobal,
-- then opens one withTenant transaction per tenant batch. No BYPASSRLS role,
-- no dispatcher policy, no exception. Redis carries only a wake SIGNAL — the
-- tenant is read from `tenants` or from the row, never from the message, or
-- rule 8 is broken through the back door.
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
-- UPDATE is granted because the dispatcher moves a row through its lifecycle,
-- and because SELECT ... FOR UPDATE requires it — which correctly means
-- readonly_support cannot run the claim query, only read.
--
-- DELETE is granted to nobody. Rule 4, and a dispatched outbox row is the
-- evidence that a side effect was requested.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON outbox TO finsoft_app;
GRANT SELECT                 ON outbox TO readonly_support;
