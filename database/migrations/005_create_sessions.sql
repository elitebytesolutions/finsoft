-- 005_create_sessions.sql
--
-- Sessions and rotating refresh tokens. ADR-0009.
--
-- Three tables, because the token family is a first-class thing rather than a
-- column: reuse detection revokes a FAMILY, and revoking a family must be one
-- write rather than a fan-out over its members.
--
--   sessions                 one signed-in session, in one tenant
--   refresh_token_families   the rotation chain; revoked as a unit
--   refresh_tokens           one issued token, single-use
--
-- ---------------------------------------------------------------------------
-- The correction this schema is built around
--
-- An earlier plan for this wave called concurrent refresh from two browser
-- tabs "a legitimate race that must not revoke a family". That is WRONG:
--
--   A REPLAYED STOLEN REFRESH TOKEN AND A SECOND BROWSER TAB ARE
--   INDISTINGUISHABLE TO THE SERVER. Both present a spent token. Both look
--   identical. OAuth 2.0 security guidance identifies exactly this inability
--   to tell attacker from client during replay.
--
-- So there is no "concurrent reuse is allowed" exception anywhere in this
-- schema, and none may be added. Rotation is atomic and single-use; a spent
-- token revokes its family, whoever presented it. The client coordinates —
-- one in-flight refresh per browser context — and an explicit retry policy
-- handles the loser. The server does not guess intent.
--
-- ADR-0009:83 SPECIFIES A GRACE WINDOW THAT THIS SCHEMA CANNOT HONOUR, AND
-- THIS FILE IS NOT WHERE THAT IS DECIDED. ADR-0009 says "a short grace window
-- (a few seconds) tolerates a genuine network retry replaying the same
-- refresh, returning the already-issued pair rather than killing the family."
-- Returning the already-issued pair requires re-sending the SUCCESSOR'S RAW
-- VALUE, which this design deliberately never stores — so the clause is not
-- merely unwise, it is inconsistent with hash-at-rest. An earlier draft of
-- this header declared ADR-0009 "WRONG" and attributed the correction to a
-- Product Owner instruction. That inverted the authority table: ADR-0009 is
-- LEVEL 1 and is retired by a superseding ADR approved by the Architecture
-- Guardian, never by a migration comment plus a LEVEL 2 instruction. See
-- ADR-0022; this migration must not merge before it is Accepted.
--
-- SINGLE USE IS ENFORCED BY TWO MECHANISMS, and an earlier draft shipped
-- only the first while claiming the pair:
--
--   1. THE PRIVILEGE HALF. `finsoft_app` may write `used_at` and nothing else
--      that matters. This bounds WHICH columns application code can touch.
--
--   2. THE ENFORCEMENT HALF. `refresh_tokens_enforce_transition()` below
--      makes those writes ONE-WAY. Without it the grant alone is decorative:
--      measured against the test database as `finsoft_app` under RLS, the
--      draft permitted
--
--        UPDATE refresh_tokens SET used_at = now() ... rowcount 1  spend
--        UPDATE refresh_tokens SET used_at = NULL  ... rowcount 1  REWIND
--        UPDATE refresh_tokens SET used_at = now() ... rowcount 1  SPEND AGAIN
--
--      and the same shape un-revoked a family after reuse detection and
--      un-revoked an admin-terminated session. A column grant says which
--      columns may change; only a trigger says which DIRECTION they may
--      change in. This is 004's defect #2 in a new table, and the answer is
--      004's answer.
--
-- The statement the application issues, which is what the integration suite
-- runs. An earlier draft printed one here that named a `session_id` column
-- this table does not have, so it could not execute at all:
--
--   UPDATE refresh_tokens
--      SET used_at = now(), updated_by = $2, version = version + 1
--    WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
--   RETURNING id, family_id;
--
-- rowcount 1 -> this caller won the race and may rotate.
-- rowcount 0 -> DO NOT assume reuse. Read the row to find out which case it
--               is, because the cases have different correct responses:
--                 row exists, used_at IS NOT NULL -> REUSE. Revoke family.
--                 row exists, expires_at <= now() -> expired. 401 only.
--                 no row                          -> unknown. 401 only.
--
-- That distinction is between EXPIRED and SPENT. It is NOT a distinction
-- between a second tab and a thief: both of those land in the reuse branch
-- and both revoke the family, which is the property the test named
-- `the loser is indistinguishable from an attacker` pins down.
--
-- Two concurrent callers cannot both see rowcount 1, because the second
-- blocks on the row lock and then re-evaluates `used_at IS NULL` against the
-- committed row. That is the whole mechanism, and it is why `used_at` is a
-- nullable timestamp rather than a boolean an application might set twice.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Lock footprint
--
-- The `tenant_id` foreign keys take SHARE ROW EXCLUSIVE on `tenants` for the
-- duration of this transaction, and the composite authorship and subject keys
-- take the same on `users`. That blocks WRITES to those tables, not merely
-- DDL. Both are near-empty in Wave 1, so this is microseconds; a later
-- migration adding a foreign key to a large table must say so in its own
-- header.
--
-- Nothing existing is altered. The runner wraps this file in one transaction,
-- so an aborted apply leaves nothing behind. Plain CREATE INDEX is correct:
-- every table here is created empty in this same transaction, and
-- CONCURRENTLY cannot run inside a transaction block.
--
-- How this is reversed: it is not, in place. Migrations are forward-only
-- (ADR-0013); undoing this means a later numbered migration that drops the
-- tables, which the verifier flags as destructive.
--
-- LOCK ACQUISITION ORDER, and it is declared rather than left to the plan:
--
--   sessions  ->  refresh_token_families  ->  refresh_tokens
--
-- Every trigger below that reads a parent row takes `FOR SHARE` on it. THE
-- WEAKER LOCK IS A TRAP AND MUST NOT BE SUBSTITUTED: revoking a family
-- touches no key column, so it takes FOR NO KEY UPDATE, and `FOR KEY SHARE`
-- does not conflict with that. A guard written with FOR KEY SHARE would look
-- like a fix and block nothing. That is also why the composite foreign keys
-- give no protection for free — referential integrity checks take FOR KEY
-- SHARE on the parent, which is exactly the lock revocation does not wait on.
--
-- `FOR UPDATE` would additionally serialise two concurrent inserts into the
-- same family against each other. That buys nothing — neither invalidates the
-- other's precondition — and pessimises the rotation path. FOR SHARE is the
-- weakest lock that excludes what must be excluded.
--
-- A revoke that waits on an in-flight insert is CORRECT, not a cost to
-- mitigate: the resulting row is a token written into a family that was live
-- when it was written, and revocation is by family and covers it. Do not add
-- NOWAIT, SKIP LOCKED or a short lock_timeout here — a revoke that gives up
-- is strictly worse than a revoke that waits.
--
-- Why this cannot deadlock, in the form a reader can check: a `refresh_tokens`
-- row is only ever locked by the statement that targets it, and no path locks
-- one while holding another lock it must wait on. A token lock can therefore
-- never be the second edge of a cycle.
--
-- GROWTH IS UNBOUNDED AND NO RETENTION POLICY EXISTS. Roughly 96 rotations
-- per session per day, appended forever because rule 4 grants DELETE to
-- nobody. Recorded as debt D-W1-003 in docs/WAVE_1_REGISTER.md with an owner
-- and a trigger condition; deliberately NOT decided here, because
-- partitioning an empty table imposes complexity on every query and RLS
-- policy before there is data to justify it.
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ADR-0003. A session belongs to exactly one tenant. ADR-0009: a user who
  -- belongs to several holds one session per tenant, and switching is a
  -- re-authentication that mints a new pair — never a tenant parameter on a
  -- request.
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id         uuid        NOT NULL,

  -- THE NON-SECRET LOG IDENTIFIER. ADR-0016 §5.
  --
  -- The raw session id is a bearer credential: anyone holding it can resume
  -- the session, and logs are aggregated, replicated, backed up and read by
  -- support. This is a separate random value, minted here, useless for
  -- authentication, and safe to log.
  --
  -- THE `scid_` PREFIX ENABLES THE CLOSURE OF ADR-0016's DEBT D8. It does
  -- NOT close it, and an earlier draft claimed it did. D8 asks for "a
  -- distinguishable sessionCorrelationId format, so the guard can reject a
  -- value it did not mint rather than accepting any UUID" — but the guard
  -- today, `asSessionCorrelationId` in packages/observability, THROWS unless
  -- the value is a UUID, and `newSessionCorrelationId` mints a bare
  -- randomUUID(). This format is what the guard must be changed TO accept;
  -- until that change lands, the schema stores values the only sanctioned
  -- reader rejects. ADR-0016's own text states the UUID rule as fact and is
  -- corrected in the same movement. Schema, guard and ADR land together.
  --
  -- ENTROPY HERE IS A SCHEMA FACT, AND THE GRANT IS WHAT MAKES IT ONE.
  --
  -- The DEFAULT alone would not: a DEFAULT applies only when the INSERT omits
  -- the column, so a caller naming it overrides the DEFAULT entirely.
  -- Measured against the draft that had the DEFAULT and a table-level INSERT
  -- grant: `session_correlation_id = 'scid_deadbeefdeadbeefdeadbeefdeadbeef'`
  -- was ACCEPTED — 32 caller-chosen hex characters, zero entropy, and
  -- `sessions_scid_shape` satisfied. `id` was forgeable the same way.
  --
  -- The control is the COLUMN-SCOPED INSERT GRANT at the foot of this file:
  -- `finsoft_app` may not NAME this column, so the DEFAULT is the only way a
  -- value can arrive. That is the difference between a strong default and a
  -- mechanism, and it is why an earlier draft's claim that this column was
  -- "globally unique by construction, like id" was wrong twice over — `id`
  -- was not in that class either until this grant existed.
  --
  -- `refresh_tokens.token_hash` CANNOT be closed this way: the application
  -- must compute it, because the database must never see the raw value it is
  -- the hash of. Its entropy stays an application promise, which is why
  -- ADR-0021's condition 5 carries the whole weight there.
  session_correlation_id text NOT NULL
    DEFAULT ('scid_' || replace(gen_random_uuid()::text, '-', '')),

  -- ADR-0009:119. A TIMESTAMP, not a boolean, and the difference is not
  -- cosmetic: step-up re-authentication is required for reopening a period,
  -- changing roles and break-glass access EVEN WITHIN AN ACTIVE SESSION, so
  -- the guard must evaluate how RECENTLY MFA happened. A boolean cannot
  -- express recency, so the `mfa_completed` flag an earlier draft shipped
  -- would have left step-up freshness unevaluable against this row.
  -- NULL means MFA not completed.
  mfa_at          timestamptz,

  -- ADR-0009:85. Refresh tokens are bound to "the session record, the user,
  -- the tenant and a device fingerprint". This is that fingerprint. Opaque
  -- to the database: the API computes it, and what goes into it is
  -- ADR-0009's business, not this table's.
  device_id       text,

  -- ADR-0009:96. The guard checks the session is ACTIVE. Kept in step with
  -- `revoked_at` by a CHECK rather than by application discipline, because
  -- two representations of one fact drift the moment only one is written.
  status          text        NOT NULL DEFAULT 'ACTIVE',

  -- ADR-0009:102. Changing a user's roles bumps this; a token whose version
  -- is behind is refused at the guard, forcing a refresh. It is how a
  -- privilege REDUCTION takes effect on the next request rather than up to
  -- fifteen minutes later — the mechanism behind the Product Owner's
  -- requirement for explicit membership-change behaviour.
  permission_version integer  NOT NULL DEFAULT 0 CHECK (permission_version >= 0),

  -- Revocation. ADR-0009 requires server-side revocation, which is the whole
  -- reason sessions are a table rather than purely a signed claim: a JWT
  -- cannot be un-issued, so something outside it must be able to say no.
  revoked_at      timestamptz,
  revoked_reason  text,

  last_seen_at    timestamptz NOT NULL DEFAULT now(),

  -- Bounded, because they come from a request header and an unbounded header
  -- is an unbounded row. Recorded for incident response, not for logic.
  ip              text,
  user_agent      text,

  -- ---------------------------------------------------------------------
  -- The mandatory column set. IMPLEMENTATION §11.
  -- ---------------------------------------------------------------------
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  version         integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT sessions_scid_shape
    CHECK (session_correlation_id ~ '^scid_[0-9a-f]{32}$'),

  CONSTRAINT sessions_status_allowed
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  -- One fact, two columns, kept identical by the database.
  CONSTRAINT sessions_status_matches_revocation
    CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),

  CONSTRAINT sessions_revoked_is_paired
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT sessions_revoked_reason_bounded
    CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 200),

  CONSTRAINT sessions_ip_bounded
    CHECK (ip IS NULL OR length(ip) BETWEEN 1 AND 45),
  CONSTRAINT sessions_user_agent_bounded
    CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 512),
  CONSTRAINT sessions_device_id_bounded
    CHECK (device_id IS NULL OR length(device_id) BETWEEN 1 AND 128),

  -- Composite on tenant_id, exactly as users does. A single-column
  -- `REFERENCES users(id)` is checked with row security OFF and would accept
  -- another tenant's user as the subject of this session — which is the one
  -- thing a session row must never be able to say.
  CONSTRAINT sessions_user_fkey
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sessions_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sessions_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,

  -- ADR-0003: a tenant-owned table that another tenant-owned table
  -- references needs this, or the referencing composite key cannot be
  -- written. `refresh_token_families` is exactly that table.
  CONSTRAINT sessions_tenant_id_id_key UNIQUE (tenant_id, id)
)
-- `last_seen_at` is the hottest write in the system — one per authenticated
-- request — so leave room on the page for the new row version to land beside
-- the old one. Free now; an ALTER plus a full table rewrite later.
WITH (fillfactor = 70);

