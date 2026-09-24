-- 002_create_users.sql
--
-- The first TENANT-OWNED table. 001 created the global tenant registry; this
-- is the first table RLS actually has to protect, and it is therefore the
-- specimen the FND-007/008 isolation gate is run against.
--
-- Everything here is the template the rest of the schema will copy, so each
-- rule is written out in full rather than assumed:
--
--   ADR-0003  tenant_id uuid NOT NULL REFERENCES tenants(id)
--             an index whose FIRST column is tenant_id
--             every unique constraint scoped by tenant
--             every FK between tenant-owned tables composite on tenant_id
--   ADR-0004  ENABLE *and* FORCE row level security, one policy, with both
--             USING and a non-null WITH CHECK
--   rule 4    no hard delete: status, never DELETE; no DELETE grant;
--             every FK ON DELETE RESTRICT, never CASCADE
--
-- How this is reversed: it is not, in place. Migrations are forward-only
-- (ADR-0013), so undoing this means a later numbered migration that drops the
-- table — a destructive statement, which the CI scan in verify.ts flags and
-- routes to Database Guardian review. Nothing in this file is destructive: it
-- only creates, so applying it cannot lose data and an aborted apply leaves
-- the schema untouched (one transaction per file).
--
-- (Written the long way round on purpose: a line beginning "-- rollback" is
-- rejected by the migration runner's forward-only check, which exists so that
-- nobody smuggles a `down` section into a file.)
--
-- Lock footprint: CREATE TABLE locks nothing that already exists, with one
-- exception — the foreign key on tenant_id takes a SHARE ROW EXCLUSIVE lock
-- on `tenants` for the duration of the transaction, which blocks writes to
-- `tenants` (not merely DDL on it). The other two foreign keys are
-- self-referential and reach nothing outside this statement. `tenants` is
-- empty or near-empty at this point in the project's life, so the lock is
-- held for microseconds and no in-flight transaction is blocked measurably.
-- When a table of this shape is added against a busy parent table later,
-- that is the statement to think twice about.

-- ---------------------------------------------------------------------------
-- users
--
-- Master data, not a transaction table. IMPLEMENTATION §11's mandatory column
-- set is carried in full anyway — id, tenant_id, created_at, created_by,
-- updated_at, updated_by, version — because every later table will copy this
-- one, and a template that omits a column teaches every copy to omit it.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ADR-0003. NOT NULL, foreign-keyed, no nullable tenant and no sentinel
  -- "global" row. RESTRICT, not CASCADE: a tenant row can never take its
  -- users down with it (rule 4).
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,

  -- Login identity. Unique per tenant, case-insensitively — see the unique
  -- index below. The CHECK is deliberately loose: it rejects whitespace, a
  -- missing @ and a missing dot, and leaves real address validation to the
  -- domain layer where the rules can be written down and tested.
  email          text        NOT NULL
                             CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),

  full_name      text        NOT NULL CHECK (length(btrim(full_name)) > 0),

  -- Argon2id hash only (ADR-0009). Never the password, never a reversible
  -- form. NULL until an invited user sets one, which is why the CHECK below
  -- ties it to status rather than making the column NOT NULL.
  password_hash  text        CHECK (password_hash IS NULL OR length(password_hash) > 0),

  -- Lifecycle, not deletion (rule 4). A user who leaves is DISABLED and keeps
  -- every audit record and every created_by reference pointing at them.
  status         text        NOT NULL DEFAULT 'INVITED'
                             CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED')),

  -- A user who can log in has a password. Making this a schema fact means an
  -- ACTIVE row with no credential cannot exist even if some future code path
  -- forgets the check.
  CONSTRAINT users_active_requires_password
    CHECK (status <> 'ACTIVE' OR password_hash IS NOT NULL),

  last_login_at  timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- created_by / updated_by are NULLABLE *only here*, and only for one row
  -- per tenant.
  --
  -- IMPLEMENTATION §11 requires created_by NOT NULL REFERENCES users(id).
  -- users is the root of that graph: the first user of a tenant is written by
  -- provisioning, at a moment when no user of that tenant exists to be named
  -- as its author. The alternatives were a self-reference (the row names
  -- itself as its own creator — a sentinel that reads as a fact and is not
  -- one) or a platform "system user" row inside every tenant (a real user
  -- that nobody is, referenced by real audit records).
  --
  -- NULL is the honest encoding of "created before any user existed", and it
  -- is bounded rather than open: users_one_provisioned_owner_per_tenant below
  -- permits at most ONE such row per tenant, and
  -- users_authorship_pair_or_neither forbids one of the pair being set
  -- without the other. database/tests/schema.spec.ts allowlists exactly this
  -- table for the exception, so a later table that copies the nullability
  -- fails the build.
  created_by     uuid,
  updated_by     uuid,

  -- Optimistic locking. The application increments it with
  -- `UPDATE ... SET version = version + 1 WHERE id = $1 AND version = $2`;
  -- no trigger does it, because a trigger that bumped the version would make
  -- the compare-and-swap above always succeed and silently remove the
  -- protection it exists to give.
  version        integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT users_authorship_pair_or_neither
    CHECK ((created_by IS NULL) = (updated_by IS NULL)),

  -- The target of the two composite foreign keys below. id is already unique
  -- on its own; this exists so that (tenant_id, created_by) has something
  -- tenant-scoped to point at, and it doubles as a tenant_id-leading index.
  CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id),

  -- ADR-0003:29 — a foreign key between tenant-owned tables is composite on
  -- tenant_id. This is not belt-and-braces over RLS: PostgreSQL performs
  -- referential integrity checks with row security OFF, so a plain
  -- `created_by REFERENCES users(id)` would happily accept another tenant's
  -- user id even with the policy below in force. The composite key is what
  -- actually makes a cross-tenant reference impossible, and
  -- tests/security/tenant-isolation.spec.ts asserts it.
  --
  -- MATCH SIMPLE (the default) is intended: when created_by is NULL the
  -- constraint does not apply, which is exactly the provisioned-owner case.
  CONSTRAINT users_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT users_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE users IS
  'Tenant-owned user accounts. tenant_id NOT NULL, RLS enabled and forced (ADR-0003, ADR-0004). Users are never deleted (rule 4).';
