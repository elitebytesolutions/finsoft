-- 004_create_outbox.sql
--
-- The transactional outbox. ADR-0019 (which supersedes ADR-0010).
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
-- ===========================================================================
-- Revision history, before release
--
-- This file has been revised TWICE. Both revisions predate any release, and
-- the record belongs here rather than only in a reflog.
--
-- EVERY COMMITTED VERSION, with its SHA and its manifest line. The earlier
-- form of this block listed the first two and described the rest in prose,
-- which is the file's own evidentiary standard applied to everyone except
-- itself. Database Guardian condition C3.
--
--   #  commit    CHECKSUMS entry for 004                                      what changed
--   1  d3a9a94   (no manifest line yet)                                        created
--   2  1dd0044   c8d8b8c826be34dabc2c2727036ae223a6fbb5f7c107bc7ca3f12c4c3508b5fa  first manifest line
--   3  71de5db   f9c090681cb0f69ac15a67809a7254067994730092628ca6e5796307eeb89cd6  revised after review 1
--   4  4053f57   9f38828abb1383269f99efc3344ab780fc51f57fbc38545d265a8eae42da58e3  the 12 changes from review 2
--   5  06ad0c8   f26fe704323f771b0c751cafad60c83f626132c23e92563ba445a4ba1cc10eb2  A1 append, A2 effect_key shape
--   6  b4271b0   081cc0f55be3a3c661d131f75dd26a1dea22fcee0279589987d97484ac47e054  citations repointed to ADR-0019
--   7  5486e48   ac6474d2e6b2d83b428e918a14f28ab37ffdb43a1cb3e2f1a70553eb8140438d  revision note corrected
--   8  this one  see CHECKSUMS                                                 C1-C4 recorded
--
-- SEVEN COMMITTED VERSIONS BEFORE THIS ONE, not the "three drafts" an earlier
-- version of this note implied. The narrower count came from thinking of a
-- draft as a review cycle rather than as a committed manifest line, and the
-- manifest does not care which it was.
--
-- THE MANIFEST LINE WAS EDITED, which `renderManifest` forbids in terms:
-- "Never edit an existing line." That rule is an operational restatement of
-- ADR-0013 ("immutable once APPLIED") and IMPLEMENTATION §11 ("immutable
-- after RELEASE"), and it collapses "recorded in the manifest" into
-- "released". On an unmerged branch those are not the same thing.
--
-- Evidence that 004 has been released by neither definition, current at the
-- time of writing and required on the pull request:
--
--   * `main`, `develop`, `origin/main` and `origin/develop` are all at
--     7a298ce, the initial commit. Both draft commits exist only on
--     feature/FND-017-web-lint-cleanup, which is unmerged.
--   * 004 was first added in d3a9a94, which is AFTER every deployment commit
--     on that branch.
--   * staging's ledger holds 001, 002 and 003 only, applied 2026-09-23
--     00:52:12+00. `assertAppliedUnchanged` has no recorded hash to compare
--     this file against, because no persistent database has seen it.
--
-- The alternative — freezing draft 2 and shipping an ALTER chain as 005 —
-- was rejected by the Database Guardian for a reason worth keeping: draft 2
-- STATES A PROTECTION IT DOES NOT PROVIDE (see the transition trigger
-- below), and fixing forward cannot correct a comment. A frozen wrong schema
-- is recoverable; a frozen wrong explanation is copied by the next author.
--
-- THIS DISPOSITION EXPIRES ON MERGE. The moment this file lands on a branch
-- anyone deploys from, or reaches any persistent cluster, every further
-- correction is a new numbered migration. And it is granted ONCE: a fourth
-- revision goes to 005 whatever the branch state says.
--
-- WHAT COUNTS AS A REVISION: a COMMITTED manifest line. The two above are
-- committed, which is why they are listed with their SHAs. Iterating on this
-- third draft before it is committed at all — as happened, twice, when the
-- acceptance suite found the missing REVOKE and an off-by-one in the reaper
-- predicate — is one draft being written, not three drafts being shipped.
-- Stated because the distinction is exactly the kind that erodes.
--
-- RULED, after the second review accepted this draft conditionally: the two
-- amendments it required — acknowledgement being an append rather than a
-- toggle, and a shape on effect_key — land HERE, in draft 3, and are not a
-- fourth revision. The Database Guardian applied its own condition to a file
-- it had just read at this commit. The bright line is MERGE, not commit: a
-- draft is shipped when it lands on a branch someone deploys from, and
-- correcting a review finding before that is finishing a draft rather than
-- starting another.
--
-- After merge, the next correction is 005. No further amendment to this file
-- is available on this branch without a new Database Guardian disposition.
--
-- EDITED ONCE MORE, AND SAID SO HERE RATHER THAN QUIETLY.
--
-- The Product Owner ruled that README rule 4 stands as written, so the
-- ADR-0010 erratum was withdrawn and ADR-0019 supersedes ADR-0010 instead.
-- Every reference in this file was repointed.
--
-- NO STRUCTURAL DDL CHANGED — no column, constraint, index, trigger,
-- policy or grant differs. What did change is `COMMENT ON` text and
-- `RAISE EXCEPTION` message strings.
--
-- The first draft of this note said "NO DDL CHANGED", which was wrong:
-- COMMENT ON *is* DDL and writes pg_description. It was not inert either —
-- the change propagated into the committed generated/schema.d.ts, which
-- went stale and passed every gate. That is ADR-0013 deferral D3's first
-- live instance, in the same commit that caused it.
--
-- Ruled a REVISION by the Architecture Guardian: the bytes change, the
-- checksum changes, and assertAppliedUnchanged cannot tell a comment from
-- a column, which is the only definition with operational meaning. ADR-0013
-- does not bind because 004 has not merged and immutability attaches on
-- APPLY. The once-only disposition is the Database Guardian's alone to
-- re-grant, and this is flagged to them rather than assumed — "it was only
-- a comment" is how a once-only disposition stops meaning anything.
--
-- Not moved to 005: a migration whose entire content is a citation change
-- would permanently add a row to a forward-only chain in exchange for
-- prose, and split this table's comments across two files for the life of
-- the database. The Database Guardian reached the same conclusion
-- independently: "I would not accept that migration if it were submitted on
-- its own merits, so I will not create it to satisfy a procedural reflex."
--
-- ---------------------------------------------------------------------------
-- RE-GRANTED, with four conditions. Database Guardian, 2026-09-23.
--
-- Verified independently before re-granting: stripping comment lines and
-- COMMENT ON statements, and diffing with all other string literals intact,
-- leaves exactly two differences between 06ad0c8 and this file -- both
-- RAISE EXCEPTION message strings. No column, type, default, CHECK
-- (including the topic and effect_key regexes, checked specifically because
-- a regex change hides well in a comment-heavy diff), foreign key, unique
-- constraint, index, trigger definition, policy or grant differs.
--
--   C1  THE COUNTER RESETS AND DOES NOT ACCUMULATE. The next committed
--       revision of this file goes to 005 unconditionally -- including
--       another citation-only change -- and no further disposition is
--       available on this branch. This commit is the one C3 mandates, so
--       the counter starts from it.
--
--   C2  THIS FILE MUST NOT MERGE before ADR-0019 is Accepted and ADR-0010's
--       status is flipped to Superseded. It already asserts that
--       supersession in the PRESENT TENSE -- "ADR-0019 (which supersedes
--       ADR-0010)", "ADR-0019 requires FAILED at the cap" -- while ADR-0019
--       is still Proposed. The migration is ahead of the record it cites,
--       and if ADR-0019 is amended in review the citations are wrong a
--       second time. That is the only foreseeable cause of a further edit,
--       and C2 removes the path in advance rather than adjudicating it
--       afterwards.
--
--   C3  Every committed version recorded with its SHA and manifest line.
--       Done, above.
--
--   C4  The D3 codegen-diff gate stays in the CI test job with no
--       continue-on-error. AND THE LIMIT OF THAT GATE, STATED HERE BECAUSE
--       THE EARLIER NOTE IMPLIED THE LOOP WAS CLOSED AND IT IS NOT:
--
--         COMMENT ON text  -> pg_description -> generated/schema.d.ts
--                          -> CAUGHT by the codegen diff.
--
--         RAISE EXCEPTION text -> pg_proc.prosrc -> nothing generated,
--                          no test asserting the changed fragments
--                          -> CAUGHT BY NOTHING.
--
--       Both message strings changed in b4271b0 and no gate in this
--       repository would have noticed. The outbox suite matches on
--       /DONE is terminal/ and /must carry the original topic, effect_key
--       and correlation_id/, fragments that did not change. That class of
--       migration edit is still invisible.
--
-- The staging-ledger evidence above rests on an attestation the Database
-- Guardian did not verify and declined access to verify. It is re-asserted
-- on the pull request, which is where it can be checked by someone who has
-- that access.
-- ---------------------------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- What the second review changed, and why each one mattered
--
--  1. lease_id. The stale ack was POSSIBLE, not merely unlikely. Dispatcher A
--     claims, stalls past the lease, the reaper returns the row to PENDING, B
--     claims and re-dispatches — then A wakes and acks. A correct ack nulls
--     claimed_at anyway, so the biconditional was no obstacle at all, and the
--     row went DONE while B was still working. On the failure path A's reset
--     to PENDING stole the row out from under B. `version` was not a fence:
--     nothing required an ack to carry it.
--  2. A transition trigger. The comment on outbox_dispatched_at_matches_status
--     claimed it "forbids resetting a DONE row to PENDING for replay". It did
--     not: `SET status='PENDING', dispatched_at=NULL` satisfies every
--     constraint on the table, GRANT UPDATE put it in reach of ordinary
--     application code, and ADR-0010 actively instructed someone to do it.
--     ADR-0019 correction 3 replaces that instruction.
--  3. Column-scoped UPDATE grant, so the evidence columns are out of reach at
--     the privilege layer as well as the trigger layer.
--  4. An attempt cap in the schema. ADR-0019 requires FAILED at the cap and
--     nothing enforced it, so a dispatcher bug that never capped produced a
--     row retrying forever and passed every test. Plus a SEPARATE reclaims
--     budget: five worker restarts during a deploy must not deliver a
--     poison-message verdict on a row whose consumer never ran.
--  5. outbox_failed_has_error, and acknowledged_at/_by — because "alert on any
--     FAILED row" against a terminal state with no acknowledgement fires
--     forever from the first poison row and is muted within a week.
--  6. replay_of, and UNIQUE (tenant_id, id) which ADR-0003 requires anyway for
--     sent_notifications to reference this table at all.
--  7. A payload bound. last_error was bounded as "a second line of defence"
--     while payload — larger, immutable, in every backup, never deleted — was
--     unbounded to 1 GB.
--  8. updated_by pinned to created_by by constraint rather than described in a
--     comment, since no machine principal exists (ADR-0004:78) and every write
--     after the INSERT is machine-driven.
--  9. Tenant enumeration over EVERY tenant, not only active ones.
-- 10. effect_key, so a replay cannot bypass the consumer's business-effect
--     deduplication by carrying a fresh id.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Lock footprint
--
-- The `tenant_id` foreign key takes SHARE ROW EXCLUSIVE on `tenants` for the
-- duration of this transaction, which blocks WRITES to `tenants` — not merely
-- DDL. The authorship and acknowledgement foreign keys take the same on
-- `users`. Both tables are near-empty in Wave 0, so this is microseconds; it
-- would not be on a live system, and a later migration adding a foreign key
-- to a large table must say so here in its own header.
--
-- The self-referencing replay foreign key takes its lock on `outbox` itself,
-- which this transaction is creating, so it is uncontended by construction.
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

  -- IDENTIFIERS AND MINIMAL FACTS ONLY. ADR-0019 is explicit: `{saleId,
  -- invoiceId}`, never `{amount, accountId}`. The dispatcher re-reads the
  -- committed row, so a payload can never disagree with the ledger and no
  -- financial truth sits in a queue going stale.
  payload         jsonb       NOT NULL,

  -- THE IDENTITY OF THE BUSINESS EFFECT, as distinct from the identity of
  -- this row.
  --
  -- ADR-0010 keyed the consumer's `sent_notifications` on `outbox.id`. That was
  -- right for redelivery — the same row arriving twice must act once — and
  -- WRONG for replay, because a replay row carries a fresh id and would sail
  -- straight past a dedup table keyed on it. "Send the invoice email for sale
  -- S once" is a statement about the effect, not about the row that asked for
  -- it.
  --
  -- So the consumer deduplicates on (tenant_id, topic, effect_key), and a
  -- replay carries its original's effect_key unchanged — enforced by the
  -- insert trigger below. A replay therefore does NOT re-send by default.
  -- Genuinely re-performing an effect requires clearing the consumer-side
  -- record, which is a deliberate and separately recorded act, and that is
  -- the correct shape: "I intend to email this customer a second time" should
  -- not be a side effect of fixing a dispatcher.
  --
  -- For an effect with no natural business key, the enqueuer mints a value
  -- once and reuses it on replay. It is never derived from `id`.
  effect_key      text        NOT NULL,

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

  -- Consumer failures. Distinct from reclaims below, deliberately.
  attempts        integer     NOT NULL DEFAULT 0,

  -- Dispatcher deaths: leases that expired without an ack. A deploy that
  -- restarts five workers is an infrastructure event, and charging it to
  -- `attempts` would deliver a poison-message verdict on a row whose consumer
  -- never once ran. Different cause, different owner, different remedy,
  -- different counter.
  reclaims        integer     NOT NULL DEFAULT 0,

  -- Set when and only when a dispatcher claims the row. This is what makes
  -- IN_FLIGHT recoverable rather than terminal — see the reaper note below.
  claimed_at      timestamptz,

  -- THE LEASE TOKEN. Regenerated on EVERY claim, including every reclaim.
  --
  -- This is the fence, and `version` is not one: `version` is a general
  -- optimistic-lock column that any future writer may bump, nothing requires
  -- an ack to carry it, and a counter can coincide. A fresh uuid per claim
  -- cannot. Every ack, failure and reclaim carries
  -- `WHERE id = $1 AND lease_id = $2` and asserts rowcount = 1; a dispatcher
  -- that has lost its lease therefore updates nothing and finds out.
  lease_id        uuid,

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

  -- A human has seen this FAILED row and taken responsibility for it.
  --
  -- ADR-0010's monitoring was "alert on any FAILED row". Against a terminal
  -- state with no acknowledgement that alert fires forever from the first
  -- poison row and is muted within a week, at which point the system has
  -- monitoring in name only. The alert is defined over UNACKNOWLEDGED failed
  -- rows, and this is the one legal append to a terminal row.
  acknowledged_at timestamptz,
  acknowledged_by uuid,

  -- The row this one replays, if any. A replay is a NEW row: fresh id, same
  -- effect_key, same correlation_id, and the original left byte-identical.
  -- Without this column "this row is the replay of that row" is recorded
  -- nowhere — correlation_id also groups every unrelated row from the same
  -- request, so it cannot answer the question.
  replay_of       uuid,

  -- ADR-0019 and INFRASTRUCTURE §8. The request id that produced the row,
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
  --
  -- NOT the lease fence. See lease_id.
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

  -- Shape, not only length. This column is what all of ADR-0019 correction 3 rests on,
  -- and it was the one load-bearing text column here with no shape — `topic`,
  -- which matters less, gets a full regex.
  --
  -- Why it matters: 'sale:S1 ' and 'sale:S1' would be two dedup slots for ONE
  -- effect, so two enqueuers disagreeing by a trailing space produce a silent
  -- double-send — through the exact mechanism ADR-0019 correction 3 added to prevent
  -- silent double-sends. ' ' was accepted before this line existed.
  --
  -- A regex rather than `effect_key = btrim(effect_key)`, which was the form
  -- the review proposed. Measured: BTRIM STRIPS SPACES ONLY. A tab-prefixed
  -- key satisfies `btrim(x) = x` and passes, and a tab is every bit as
  -- invisible in a log line as a space. The class is whitespace, not the
  -- space character, so the constraint names the class.
  --
  -- Reads as: no leading or trailing whitespace, no control characters
  -- anywhere, and a single-character key is legal.
  CONSTRAINT outbox_effect_key_bounded
    CHECK (
      length(effect_key) BETWEEN 1 AND 200
      AND effect_key ~ '^[^[:space:][:cntrl:]]([^[:cntrl:]]*[^[:space:][:cntrl:]])?$'
    ),

  -- NOT NULL alone admits 'null'::jsonb, a bare scalar and an array, all of
  -- which satisfy the column and none of which is a payload.
  CONSTRAINT outbox_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object'),

  -- A payload is identifiers, so 4 KB is generous. Unbounded, it would accept
  -- a megabyte — immutable after insert, in every backup, never deleted, and
  -- multiplied by every row the system will ever write.
  --
  -- `payload #>> '{}'` rather than `payload::text`: the extraction operator is
  -- IMMUTABLE, which a CHECK requires, and the I/O cast is not guaranteed to
  -- be. `pg_column_size` is merely STABLE and cannot be used here either.
  --
  -- THE BOUND IS ON THE NORMALISED FORM, not on the bytes the client sent.
  -- jsonb re-serialises canonically — `{"k":1}` comes back as `{"k": 1}`,
  -- one byte longer — so a client-side length check against 4096 will
  -- disagree with this constraint at the margin. Measured, not assumed:
  -- a 4096-byte input round-trips to 4097. The enqueuer should treat 4 KB as
  -- the budget with headroom, not as an exact boundary to sit on.
  CONSTRAINT outbox_payload_bounded
    CHECK (length(payload #>> '{}') <= 4096),

  -- ---------------------------------------------------------------------
  -- The two budgets, and the terminal state they lead to
  --
  -- Both caps are schema facts, not dispatcher conventions, because ADR-0019
  -- requires FAILED at the cap and a dispatcher that never capped would
  -- otherwise pass every database assertion while retrying forever.
  --
  -- The second CHECK in each pair is what actually forbids the runaway: at
  -- the cap the row may not be PENDING, so it has nowhere to go but FAILED.
  -- ---------------------------------------------------------------------
  CONSTRAINT outbox_attempts_nonneg
    CHECK (attempts >= 0),
  CONSTRAINT outbox_attempts_capped
    CHECK (attempts <= 10),
  CONSTRAINT outbox_exhausted_is_failed
    CHECK (attempts < 10 OR status <> 'PENDING'),

  CONSTRAINT outbox_reclaims_nonneg
    CHECK (reclaims >= 0),
  CONSTRAINT outbox_reclaims_capped
    CHECK (reclaims <= 5),
  CONSTRAINT outbox_reclaims_exhausted_is_failed
    CHECK (reclaims < 5 OR status <> 'PENDING'),

  CONSTRAINT outbox_last_error_bounded
    CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 2000),

  -- A FAILED row with no error is a dead end nobody can act on. The reaper
  -- writes a synthetic, clearly-attributed message when it exhausts the
  -- reclaim budget, because it has no consumer error to record — see the
  -- reaper statement below.
  CONSTRAINT outbox_failed_has_error
    CHECK (status <> 'FAILED' OR last_error IS NOT NULL),

  -- claimed_at exists exactly while the row is claimed. This is what the
  -- reaper keys on, and keeping the biconditional means a row cannot be
  -- IN_FLIGHT without a lease to expire.
  CONSTRAINT outbox_claimed_at_matches_status
    CHECK ((status = 'IN_FLIGHT') = (claimed_at IS NOT NULL)),

  -- The lease token is co-null with the lease itself, so a row cannot carry a
  -- token it is not entitled to, and a reclaim cannot forget to reissue one.
  CONSTRAINT outbox_lease_matches_status
    CHECK ((status = 'IN_FLIGHT') = (lease_id IS NOT NULL)),

  -- dispatched_at is set when and only when the row reaches DONE.
  --
  -- NOTE WHAT THIS DOES NOT DO. An earlier version of this file claimed the
  -- constraint "forbids resetting a DONE row to PENDING for replay". It does
  -- not, and the claim was the more dangerous half of the bug:
  --
  --   UPDATE outbox SET status = 'PENDING', dispatched_at = NULL WHERE id = $1;
  --
  -- satisfies (false) = (false), leaves claimed_at already NULL so the other
  -- biconditional holds, and was within reach of any code holding the UPDATE
  -- grant. ADR-0010 actively instructed someone to do exactly this, which is
  -- why ADR-0019 correction 3 supersedes that line. What
  -- forbids it is outbox_enforce_transition() below, plus the column-scoped
  -- grant; this constraint only keeps the two columns consistent.
  CONSTRAINT outbox_dispatched_at_matches_status
    CHECK ((status = 'DONE') = (dispatched_at IS NOT NULL)),

  -- Acknowledgement is paired, and only a FAILED row has anything to
  -- acknowledge.
  CONSTRAINT outbox_acknowledged_is_paired
    CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CONSTRAINT outbox_acknowledged_only_when_failed
    CHECK (acknowledged_at IS NULL OR status = 'FAILED'),

  CONSTRAINT outbox_replay_not_self
    CHECK (replay_of IS NULL OR replay_of <> id),

  -- updated_by is pinned to created_by, rather than described in a comment as
  -- meaning that.
  --
  -- Every write after the INSERT is machine-driven. ADR-0004:78 forbids a
  -- system tenant and 002 rejected a per-tenant system user, so there is no
  -- principal for the dispatcher to be. The honest meaning of updated_by on
  -- this table is therefore "the user on whose behalf the effect was
  -- enqueued", which never changes — and a constraint says that where a
  -- comment would leave a slot for a future author to fill with something
  -- else. §11 mandates the column and database/tests/schema.spec.ts enforces
  -- its presence and NOT NULL, so it stays, redundant by design.
  --
  -- The one genuine human action on this row after insert has its own column:
  -- acknowledged_by.
  CONSTRAINT outbox_updated_by_is_enqueuer
    CHECK (updated_by = created_by),

  -- ADR-0003: a tenant-owned table that another tenant-owned table will
  -- reference needs this, or the referencing composite foreign key cannot be
  -- written. ADR-0019's `sent_notifications` is exactly that table. 002 added
  -- the same constraint proactively for the same reason. Free on an empty
  -- table; a CREATE UNIQUE INDEX CONCURRENTLY and ADD CONSTRAINT USING INDEX
  -- on a large one later.
  CONSTRAINT outbox_tenant_id_id_key UNIQUE (tenant_id, id),

  -- Composite on tenant_id, exactly as users does. A single-column
  -- `REFERENCES users(id)` is checked with row security OFF and would happily
  -- accept another tenant's user as the author.
  CONSTRAINT outbox_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT outbox_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT outbox_acknowledged_by_fkey
    FOREIGN KEY (tenant_id, acknowledged_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,

  -- Self-referencing, and composite for the same reason: a replay must point
  -- at a row belonging to the same tenant.
  CONSTRAINT outbox_replay_of_fkey
    FOREIGN KEY (tenant_id, replay_of) REFERENCES outbox (tenant_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE outbox IS
  'ADR-0019 transactional outbox. Rows are written INSIDE the posting transaction and dispatched after it commits. Payload carries identifiers, never financial truth.';

COMMENT ON COLUMN outbox.tenant_id IS
  'ADR-0003. Never from a request body or header; from the authenticated session only (rule 8).';
COMMENT ON COLUMN outbox.status IS
  'PENDING -> IN_FLIGHT -> DONE, or -> FAILED at either cap. Transitions are enforced by outbox_enforce_transition(); DONE and FAILED are terminal.';
COMMENT ON COLUMN outbox.payload IS
  'Identifiers and minimal facts, at most 4096 bytes. Never an amount, an account or any figure that must agree with the ledger (ADR-0019). Immutable after insert.';
COMMENT ON COLUMN outbox.effect_key IS
  'Identity of the BUSINESS EFFECT, not of this row. The consumer deduplicates on (tenant_id, topic, effect_key); a replay carries its original value unchanged, so a fresh id cannot bypass deduplication.';
COMMENT ON COLUMN outbox.claimed_at IS
  'When a dispatcher claimed the row. LEASE INTERVAL: 5 minutes is the contract value, and the dispatcher MUST read it from configuration rather than hard-coding it — a crash test that cannot shorten the lease cannot run in under five minutes. ORDERING INVARIANT: the lease interval must exceed the maximum per-topic consumer timeout WITH MARGIN, and the dispatcher asserts this at startup over its registered consumers and refuses to start otherwise. Without it a merely SLOW consumer loses its row to the reaper every time, burns the reclaim budget and lands on FAILED carrying "lease expired 5 times without an ack" — a poison-message verdict on a consumer that works, which is the diagnostic confusion the separate reclaims counter exists to prevent.';
COMMENT ON COLUMN outbox.lease_id IS
  'The lease fence. Regenerated on every claim INCLUDING every reclaim. Every ack, failure and reclaim carries WHERE id = $1 AND lease_id = $2 and asserts rowcount = 1. A stale dispatcher updates nothing.';
COMMENT ON COLUMN outbox.attempts IS
  'CONSUMER failures. Cap 10, after which the row must become FAILED — outbox_exhausted_is_failed makes that a schema fact rather than a dispatcher convention.';
COMMENT ON COLUMN outbox.reclaims IS
  'DISPATCHER deaths: leases that expired without an ack. Cap 5. Counted separately from attempts because a deploy that restarts workers is an infrastructure event, not a poison message.';
COMMENT ON COLUMN outbox.last_error IS
  'Sanitised by packages/observability redactError BEFORE writing. readonly_support can read this and it is in every backup (rule 20).';
COMMENT ON COLUMN outbox.acknowledged_at IS
  'A human has taken responsibility for this FAILED row. The ADR-0019 alert is defined over UNACKNOWLEDGED failed rows; without this it would fire forever from the first one and be muted.';
COMMENT ON COLUMN outbox.replay_of IS
  'The row this one replays. correlation_id cannot answer this: it also groups every unrelated row from the same request.';
COMMENT ON COLUMN outbox.correlation_id IS
  'The request id that produced this row, propagated end to end (INFRASTRUCTURE §8).';
COMMENT ON COLUMN outbox.updated_by IS
  'Redundant by constraint: pinned to created_by, meaning "the user on whose behalf the effect was enqueued", never the dispatcher. §11 mandates the column; no machine principal exists (ADR-0004:78).';
COMMENT ON COLUMN outbox.version IS
  'Optimistic lock. The application bumps it in the UPDATE WHERE clause; no trigger touches it. NOT the lease fence — see lease_id.';

-- ---------------------------------------------------------------------------
-- The transition graph, enforced
--
-- This is the mechanism the old comment on outbox_dispatched_at_matches_status
-- wrongly attributed to a CHECK. A CHECK sees one row's final state; it cannot
-- see where that row came from, and every illegal transition here produces a
-- row whose final state is perfectly legal.
--
-- Legal transitions, and nothing else:
--
--   PENDING   -> IN_FLIGHT    claim
--   IN_FLIGHT -> DONE         ack
--   IN_FLIGHT -> PENDING      consumer failure, or reaper reclaim
--   IN_FLIGHT -> FAILED       either cap reached
--   FAILED    -> FAILED       acknowledgement, the ONE append to a terminal row
--
-- DONE is absolutely terminal. FAILED accepts acknowledgement ONCE and
-- nothing else. PENDING -> PENDING is rejected too: rescheduling a row by
-- hand is not a thing the dispatcher does, and allowing it would reopen the
-- backoff field to arbitrary writes.
--
-- IN_FLIGHT -> IN_FLIGHT is rejected, which means A LEASE CANNOT BE EXTENDED
-- IN PLACE. Note the reason, because the obvious one is wrong: "a lease that
-- can be extended is not a fence" is NOT true. A renewal that ROTATES the
-- token — `SET lease_id = gen_random_uuid() WHERE id = $1 AND lease_id = $2`,
-- rowcount asserted — is still a fence, because the holder must present the
-- current token to get the next one. That is the standard fencing-token
-- renewal and it would be admissible.
--
-- It is excluded on narrower grounds: rotation-on-renewal adds a failure mode
-- of its own. The renewal commits, the dispatcher dies before recording the
-- new token, and the live token is held by nobody — so the row waits out the
-- full lease anyway. Complexity paid for a narrow case, worst case unchanged.
--
-- IF RENEWAL IS EVER NEEDED, rotation-on-renewal is the sanctioned shape.
-- Recorded here so the next person builds the fenced version rather than
-- inventing a non-rotating one. The ordering invariant on claimed_at is what
-- makes renewal unnecessary today.
-- ---------------------------------------------------------------------------
CREATE FUNCTION outbox_enforce_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The evidence columns. These record WHAT was owed and BY WHOM; they are
  -- not state, and no dispatcher statement has any reason to touch them.
  IF NEW.id             IS DISTINCT FROM OLD.id
  OR NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
  OR NEW.topic          IS DISTINCT FROM OLD.topic
  OR NEW.payload        IS DISTINCT FROM OLD.payload
  OR NEW.effect_key     IS DISTINCT FROM OLD.effect_key
  OR NEW.occurred_at    IS DISTINCT FROM OLD.occurred_at
  OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
  OR NEW.created_at     IS DISTINCT FROM OLD.created_at
  OR NEW.created_by     IS DISTINCT FROM OLD.created_by
  OR NEW.updated_by     IS DISTINCT FROM OLD.updated_by
  OR NEW.replay_of      IS DISTINCT FROM OLD.replay_of
  THEN
    RAISE EXCEPTION
      'outbox %: the evidence columns are immutable after insert (id, tenant_id, topic, payload, effect_key, occurred_at, correlation_id, created_at, created_by, updated_by, replay_of)',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'DONE' THEN
    RAISE EXCEPTION
      'outbox %: DONE is terminal. Replay is a NEW row carrying the same effect_key and replay_of = this id — resetting this one erases the evidence that the effect was already performed (ADR-0019 correction 3)',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'FAILED' THEN
    -- The one legal append: a human acknowledging the row. Everything else
    -- about it is frozen.
    -- And an append is not a toggle. Without this, an already-acknowledged
    -- row accepts `SET acknowledged_at = NULL, acknowledged_by = NULL`:
    -- status is still FAILED, no frozen column moves, and
    -- outbox_acknowledged_is_paired is satisfied by both being NULL. The row
    -- silently re-enters outbox_unacknowledged_failed_idx, the alert re-arms,
    -- and the record of who took responsibility is gone. Reassigning it to a
    -- different user passed too.
    --
    -- Structurally the same defect that made draft 2 unacceptable: a comment
    -- and an error string describing a guarantee the code did not quite give.
    IF OLD.acknowledged_at IS NOT NULL
   AND (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
     OR NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by)
    THEN
      RAISE EXCEPTION
        'outbox %: acknowledgement is an append. Once recorded it cannot be withdrawn or reassigned',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status <> 'FAILED'
    OR NEW.attempts     IS DISTINCT FROM OLD.attempts
    OR NEW.reclaims     IS DISTINCT FROM OLD.reclaims
    OR NEW.claimed_at   IS DISTINCT FROM OLD.claimed_at
    OR NEW.lease_id     IS DISTINCT FROM OLD.lease_id
    OR NEW.available_at IS DISTINCT FROM OLD.available_at
    OR NEW.last_error   IS DISTINCT FROM OLD.last_error
    THEN
      RAISE EXCEPTION
        'outbox %: FAILED is terminal. The only permitted update is setting acknowledged_at and acknowledged_by',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.status = 'PENDING'   AND NEW.status = 'IN_FLIGHT')
    OR (OLD.status = 'IN_FLIGHT' AND NEW.status IN ('DONE', 'PENDING', 'FAILED'))
  ) THEN
    RAISE EXCEPTION
      'outbox %: illegal transition % -> %. Legal: PENDING->IN_FLIGHT, IN_FLIGHT->DONE, IN_FLIGHT->PENDING, IN_FLIGHT->FAILED, FAILED->FAILED (acknowledgement only)',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION outbox_enforce_transition() IS
  'ADR-0019. Enforces the status transition graph and post-insert immutability of the evidence columns. A CHECK cannot do this: it sees only the final state, and every illegal transition here ends in a state that is legal on its own.';

-- ---------------------------------------------------------------------------
-- Replay integrity, enforced at insert
--
-- A replay row must be a replay OF something: same tenant, same topic, same
-- effect_key, same correlation_id, and pointing at a row that has finished.
--
-- The effect_key clause is the load-bearing one. Without it a replay could
-- carry a fresh effect_key as well as a fresh id, and then sail past the
-- consumer's deduplication — which is the failure "replay preserves evidence"
-- is really about. The evidence surviving is necessary; not silently
-- re-performing the effect is what people actually care about.
-- ---------------------------------------------------------------------------
CREATE FUNCTION outbox_enforce_replay() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  original outbox%ROWTYPE;
BEGIN
  IF NEW.replay_of IS NULL THEN
    RETURN NEW;
  END IF;

  -- The composite foreign key already guarantees the tenant matches and the
  -- row exists; this reads it for the remaining checks.
  SELECT * INTO original FROM outbox WHERE id = NEW.replay_of AND tenant_id = NEW.tenant_id;

  IF original.status NOT IN ('DONE', 'FAILED') THEN
    RAISE EXCEPTION
      'outbox %: cannot replay a row that is still %. Wait for it to finish; a second live row for the same effect is a double send waiting to happen',
      NEW.replay_of, original.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.topic IS DISTINCT FROM original.topic
  OR NEW.effect_key IS DISTINCT FROM original.effect_key
  OR NEW.correlation_id IS DISTINCT FROM original.correlation_id
  THEN
    RAISE EXCEPTION
      'outbox %: a replay must carry the original topic, effect_key and correlation_id. A fresh effect_key would bypass the consumer deduplication that makes replay safe (ADR-0019 correction 3)',
      NEW.replay_of
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION outbox_enforce_replay() IS
  'ADR-0019 correction 3. A replay is a new row carrying the original effect_key, so it cannot bypass consumer deduplication by holding a fresh id.';

-- ---------------------------------------------------------------------------
-- Indexes
--
-- ADR-0003 requires tenant_id first on every index of a tenant-owned table.
--
-- ADR-0019 CORRECTION 2. ADR-0010 specified
-- (status, available_at). ADR-0003 binds harder, and a dispatch query can
-- only ever see one tenant's rows anyway because RLS confines it, so
-- tenant_id leads.
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
--
-- current_setting() is STABLE, so the RLS predicate is index-usable as the
-- leading qual rather than a filter above the scan.
CREATE INDEX outbox_pending_idx
  ON outbox (tenant_id, available_at, id)
  WHERE status = 'PENDING';

-- The reaper's query. Without this index an expired claim can only be found
-- by a sequential scan of a forever-growing table, which means in practice it
-- is never found.
CREATE INDEX outbox_in_flight_idx
  ON outbox (tenant_id, claimed_at)
  WHERE status = 'IN_FLIGHT';

-- Operational: "what has failed and nobody has looked at" is the alert
-- condition, so the index matches it rather than matching FAILED alone.
CREATE INDEX outbox_unacknowledged_failed_idx
  ON outbox (tenant_id, created_at)
  WHERE status = 'FAILED' AND acknowledged_at IS NULL;

-- The one NON-partial index, so it alone grows with the table and will
-- dominate the index footprint. That is accepted deliberately: tracing a
-- request has to find DONE rows, which is most of them.
CREATE INDEX outbox_correlation_idx ON outbox (tenant_id, correlation_id);

-- ---------------------------------------------------------------------------
-- The IN_FLIGHT lease, the fence, and the statements that use them
--
-- The dispatcher MUST commit the IN_FLIGHT mark before performing the side
-- effect. Holding a transaction open across an HTTP call is the thing
-- ADR-0019 exists to prevent, and idle_in_transaction_session_timeout would
-- kill it regardless.
--
-- That leaves a window: mark IN_FLIGHT, commit, crash. Without a lease the
-- row is stranded forever. WITH a lease but WITHOUT a fence, the recovered
-- row is worse than stranded: the original dispatcher wakes up and acks a row
-- another dispatcher is actively working.
--
-- The statements are recorded here, with their predicates visible, so the
-- dispatcher author cannot get them wrong from prose alone. EVERY ONE asserts
-- rowcount = 1. A dispatcher that fires an update and ignores how many rows
-- it touched cannot detect that it lost its lease, which is the entire point.
--
--   CLAIM
--     UPDATE outbox
--        SET status     = 'IN_FLIGHT',
--            claimed_at = now(),
--            lease_id   = gen_random_uuid(),
--            updated_at = now(),
--            version    = version + 1
--      WHERE id = $1 AND status = 'PENDING'
--     RETURNING lease_id;
--
--   ACK
--     UPDATE outbox
--        SET status        = 'DONE',
--            claimed_at    = NULL,
--            lease_id      = NULL,
--            dispatched_at = now(),
--            updated_at    = now(),
--            version       = version + 1
--      WHERE id = $1 AND lease_id = $2;
--
--   CONSUMER FAILURE (below the cap)
--     UPDATE outbox
--        SET status       = 'PENDING',
--            claimed_at   = NULL,
--            lease_id     = NULL,
--            attempts     = attempts + 1,
--            available_at = now() + backoff(attempts),
--            last_error   = $3,
--            updated_at   = now(),
--            version      = version + 1
--      WHERE id = $1 AND lease_id = $2;
--
--   CONSUMER FAILURE (at the cap) — same, but status = 'FAILED',
--     available_at unchanged, and last_error carrying the consumer's error.
--
--   REAPER RECLAIM (lease expired, budget remaining)
--     UPDATE outbox
--        SET status       = 'PENDING',
--            claimed_at   = NULL,
--            lease_id     = NULL,
--            reclaims     = reclaims + 1,
--            available_at = now() + backoff(reclaims),
--            updated_at   = now(),
--            version      = version + 1
--      WHERE status = 'IN_FLIGHT'
--        AND claimed_at < now() - $lease_interval
--        AND reclaims + 1 < 5;
--
--   REAPER EXHAUSTION (lease expired, budget spent)
--     UPDATE outbox
--        SET status     = 'FAILED',
--            claimed_at = NULL,
--            lease_id   = NULL,
--            reclaims   = reclaims + 1,
--            last_error = 'lease expired ' || (reclaims + 1) ||
--                         ' times without an ack; no consumer error recorded',
--            updated_at = now(),
--            version    = version + 1
--      WHERE status = 'IN_FLIGHT'
--        AND claimed_at < now() - $lease_interval
--        AND reclaims + 1 >= 5;
--
--     The synthetic last_error is required by outbox_failed_has_error and is
--     worth having anyway: the reaper has no consumer error to record, and a
--     row that died of dispatcher restarts must be distinguishable on sight
--     from one that failed on its merits.
--
--   NOTE THE PREDICATE: `reclaims + 1 < 5`, not `reclaims < 5`. The naive
--   form is off by one and the constraint catches it — a row at reclaims = 4
--   passes `reclaims < 5`, reclaims to 5, and lands on PENDING, which
--   outbox_reclaims_exhausted_is_failed rejects outright. The statement is
--   written in terms of the RESULTING value because that is what the
--   constraint is written in terms of. The same applies to the attempts
--   predicate on the consumer-failure path: `attempts + 1 < 10` chooses the
--   retry, `attempts + 1 >= 10` chooses FAILED.
--
--   This was found by a test, not by reading the statement. Both budgets
--   therefore permit exactly N events: N-1 returns to PENDING and an Nth that
--   terminates the row.
--
--   NOTE: neither reaper statement carries lease_id, because the reaper is
--   the thing that INVALIDATES a lease rather than holding one. It is fenced
--   by `claimed_at < now() - interval` instead, and the reclaim issues no new
--   token because the row returns to PENDING.
--
--   NOTE: no statement sets updated_by. It is pinned to created_by by
--   constraint and frozen by the transition trigger.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Partitioning: DEFERRED, with the key recorded now
--
-- Rule 4 forbids DELETE and the grants below withhold it, so the archival
-- policy ADR-0019 requires has exactly one compatible mechanism: DETACH
-- PARTITION. The key is `created_at`.
--
-- It is NOT declared here. Declaring it would require PRIMARY KEY
-- (id, created_at) — losing `id` as a single-column foreign key target — and
-- would need partition creation running as a scheduled job from day one, for
-- a table that will hold no rows until posting exists. Inserts fail outright
-- when no partition matches, so that job is not optional.
--
-- Two costs, recorded rather than discovered later:
--
--   * Converting a populated forever-growing table later is a full rewrite
--     under an exclusive lock, and this is the cheapest moment it will ever
--     be.
--   * RANGE on created_at means the claim query, which has no created_at
--     predicate, must consider EVERY partition on every poll. The partial
--     PENDING indexes on old partitions will be empty, so the cost is
--     planning time rather than I/O — but it is per poll, forever.
--
-- A DETACHED PARTITION IS RETAINED AND ARCHIVED, NEVER DROPPED. "DETACH is
-- the only mechanism compatible with rule 4" is true and does not by itself
-- stop anyone dropping the detached table afterwards. Detaching requires a
-- verified backup and Database Guardian sign-off.
--
-- This deferral is also recorded in docs/WAVE_0_REGISTER.md, because a
-- deferral that survives only in a SQL comment nobody greps is an omission
-- with a note.
-- ---------------------------------------------------------------------------

-- Trigger order is alphabetical by name within BEFORE UPDATE, so
-- outbox_enforce_transition runs before outbox_set_updated_at. That is the
-- order we want: the transition is rejected before anything is stamped.
CREATE TRIGGER outbox_enforce_transition
  BEFORE UPDATE ON outbox
  FOR EACH ROW EXECUTE FUNCTION outbox_enforce_transition();

CREATE TRIGGER outbox_enforce_replay
  BEFORE INSERT ON outbox
  FOR EACH ROW EXECUTE FUNCTION outbox_enforce_replay();

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
-- How the dispatcher works WITH this rather than around it (ADR-0019, and the
-- sanctioned withGlobal use in packages/database transaction.ts): it
-- enumerates tenants from the global `tenants` table under withGlobal, then
-- opens one withTenant transaction per tenant batch. No BYPASSRLS role, no
-- dispatcher policy, no exception. Redis carries only a wake SIGNAL — the
-- tenant is read from `tenants` or from the row, never from the message, or
-- rule 8 is broken through the back door.
--
-- EVERY TENANT, OF ANY STATUS. Not only active ones.
--
-- A SUSPENDED or CLOSED tenant can hold pending rows — a final invoice email,
-- an FBR push owed for a period already posted. Those rows would never be
-- claimed, never be reaped, and never appear in a per-tenant oldest-pending
-- measurement, because no measurement is taken for a tenant nobody
-- enumerates. That is a liveness hole, not an isolation hole, and it is
-- easy to fall into: 001's only index on `tenants` is
-- `tenants_status_idx ... WHERE status = 'ACTIVE'`, which makes the wrong
-- query the convenient one.
--
-- The ARCHITECTURE §10 oldest-pending alert is therefore a max over ALL
-- tenants, not over active ones.
--
-- Scaling note: one claim probe per tenant per poll cycle is O(tenants)
-- queries per interval. Fine at Wave 0 volumes; measure it before the tenant
-- count reaches three figures.
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
-- UPDATE is granted PER COLUMN. The transition trigger is the enforcement;
-- this is the privilege-layer half, and it costs nothing to have both. The
-- evidence columns — id, tenant_id, topic, payload, effect_key, occurred_at,
-- correlation_id, created_at, created_by, updated_by, replay_of — are simply
-- not writable by the application role, so an attempt to rewrite history
-- fails at the grant before it reaches the trigger.
--
-- acknowledged_at and acknowledged_by are included: acknowledging a FAILED
-- row is an ordinary application action by a human.
--
-- SELECT ... FOR UPDATE requires the UPDATE privilege, which correctly means
-- readonly_support cannot run the claim query, only read.
--
-- set_updated_at() is unaffected by the column list: column privileges are
-- checked against the statement's SET list, not against trigger assignments.
--
-- DELETE is granted to nobody. Rule 4, and a dispatched outbox row is the
-- evidence that a side effect was requested.
-- ---------------------------------------------------------------------------
-- THE REVOKE IS NOT OPTIONAL, and this was caught by a test rather than by
-- reading the file.
--
-- `00-bootstrap.sh` sets ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration
-- GRANT SELECT, INSERT, UPDATE ON TABLES TO finsoft_app, so this table
-- arrives with TABLE-LEVEL UPDATE already granted. Table-level UPDATE
-- supersedes column-level grants entirely: adding a column list on top of it
-- restricts nothing, and `information_schema.column_privileges` cheerfully
-- lists every column including `id`.
--
-- So the default grant is revoked first and re-issued per column. Without
-- this line the column list below is decorative, and the evidence columns
-- stay writable while the file claims they do not — the exact shape of the
-- defect that made draft 2 unacceptable.
REVOKE UPDATE ON outbox FROM finsoft_app;

GRANT SELECT, INSERT ON outbox TO finsoft_app;
GRANT UPDATE (
  status, attempts, reclaims, claimed_at, lease_id, available_at,
  last_error, dispatched_at, acknowledged_at, acknowledged_by,
  updated_at, version
) ON outbox TO finsoft_app;

GRANT SELECT ON outbox TO readonly_support;