-- TENANT-SCOPED, not global, and an earlier draft had this wrong.
--
-- The draft argued a global index was needed so that cross-tenant log
-- aggregation could not join two unrelated traces. It is not: the correlation
-- context in `packages/observability` carries `tenantId` ALONGSIDE
-- `sessionCorrelationId`, so the join key in the aggregated store is already
-- the pair. The global form bought the difference between a 2^-128 collision
-- and a failed login, and cost a real thing — UNIQUE INDEX ENFORCEMENT IS NOT
-- SUBJECT TO RLS, so a 23505 on a globally unique column is a cross-tenant
-- existence oracle that pierces ADR-0004, and one tenant's row can fail
-- another tenant's insert. Measured on this schema:
--
--   tenant A: SELECT ... WHERE token_hash = <B's hash>  ->  0 rows
--   tenant A: INSERT   ... token_hash = <B's hash>      ->  23505
--
-- The draft also attributed a global-namespace requirement to ADR-0016 §5,
-- which says only "minted per session" and "random, not derived".
CREATE UNIQUE INDEX sessions_correlation_key
  ON sessions (tenant_id, session_correlation_id);

-- "Which sessions does this user have open" — the revoke-all-sessions path,
-- and the one an administrator asks during an incident.
CREATE INDEX sessions_user_idx ON sessions (tenant_id, user_id, created_at DESC);