COMMENT ON COLUMN users.tenant_id IS
  'Owning tenant. Set from the verified JWT claim via app.tenant_id, never from request input (rule 8).';
COMMENT ON COLUMN users.password_hash IS
  'Argon2id hash (ADR-0009). Never a password, never logged, never returned by an API (rule 20).';
COMMENT ON COLUMN users.status IS
  'INVITED | ACTIVE | SUSPENDED | DISABLED. Deactivation replaces deletion (rule 4).';
COMMENT ON COLUMN users.created_by IS
  'Author. NULL only for the one provisioned owner per tenant, which existed before any user did.';
COMMENT ON COLUMN users.version IS
  'Optimistic lock. Incremented by the application in the UPDATE predicate, never by a trigger.';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
-- set_updated_at() comes from 001. An updated_at the application must
-- remember to set is an updated_at that will eventually be wrong.
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Every one of them leads with tenant_id (ADR-0003). A trailing tenant_id
-- gives the planner no way to reach one tenant's slice of the table without
-- reading the others', which is how a shared-schema table degrades as tenant
-- count grows.
-- ---------------------------------------------------------------------------

-- Login lookup, and the uniqueness rule for an address. Scoped by tenant:
-- the same person may hold an account in two tenants, and one tenant's user
-- list must never constrain another's. lower() because addresses are
-- case-insensitive in practice and 'A@x.com' and 'a@x.com' are one login.
CREATE UNIQUE INDEX users_tenant_email_key ON users (tenant_id, lower(email));

-- The common list query: this tenant's active users.
CREATE INDEX users_tenant_status_idx ON users (tenant_id, status);

-- At most one provisioned owner per tenant. This is what keeps the nullable
-- created_by above a bounded exception rather than an open door: a second row
-- claiming to predate every user of its tenant is rejected by the database.
CREATE UNIQUE INDEX users_one_provisioned_owner_per_tenant
  ON users (tenant_id) WHERE created_by IS NULL;

-- No index on (tenant_id, created_by) deliberately. The usual reason to index
-- the referencing side of a foreign key is to keep ON DELETE checks from
-- seq-scanning, and rule 4 means no row here is ever deleted. Add it when a
-- query actually asks "what did this user create", not before.

-- ---------------------------------------------------------------------------
-- Row Level Security — ADR-0004
--
-- ENABLE turns policies on for ordinary roles. FORCE applies them to the
-- table owner as well, which matters because finsoft_migration owns this
-- table; without FORCE the owner silently sees every tenant. ADR-0004:46
-- treats a table with ENABLE but not FORCE as unprotected, and
-- database/tests/rls.spec.ts fails the build on one.
--
-- current_setting('app.tenant_id') RAISES when the setting is absent, and
-- that is the intended behaviour (ADR-0004:77): a transaction that reaches
-- this table without establishing a tenant gets an error, not a permissive
-- empty-predicate read. No cluster default for app.tenant_id exists, by
-- design.
--
-- Note for whoever writes the next policy: no second argument to
-- current_setting. current_setting('app.tenant_id', true) returns NULL when
-- unset, the comparison becomes NULL, and the loud failure turns into a
-- silent zero-row read that looks like "no data" instead of "no tenant".
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON users
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON users IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- Restated rather than left to the cluster default privileges from FND-005,
-- for the same reason 001 restates them: a reader of this file should not
-- have to know what the container init script did.
--
-- DELETE is granted to nobody. Rule 4.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON users TO finsoft_app;
GRANT SELECT                 ON users TO readonly_support;