-- The live-session sweep. PARTIAL, because revoked sessions accumulate
-- forever (rule 4: no DELETE) while the live set stays small.
-- `last_seen_at` is deliberately NOT in this index. It changes on every
-- authenticated request, and an indexed column that changes on every write
-- makes every update non-HOT: a new index tuple per request, bloating heap
-- and index together. The live set per tenant is small enough to scan.
-- The application must additionally throttle the write itself — update
-- `last_seen_at` only when it is already older than about a minute — an
-- application obligation this schema cannot enforce and W1-003 must honour.
CREATE INDEX sessions_live_idx ON sessions (tenant_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE sessions IS
  'ADR-0009. One signed-in session in one tenant. The revocation handle a JWT cannot provide: a token cannot be un-issued, so this row is what says no.';
COMMENT ON COLUMN sessions.session_correlation_id IS
  'ADR-0016 §5. The non-secret identifier that appears in logs INSTEAD of the session id. Its entropy is a schema fact because finsoft_app holds no INSERT grant on this column and so cannot name it — the DEFAULT alone would be overridable by any caller that did. The scid_ prefix ENABLES the closure of ADR-0016 debt D8 — it does not close it: asSessionCorrelationId() still requires a UUID and would reject this format, so the guard change, this format and the ADR-0016 correction land together.';
COMMENT ON COLUMN sessions.mfa_at IS
  'ADR-0009:119. A timestamp, not a boolean: step-up re-authentication needs MFA RECENCY, which a flag cannot express.';
COMMENT ON COLUMN sessions.permission_version IS
  'ADR-0009:102. Bumped when roles change; a token behind this version is refused at the guard, so a privilege reduction takes effect on the next request.';
COMMENT ON COLUMN sessions.updated_by IS
  'NOT pinned to created_by, unlike outbox: an administrator revoking another user''s session is a legitimate write by a different actor. NOTE: nothing here verifies this is the acting principal — the audit record is the authority (rule 9).';

-- ---------------------------------------------------------------------------
-- Token families
--
-- A family is one rotation chain: R1 -> R2 -> R3, all descending from a
-- single login. Reuse detection revokes the family, so the family needs to be
-- a row that can be revoked in one write — not a property recomputed by
-- walking `replaced_by` pointers, which is both slower and a chance to walk
-- them wrong while an attacker holds a live token.
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_token_families (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id      uuid        NOT NULL,

  -- Set when reuse is detected, or cascaded from the session by
  -- `sessions_cascade_revocation()` below. Until that trigger existed this
  -- comment described a cascade that was written nowhere — in the schema or
  -- in code — and session revocation stopped nothing.
  revoked_at      timestamptz,
  revoked_reason  text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  version         integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT rtf_revoked_is_paired
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT rtf_revoked_reason_bounded
    CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 200),

  CONSTRAINT rtf_session_fkey
    FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT rtf_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT rtf_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT rtf_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX rtf_session_idx ON refresh_token_families (tenant_id, session_id);

COMMENT ON TABLE refresh_token_families IS
  'ADR-0009. One rotation chain from one login. Reuse detection revokes the FAMILY, so it is a row rather than a walk over replaced_by pointers.';

-- ---------------------------------------------------------------------------
-- Refresh tokens
--
-- HASHED AT REST. The raw 256-bit value exists in the response body and the
-- client's cookie and nowhere else — never in a column, never in a log. A
-- database read must not yield anything that can authenticate, which is the
-- difference between a stolen backup being an incident and being a breach.
--
-- SHA-256 and not argon2id, deliberately, and the reasoning differs from the
-- password column: this value is 256 bits of CSPRNG output, so it has no
-- guessable structure and nothing to slow down. A deliberately slow hash on
-- the refresh path would add latency to every token rotation to defend
-- against an attack — offline brute force of a full-entropy random value —
-- that is not available. Passwords are low-entropy and human-chosen, which is
-- why they get argon2id and this does not. ADR-0009:85 specifies SHA-256.
--
-- UNLIKE `sessions.session_correlation_id`, THIS COLUMN CANNOT HAVE A
-- DEFAULT: the raw token must be generated in the application, because the
-- database must never see the value it is the hash of. Its entropy therefore
-- remains an application promise rather than a schema fact — a residual that
-- ADR-0021 records rather than asserts away, and the reason that ADR's
-- condition 5 is a review gate with a test over the production minter.
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  family_id       uuid        NOT NULL,

  -- SHA-256 of the raw token, lowercase hex. Never the raw token.
  token_hash      text        NOT NULL,

  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,

  -- NULL until the token is spent. The single-use fence: see the header.
  used_at         timestamptz,

  -- The token this one was rotated into. Evidence, not a lookup path —
  -- revocation goes through the family.
  replaced_by     uuid,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  version         integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT rt_hash_shape
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  -- A token that expires before it is issued is a clock or a caller bug, and
  -- either way it must not be storable.
  CONSTRAINT rt_expires_after_issue
    CHECK (expires_at > issued_at),

  -- ADR-0009:24 specifies ~14 days.
  --
  -- ON ITS OWN THIS CONSTRAINT STOPS NOTHING, because it is relative to a
  -- caller-supplied `issued_at`. Measured against the draft that shipped only
  -- this CHECK: `issued_at = now() + 350 days, expires_at = now() + 364 days`
  -- was ACCEPTED — a 364-day refresh credential — and the test named
  -- "refuses a token that outlives ADR-0009's ceiling" passed green over it.
  -- `refresh_tokens_reject_future_issue()` below is what anchors `issued_at`
  -- to the server clock; the pair is the control, not this line.
  --
  -- A CHECK cannot do the anchoring itself: `now()` is not immutable and
  -- PostgreSQL refuses it in a CHECK constraint.
  CONSTRAINT rt_lifetime_ceiling
    CHECK (expires_at <= issued_at + interval '14 days'),

  -- `replaced_by` exists exactly when the token has been spent. A rotation
  -- that set one without the other would leave a chain that cannot be walked.
  CONSTRAINT rt_replaced_implies_used
    CHECK (replaced_by IS NULL OR used_at IS NOT NULL),

  CONSTRAINT rt_not_self
    CHECK (replaced_by IS NULL OR replaced_by <> id),

  CONSTRAINT rt_family_fkey
    FOREIGN KEY (tenant_id, family_id) REFERENCES refresh_token_families (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT rt_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT rt_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT rt_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT rt_replaced_by_fkey
    FOREIGN KEY (tenant_id, replaced_by) REFERENCES refresh_tokens (tenant_id, id) ON DELETE RESTRICT
);

-- GLOBALLY unique, not per tenant, and this is the presentation path.
--
-- REQUIRES ADR-0021, WHICH SUPERSEDES ADR-0003:28 FOR THIS ONE CASE. This
-- migration must not merge before that ADR is Accepted.
--
-- A refresh token arrives as a bare value in a cookie with NO tenant context
-- — establishing the tenant is what presenting it is FOR. The necessity is
-- not merely that a tenant-scoped index would be awkward to use, which is how
-- an earlier draft put it. Under `(tenant_id, token_hash)` THE SAME HASH MAY
-- LEGITIMATELY EXIST IN TWO TENANTS, so the by-hash lookup would have to
-- tolerate several rows and pick one, in response to an unauthenticated
-- request. Picking wrong means spending the wrong tenant's token or revoking
-- the wrong tenant's family: a cross-tenant write, rule 8. Global uniqueness
-- here is a correctness property, not an optimisation.
--
-- The cost is real and is recorded in ADR-0021 rather than dismissed: on this
-- one path, isolation rests on 256 bits of entropy instead of on RLS.
CREATE UNIQUE INDEX rt_token_hash_key ON refresh_tokens (token_hash);

CREATE INDEX rt_family_idx ON refresh_tokens (tenant_id, family_id, issued_at);

COMMENT ON TABLE refresh_tokens IS
  'ADR-0009. Opaque 256-bit values, hashed at rest, single-use, rotated on every use. Presenting a spent token revokes the family — whoever presented it.';
COMMENT ON COLUMN refresh_tokens.used_at IS
  'The single-use fence. Set once, never cleared: the column grant bounds WHICH columns change, refresh_tokens_enforce_transition() bounds which DIRECTION. Without the trigger, one UPDATE un-spends the token.';
COMMENT ON COLUMN refresh_tokens.token_hash IS
  'SHA-256 of the raw token. The raw value is never stored, so this column cannot have a DEFAULT and its entropy stays an application promise — see ADR-0021 condition 5.';

-- ---------------------------------------------------------------------------
-- Transition enforcement
--
-- THE HALF AN EARLIER DRAFT OMITTED. A column grant says which columns
-- application code may write; only a trigger says which direction they may
-- move. Every rule below was reachable by `finsoft_app` under RLS before
-- these existed — measured, not theorised.
--
-- BEFORE row triggers run before CHECK constraints, so these win any race
-- with the CHECKs above. They are written in terms of OLD and NEW rather than
-- as CHECK constraints because A CHECK CANNOT SEE OLD: a constraint can say
-- "revoked_at is paired with a reason", but only a trigger can say
-- "revoked_at was already set and must not change".
-- ---------------------------------------------------------------------------

CREATE FUNCTION sessions_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Identity never moves. finsoft_app holds no UPDATE grant on these, so this
  -- is defence in depth against a future grant widened without review.
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by
     OR NEW.session_correlation_id <> OLD.session_correlation_id THEN
    RAISE EXCEPTION 'sessions: identity and authorship columns are immutable (session %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Revocation is terminal. ADR-0009 calls this the whole reason sessions are
  -- a table; un-revoking would restore access an administrator had removed.
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
          OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'sessions: revocation is terminal and cannot be cleared or re-dated (session %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- MFA recency moves forward only. Step-up re-authentication legitimately
  -- re-dates it, so this is monotonic rather than set-once — but it must
  -- never be cleared or back-dated, which would forge freshness.
  IF OLD.mfa_at IS NOT NULL AND (NEW.mfa_at IS NULL OR NEW.mfa_at < OLD.mfa_at) THEN
    RAISE EXCEPTION 'sessions: mfa_at may move forward only (session %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.permission_version < OLD.permission_version THEN
    RAISE EXCEPTION 'sessions: permission_version may not move backward (session %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'sessions: last_seen_at may not move backward (session %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- An optimistic lock that can be wound back is not a lock.
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'sessions: version must increase on every update (session %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER sessions_enforce_transition
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_enforce_transition();

CREATE FUNCTION rtf_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.session_id <> OLD.session_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'refresh_token_families: identity and authorship columns are immutable (family %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The response to detected reuse. If it can be undone, reuse detection does
  -- not durably stop anything.
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
    RAISE EXCEPTION 'refresh_token_families: revocation is terminal (family %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'refresh_token_families: version must increase on every update (family %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER rtf_enforce_transition
  BEFORE UPDATE ON refresh_token_families
  FOR EACH ROW EXECUTE FUNCTION rtf_enforce_transition();

CREATE FUNCTION refresh_tokens_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE family_revoked timestamptz;
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.family_id <> OLD.family_id
     OR NEW.token_hash <> OLD.token_hash OR NEW.issued_at <> OLD.issued_at
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'refresh_tokens: a token identity is immutable; it may only be spent (token %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE FENCE. Spending is one-way: without this, `SET used_at = NULL`
  -- restores the token and it can be spent again, defeating single use
  -- entirely. That sequence was measured to succeed before this trigger.
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    RAISE EXCEPTION 'refresh_tokens: used_at is set once and never cleared or re-dated (token %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.replaced_by IS NOT NULL AND NEW.replaced_by IS DISTINCT FROM OLD.replaced_by THEN
    RAISE EXCEPTION 'refresh_tokens: replaced_by is set once and never rewritten (token %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  /*
   * A TOKEN IN A REVOKED FAMILY MUST NOT SPEND.
   *
   * Without this the schema said "revocation must be effective, not merely
   * recorded" and delivered the opposite: measured, after reuse detection
   * revoked a family, spending an unspent sibling token still returned
   * rowcount 1 — which the header decodes as "this caller won the race and
   * may rotate". Reuse detection implies an unspent sibling exists; that is
   * what makes it reuse. So this was the live case, not a hypothetical one.
   *
   * Gated on the spend TRANSITION so it costs one primary-key lookup on the
   * refresh path and nothing on any other update. FOR SHARE for the same
   * reason as the INSERT guards below — see the lock-order note in the
   * header.
   */
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL THEN
    SELECT f.revoked_at INTO family_revoked
      FROM refresh_token_families f
     WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.family_id
       FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'refresh_tokens: family % is not visible in tenant %', NEW.family_id, NEW.tenant_id
        USING ERRCODE = 'check_violation';
    END IF;

    IF family_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'refresh_tokens: family % was revoked at %; token % may not be spent',
        NEW.family_id, family_revoked, OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'refresh_tokens: version must increase on every update (token %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER refresh_tokens_enforce_transition
  BEFORE UPDATE ON refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION refresh_tokens_enforce_transition();

-- ---------------------------------------------------------------------------
-- Revocation must be effective, not merely recorded
--
-- Revoking a family stops its EXISTING tokens. It did not stop a NEW token
-- being appended to it, which would hand back exactly the access the
-- revocation removed — real in the audit trail and void in practice. Same for
-- a family opened under a revoked session.
-- ---------------------------------------------------------------------------

CREATE FUNCTION refresh_tokens_reject_revoked_family() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE revoked timestamptz;
BEGIN
  SELECT f.revoked_at INTO revoked
    FROM refresh_token_families f
   WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.family_id
     FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refresh_tokens: family % is not visible in tenant %', NEW.family_id, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF revoked IS NOT NULL THEN
    RAISE EXCEPTION 'refresh_tokens: family % was revoked at %; no further tokens may be issued into it',
      NEW.family_id, revoked USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER refresh_tokens_reject_revoked_family
  BEFORE INSERT ON refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION refresh_tokens_reject_revoked_family();

/*
 * `issued_at` IS ANCHORED TO THE SERVER CLOCK. Rule 13.
 *
 * Without this, `rt_lifetime_ceiling` is measured from a value the caller
 * chose, so future-dating `issued_at` buys an arbitrarily long credential:
 * `now() + 350 days` / `now() + 364 days` was accepted, yielding a 364-day
 * refresh token against an ADR that specifies ~14.
 *
 * Back-dating stays legal — it is how a test mints an already-expired token,
 * and a back-dated token is strictly less useful to a holder, not more.
 */
CREATE FUNCTION refresh_tokens_reject_future_issue() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.issued_at > now() THEN
    RAISE EXCEPTION 'refresh_tokens: issued_at % is in the future; the server clock sets it (rule 13)', NEW.issued_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER refresh_tokens_reject_future_issue
  BEFORE INSERT ON refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION refresh_tokens_reject_future_issue();

CREATE FUNCTION rtf_reject_revoked_session() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE revoked timestamptz;
BEGIN
  SELECT s.revoked_at INTO revoked
    FROM sessions s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.session_id
     FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refresh_token_families: session % is not visible in tenant %', NEW.session_id, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF revoked IS NOT NULL THEN
    RAISE EXCEPTION 'refresh_token_families: session % was revoked at %; no further families may be opened under it',
      NEW.session_id, revoked USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER rtf_reject_revoked_session
  BEFORE INSERT ON refresh_token_families
  FOR EACH ROW EXECUTE FUNCTION rtf_reject_revoked_session();

/*
 * REVOKING A SESSION REVOKES ITS FAMILIES. Without this, it revoked nothing.
 *
 * Measured before this trigger existed: an administrator terminates a
 * session, the family is untouched, its refresh token spends normally, and a
 * brand-new token is appended to the same still-live family. The chain keeps
 * rotating indefinitely. `rtf_reject_revoked_session` above never fires,
 * because it only blocks opening a NEW family and an attacker has no need to
 * open one.
 *
 * So the claim at the top of this file — that a session row is "the
 * revocation handle a JWT cannot provide ... something outside it must be
 * able to say no" — was false in the only direction that matters. This makes
 * the cascade a schema fact rather than an application convention, because an
 * application that forgets it produces a revocation that is real in the audit
 * trail and void in practice.
 *
 * `WHERE revoked_at IS NULL` is load-bearing: without it the cascade would
 * re-revoke an already-revoked family and trip rtf_enforce_transition's own
 * terminal-revocation check. Authorship is NEW.updated_by — the actor who
 * revoked the session, which is the right attribution. No new grant is
 * needed: finsoft_app already holds exactly these five columns on families.
 */
CREATE FUNCTION sessions_cascade_revocation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE refresh_token_families
     SET revoked_at     = NEW.revoked_at,
         revoked_reason = NEW.revoked_reason,
         updated_by     = NEW.updated_by,
         version        = version + 1
   WHERE tenant_id = NEW.tenant_id
     AND session_id = NEW.id
     AND revoked_at IS NULL;

  RETURN NULL;
END;
$fn$;

CREATE TRIGGER sessions_cascade_revocation
  AFTER UPDATE ON sessions
  FOR EACH ROW
  WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION sessions_cascade_revocation();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- ENABLE turns policies on for ordinary roles; FORCE applies them to the
-- OWNER too. Without FORCE the owner silently sees every tenant, and ADR-0004
-- treats ENABLE-without-FORCE as unprotected.
--
-- current_setting WITHOUT missing_ok, deliberately: unset must RAISE. With
-- `true` it returns NULL, the comparison becomes NULL, and a loud failure
-- becomes a silent zero-row read — which on a session lookup reads as "no
-- such session" and would log a user out rather than erroring.
--
-- NOTE FOR THE LOGIN PATH. Presenting a refresh token happens before any
-- tenant is established, so the hash lookup cannot run under `withTenant`.
-- `refresh_tokens` is NOT a global table and must not become one. ADR-0004:77
-- is unambiguous that a caller with no tenant operates only on global tables,
-- so NO CODE MAY READ THIS TABLE WITHOUT A TENANT until an ADR says how.
-- Recorded as D-W1-004 in docs/WAVE_1_REGISTER.md with its three conditions;
-- deliberately not pre-empted here, because every candidate mechanism looks
-- up by hash alone and none needs a column this table lacks.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions               FORCE  ROW LEVEL SECURITY;
ALTER TABLE refresh_token_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_token_families FORCE  ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens         ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens         FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sessions
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON refresh_token_families
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON refresh_tokens
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON sessions IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- set_updated_at() comes from 001. An updated_at the application must
-- remember to set is an updated_at that will eventually be wrong.
CREATE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER rtf_set_updated_at
  BEFORE UPDATE ON refresh_token_families
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER rt_set_updated_at
  BEFORE UPDATE ON refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Grants
--
-- THE REVOKE IS NOT OPTIONAL, and 004 learned this the hard way.
--
-- `00-bootstrap.sh` sets ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration
-- GRANT SELECT, INSERT, UPDATE ON TABLES TO finsoft_app, so every table here
-- arrives with TABLE-LEVEL UPDATE already granted. Table-level UPDATE
-- supersedes a column list entirely: adding one on top restricts nothing, and
-- information_schema.column_privileges lists every column including `id`.
--
-- Default privileges apply at CREATE TABLE. Nothing re-grants later — which
-- also means "granted to nobody" is satisfied by writing no GRANT while the
-- application role retains what the default handed it. The REVOKE is the
-- control; the column list is what is left afterwards.
--
-- THE SAME IS TRUE OF `readonly_support`, and the first draft of this file
-- missed it. `pg_default_acl` on this cluster reads
--
--   {finsoft_app=arw/finsoft_migration, readonly_support=r/finsoft_migration}
--
-- so every new table arrives with SELECT ALREADY GRANTED to the support role.
-- Withholding it is a REVOKE; an omitted GRANT withholds nothing. The draft
-- simply left `refresh_tokens` out of the support grants below and believed
-- that was enough, while
-- `has_table_privilege('readonly_support','refresh_tokens','SELECT')` read
-- true. Same mechanism as the UPDATE trap above, opposite role — which is
-- why the integration suite asks PostgreSQL the effective question rather
-- than reading these statements back out of the catalog.
--
-- A COLUMN GRANT IS ONLY HALF A CONTROL. It bounds which columns application
-- code may write; the transition triggers above bound which DIRECTION. Read
-- the two together — neither is sufficient alone, and the first draft of this
-- file shipped only this half while the header claimed both.
--
-- DELETE is granted to nobody. Rule 4. A revoked session is evidence that a
-- session existed and was ended, and the audit trail references it.
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON sessions               FROM finsoft_app;
REVOKE UPDATE ON refresh_token_families FROM finsoft_app;
REVOKE UPDATE ON refresh_tokens         FROM finsoft_app;

-- AND THE SAME TREATMENT FOR INSERT, which the first two drafts did not do.
--
-- A table-level INSERT grant lets a caller NAME any column, which overrides
-- every DEFAULT on the table. With it, `finsoft_app` could supply its own
-- `id`, its own `session_correlation_id` (32 chosen hex characters, CHECK
-- satisfied, zero entropy) and its own `created_at` — the last in plain
-- conflict with rule 13, which says the server's clock sets it.
--
-- Column-scoped INSERT is the same mechanism this file already applies to
-- UPDATE, and the same `ALTER DEFAULT PRIVILEGES` trap applies: the default
-- granted table-level INSERT, so the REVOKE is the control and the column
-- list is what survives it.
REVOKE INSERT ON sessions               FROM finsoft_app;
REVOKE INSERT ON refresh_token_families FROM finsoft_app;
REVOKE INSERT ON refresh_tokens         FROM finsoft_app;

-- The support role's default SELECT on the token table, withdrawn. See above.
REVOKE SELECT ON refresh_tokens         FROM readonly_support;

GRANT SELECT ON sessions               TO finsoft_app;
GRANT SELECT ON refresh_token_families TO finsoft_app;
GRANT SELECT ON refresh_tokens         TO finsoft_app;

-- What a caller may state when a session is created. Not `id`, not
-- `session_correlation_id`, not `created_at`/`updated_at`, not `last_seen_at`,
-- not `version` — those are the database's to set. Not `revoked_at`,
-- `revoked_reason` or `status` either: nothing is born revoked.
GRANT INSERT (tenant_id, user_id, mfa_at, device_id, permission_version,
              ip, user_agent, created_by, updated_by)
  ON sessions TO finsoft_app;

GRANT INSERT (tenant_id, session_id, created_by, updated_by)
  ON refresh_token_families TO finsoft_app;

-- `issued_at` IS grantable, deliberately: back-dating is how an
-- already-expired token is minted in a test, and a back-dated token is
-- strictly less useful than a fresh one. FUTURE-dating is the dangerous
-- direction, and `refresh_tokens_reject_future_issue()` is what bounds it.
GRANT INSERT (tenant_id, family_id, token_hash, issued_at, expires_at,
              created_by, updated_by)
  ON refresh_tokens TO finsoft_app;

-- What a session's lifecycle legitimately writes after INSERT: it is seen,
-- it completes MFA, it is revoked. Never its tenant, its subject or its
-- authorship.
GRANT UPDATE (last_seen_at, mfa_at, permission_version, status,
              revoked_at, revoked_reason, updated_at, updated_by, version)
  ON sessions TO finsoft_app;

-- A family is only ever revoked.
GRANT UPDATE (revoked_at, revoked_reason, updated_at, updated_by, version)
  ON refresh_token_families TO finsoft_app;

-- A token is only ever spent. `token_hash`, `family_id`, `issued_at` and
-- `expires_at` are what it IS; none of them changes.
GRANT UPDATE (used_at, replaced_by, updated_at, updated_by, version)
  ON refresh_tokens TO finsoft_app;

GRANT SELECT ON sessions               TO readonly_support;
GRANT SELECT ON refresh_token_families TO readonly_support;
-- `refresh_tokens` is deliberately absent, and the REVOKE above is what makes
-- the absence mean something. A support role reading token hashes gains
-- nothing operationally and widens the blast radius of that role being
-- compromised; the family and session rows carry everything an incident
-- actually needs.
