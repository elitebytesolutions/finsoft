-- 008_create_rbac.sql
--
-- Role-based access control. ARCHITECTURE §8, ADR-0009 (privileged permissions,
-- permission_version), NON_NEGOTIABLES rules 4, 7, 8, 9, 18.
--
-- Three tables:
--
--   roles             a named bundle of permissions, per tenant
--   role_permissions  which atomic permission codes a role currently grants
--   user_roles        which roles a user currently holds
--
-- The catalogue of permission CODES is not enforced here. ARCHITECTURE §8 is
-- explicit that packages/permissions is the single source of truth ("a
-- permission that is not in the catalogue does not exist"); a CHECK
-- enumerating codes in this file would be a second source of truth that
-- silently drifts the day a code is added to the TypeScript catalogue and not
-- here. `role_permissions.permission_code` is therefore shape-checked
-- (namespace.action) and nothing more — the same division of labour the
-- codebase already draws between a CHECK on `status` (a closed set the schema
-- owns) and free text validated in the domain layer (ADR-0003's template
-- comment on users.email makes the same call).
--
-- Follows the 002/005 template throughout: the mandatory column set
-- (IMPLEMENTATION §11), composite authorship foreign keys, ENABLE and FORCE
-- row level security with both USING and WITH CHECK, column-scoped grants
-- backed by transition-enforcement triggers (a grant says which columns may
-- change; only a trigger says which DIRECTION), and no DELETE grant to
-- anyone (rule 4) — revocation is a `revoked_at`/`revoked_by` pair, never a
-- row removed.
--
-- ---------------------------------------------------------------------------
-- permission_version: bumping users.version, not a new column
--
-- ADR-0009:102 (as-accepted numbering; see the notice at the head of
-- ADR-0009) ties permission staleness to `sessions.permission_version`: "a
-- token whose version is behind is refused at the guard". That column lives
-- in migration 005, which this lane does not own and must not touch — both
-- because 005 is a released, immutable file (ADR-0013) and because the
-- auth lane owns concurrent, uncommitted work against that same table.
--
-- `users.version` (migration 002) already exists, is already column-scoped
-- UPDATE-granted to finsoft_app (migration 007 narrowed the users grant from
-- table-level to a named column list, `version` included), and is the
-- optimistic-lock counter every future write to a user row already compares
-- against. This migration bumps
-- it, via trigger, whenever a user's effective permission set changes:
-- directly on a `user_roles` grant/revoke, and transitively on every user
-- holding a role whose `role_permissions` change. That is not a misuse of
-- optimistic locking — any change to the row's authority is a legitimate
-- reason to tell a concurrent writer "re-read before you write" — it is
-- simply a coarser signal than a dedicated counter would be. The auth lane's
-- `perm_ver` JWT claim is 0 and unwired today; when it is wired, its guard
-- compares a session's minted snapshot against this counter (or a value
-- derived from it) to force a refresh. Recorded as a decision in
-- docs/briefs/M1-R-rbac.md rather than assumed silently.
--
-- DB-C3: this comment documents the column's SECOND use without touching
-- migration 002, which created it and is immutable (ADR-0013). COMMENT ON
-- COLUMN is metadata, not a schema change to the column itself, and is the
-- sanctioned way a later migration annotates an earlier one's object.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN users.version IS
  'Optimistic lock, incremented by the application in the UPDATE predicate (migration 002). '
  'ALSO bumped by 008_create_rbac.sql''s permission_version cascade whenever this user''s '
  'effective permissions change — a role grant/revocation, a change to a role''s permission '
  'set, or a change to a held role''s status. Both uses share one counter deliberately: any '
  'change to what this row means is a legitimate reason for a concurrent writer to re-read '
  'before it writes again. See 008''s header for why this is not a dedicated column.';

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,

  -- Stable, machine-referenced identity. Lower snake case; the three system
  -- roles use 'owner', 'accountant', 'viewer'. Unique per tenant, see below.
  code           text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),

  name           text        NOT NULL CHECK (length(btrim(name)) > 0),

  -- System roles (Owner / Accountant / Viewer) are seeded by
  -- seedSystemRoles() at tenant provisioning and are not created by a
  -- tenant admin. is_system is immutable once set (roles_enforce_transition
  -- below) so a custom role cannot be relabelled into a system one.
  is_system      boolean     NOT NULL DEFAULT false,

  -- Lifecycle, not deletion (rule 4). A tenant retires a custom role by
  -- deactivating it; its history (role_permissions, user_roles) stays intact
  -- and referenceable.
  status         text        NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE', 'INACTIVE')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  version        integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT roles_tenant_id_id_key UNIQUE (tenant_id, id),

  -- ADR-0003:29 — composite on tenant_id. Referential integrity checks run
  -- with row security off, so a single-column FK would accept another
  -- tenant's user as author.
  CONSTRAINT roles_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT roles_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- Case-insensitive, tenant-scoped, exactly as users_tenant_email_key.
CREATE UNIQUE INDEX roles_tenant_code_key ON roles (tenant_id, lower(code));
CREATE INDEX roles_tenant_status_idx ON roles (tenant_id, status);

COMMENT ON TABLE roles IS
  'ARCHITECTURE §8. A named bundle of permissions, per tenant. Tenant-owned, RLS enabled and forced. Never deleted (rule 4) — retired roles are INACTIVE.';
COMMENT ON COLUMN roles.is_system IS
  'Seeded by seedSystemRoles() at provisioning (Owner/Accountant/Viewer). Immutable once set.';
COMMENT ON COLUMN roles.status IS
  'ACTIVE | INACTIVE. A retired role keeps its role_permissions and user_roles history.';

-- ---------------------------------------------------------------------------
-- role_permissions
--
-- One row per (role, permission code) ever granted. Revoking a permission
-- from a role sets revoked_at/revoked_by on the existing row rather than
-- deleting it — the grant, once made, is permanent history; only its current
-- effect is toggled.
-- ---------------------------------------------------------------------------
CREATE TABLE role_permissions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  role_id         uuid        NOT NULL,

  -- Namespace.action shape only. The catalogue in packages/permissions is
  -- the single source of truth for which codes exist (ARCHITECTURE §8); see
  -- the file header for why this is not a CHECK-enumerated list.
  permission_code text        NOT NULL CHECK (permission_code ~ '^[a-z_]+\.[a-z_]+$'),

  revoked_at      timestamptz,
  revoked_by      uuid,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  version         integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT role_permissions_revoked_is_paired
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),

  CONSTRAINT role_permissions_tenant_id_id_key UNIQUE (tenant_id, id),

  CONSTRAINT role_permissions_role_fkey
    FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT role_permissions_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT role_permissions_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  -- Nullable: MATCH SIMPLE (the default) means the constraint does not apply
  -- while revoked_by is NULL, i.e. before the grant is ever revoked.
  CONSTRAINT role_permissions_revoked_by_fkey
    FOREIGN KEY (tenant_id, revoked_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- At most one LIVE grant of a given code to a given role. A revoked grant
-- does not block re-granting the same code later — that is a new row.
--
-- ALSO the index "what does this role currently grant" (resolvePermissions)
-- and the role_permissions_bump_permission_version cascade need: both filter
-- on (tenant_id, role_id) WHERE revoked_at IS NULL, which is a strict PREFIX
-- of this index's columns and predicate. A separate role_permissions_role_idx
-- would therefore be redundant — Database Guardian review, DB-C5 — and is not
-- created.
CREATE UNIQUE INDEX role_permissions_active_unique
  ON role_permissions (tenant_id, role_id, permission_code) WHERE revoked_at IS NULL;

COMMENT ON TABLE role_permissions IS
  'ARCHITECTURE §8. Which atomic permission codes a role currently grants. Revocation is revoked_at/revoked_by, never a delete (rule 4).';
COMMENT ON COLUMN role_permissions.permission_code IS
  'Shape-checked only (namespace.action). packages/permissions is the catalogue of which codes exist.';

-- ---------------------------------------------------------------------------
-- user_roles
--
-- One row per (user, role) assignment ever made. Same revoke-by-column shape
-- as role_permissions, for the same reason.
-- ---------------------------------------------------------------------------
CREATE TABLE user_roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  user_id     uuid        NOT NULL,
  role_id     uuid        NOT NULL,

  revoked_at  timestamptz,
  revoked_by  uuid,

  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        NOT NULL,
  version     integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT user_roles_revoked_is_paired
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),

  CONSTRAINT user_roles_tenant_id_id_key UNIQUE (tenant_id, id),

  -- The composite FK that makes cross-tenant role assignment impossible even
  -- with row security off (referential integrity checks bypass RLS):
  -- tenant A cannot assign tenant A's user a role that lives in tenant B,
  -- and cannot assign a role in tenant A to a user who lives in tenant B,
  -- because both halves of the pair must resolve inside the SAME tenant_id.
  CONSTRAINT user_roles_user_fkey
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT user_roles_role_fkey
    FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT user_roles_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT user_roles_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT user_roles_revoked_by_fkey
    FOREIGN KEY (tenant_id, revoked_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- At most one LIVE assignment of a given role to a given user.
--
-- ALSO the index resolvePermissions(tx, userId) needs — "which roles does
-- this user currently hold" filters on (tenant_id, user_id) WHERE revoked_at
-- IS NULL, a strict PREFIX of this index. A separate user_roles_user_idx
-- would be redundant (Database Guardian review, DB-C5) and is not created.
CREATE UNIQUE INDEX user_roles_active_unique
  ON user_roles (tenant_id, user_id, role_id) WHERE revoked_at IS NULL;

-- The OTHER direction, which the unique index above cannot serve because
-- role_id is not its leading column: role_permissions_bump_permission_version
-- and roles_bump_permission_version both ask "which users currently hold
-- this role".
CREATE INDEX user_roles_role_idx
  ON user_roles (tenant_id, role_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE user_roles IS
  'ARCHITECTURE §8. Which roles a user currently holds. The composite FKs on both user_id and role_id make cross-tenant assignment impossible even with row security off (ADR-0003:29).';

-- ---------------------------------------------------------------------------
-- Triggers — updated_at
-- ---------------------------------------------------------------------------
CREATE TRIGGER roles_set_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER role_permissions_set_updated_at
  BEFORE UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_roles_set_updated_at
  BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Transition enforcement
--
-- The lesson migration 005 paid for in full: a column grant bounds WHICH
-- columns application code may write; only a trigger bounds which DIRECTION
-- they move in. Every rule below is reachable by finsoft_app under RLS
-- before these exist.
-- ---------------------------------------------------------------------------

CREATE FUNCTION roles_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.code <> OLD.code
     OR NEW.is_system <> OLD.is_system
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'roles: identity (code, is_system) and authorship are immutable (role %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'roles: version must increase on every update (role %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER roles_enforce_transition
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION roles_enforce_transition();

CREATE FUNCTION role_permissions_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.role_id <> OLD.role_id
     OR NEW.permission_code <> OLD.permission_code
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'role_permissions: a grant''s identity is immutable; it may only be revoked (grant %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Revocation is terminal, exactly as sessions.revoked_at. A cleared
  -- revocation would silently reinstate a permission an administrator
  -- removed.
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'role_permissions: revocation is terminal and cannot be cleared or re-dated (grant %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'role_permissions: version must increase on every update (grant %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER role_permissions_enforce_transition
  BEFORE UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION role_permissions_enforce_transition();

CREATE FUNCTION user_roles_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id
     OR NEW.role_id <> OLD.role_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'user_roles: an assignment''s identity is immutable; it may only be revoked (assignment %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'user_roles: revocation is terminal and cannot be cleared or re-dated (assignment %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'user_roles: version must increase on every update (assignment %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER user_roles_enforce_transition
  BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_enforce_transition();

-- ---------------------------------------------------------------------------
-- permission_version cascade: bump users.version when effective permissions
-- change. See the file header for why the target is users.version rather
-- than a new column or sessions.permission_version.
--
-- SECURITY INVOKER (the default): these run as finsoft_app, the same role
-- that performed the triggering INSERT/UPDATE, inside the same transaction
-- and therefore the same app.tenant_id. The cascade's own UPDATE is filtered
-- to NEW.tenant_id, which RLS has already proven equals the session's
-- tenant — there is no cross-tenant reach here, and no elevation is needed.
--
-- version ONLY — updated_by is deliberately left untouched. Measured against
-- an earlier draft that also set updated_by = NEW.updated_by: it raised
-- users_authorship_pair_or_neither (migration 002) the first time the
-- affected user was the tenant's provisioned owner, whose created_by is NULL
-- by design — stamping updated_by on that one row breaks the pairing the
-- CHECK exists to protect. It is also the more honest attribution: a role
-- change is authored on the user_roles/role_permissions row itself
-- (created_by/updated_by there), not as an edit to the user's own profile,
-- and users.updated_at/updated_by must keep meaning "who last touched this
-- user's own fields", which this cascade does not do.
--
-- ---------------------------------------------------------------------------
-- DB-C2: LOCK ORDER, declared rather than left to the plan (migration 005's
-- own words for the same discipline). docs/LOCK_REGISTRY.md records this
-- globally; it is restated here because a reader of this file should not
-- have to go elsewhere to see why a trigger body takes the locks it does.
--
--   roles  ->  users (by id, ascending)
--
-- THE RACE THIS CLOSES. An earlier form of these two functions took no lock
-- on `roles` and updated the matching `users` rows via a single
-- `UPDATE ... WHERE EXISTS (...)`, leaving PostgreSQL to choose the row-lock
-- order. Two cascades that can affect an OVERLAPPING set of `users` rows —
-- concretely, revoking a permission from role R (role_permissions path,
-- which updates every CURRENT holder of R) running concurrently with
-- granting or revoking role R itself for one of those same holders
-- (user_roles path, which updates exactly that one user) — could each hold
-- one contested row and wait for the other, which PostgreSQL reports as
-- 40P01. tests/integration/rbac-lock-order.spec.ts reproduces it against the
-- pre-fix form with two real connections.
--
-- THE FIX HAS TWO PARTS, and either alone is insufficient:
--
--   1. Lock the ROLE FIRST. The role_permissions path takes FOR UPDATE
--      (this cascade is a consequence of a WRITE to the role's permission
--      set); the user_roles path takes FOR SHARE (this cascade only READS
--      which role was assigned/revoked). Two cascades over the SAME role_id
--      now serialise through one lock acquired before either touches
--      `users`, which is what stops them interleaving their `users` locks
--      in the first place. `roles_bump_permission_version` below needs no
--      such step: it fires on an UPDATE of `roles` itself, so the row is
--      already locked by the statement that fired the trigger.
--
--   2. Lock the AFFECTED USERS in a FIXED, GLOBAL ORDER — ascending `id` —
--      one row at a time via an explicit loop, before the bulk UPDATE.
--      `SELECT ... ORDER BY id FOR UPDATE` does NOT guarantee PostgreSQL
--      ACQUIRES the locks in that order (only that matching rows are
--      RETURNED in that order); the loop's single-row `PERFORM ... FOR
--      UPDATE` per iteration is what actually fixes the acquisition order.
--      This is what stops two cascades over roles R1 and R2 that happen to
--      share members from deadlocking on EACH OTHER even after (1) — (1)
--      only rules out a cycle through the same role_id.
-- ---------------------------------------------------------------------------

CREATE FUNCTION user_roles_bump_permission_version() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- FOR SHARE: this cascade only reads which role was assigned or revoked.
  -- Still serialises against a concurrent role_permissions/roles cascade for
  -- the SAME role, which is what DB-C2 relies on for the specific race named
  -- above.
  PERFORM 1 FROM roles WHERE tenant_id = NEW.tenant_id AND id = NEW.role_id FOR SHARE;

  PERFORM 1 FROM users WHERE tenant_id = NEW.tenant_id AND id = NEW.user_id FOR UPDATE;

  UPDATE users
     SET version = version + 1
   WHERE tenant_id = NEW.tenant_id
     AND id        = NEW.user_id;
  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION user_roles_bump_permission_version() IS
  'ARCHITECTURE §8 / ADR-0009. A role grant or revocation changes what its user may do; bumping users.version tells a concurrent optimistic-lock writer (and, once wired, the auth guard) that this user''s row is stale. Lock order: roles (FOR SHARE) then users — docs/LOCK_REGISTRY.md, DB-C2.';

CREATE TRIGGER user_roles_bump_permission_version_ins
  AFTER INSERT ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_bump_permission_version();

CREATE TRIGGER user_roles_bump_permission_version_rev
  AFTER UPDATE ON user_roles
  FOR EACH ROW
  WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION user_roles_bump_permission_version();

CREATE FUNCTION role_permissions_bump_permission_version() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  affected_user_id uuid;
BEGIN
  -- FOR UPDATE: this cascade is a consequence of a WRITE to the role's
  -- permission set. See the header above for the race this closes.
  PERFORM 1 FROM roles WHERE tenant_id = NEW.tenant_id AND id = NEW.role_id FOR UPDATE;

  -- Every user who currently, actively holds the affected role: adding or
  -- removing a permission from a role changes what all of them may do.
  -- Locked ONE ROW PER STATEMENT, in ascending id order — see the header for
  -- why ORDER BY on the SELECT alone would not guarantee this.
  FOR affected_user_id IN
    SELECT u.id
      FROM users u
     WHERE u.tenant_id = NEW.tenant_id
       AND EXISTS (
         SELECT 1
           FROM user_roles ur
          WHERE ur.tenant_id   = NEW.tenant_id
            AND ur.role_id     = NEW.role_id
            AND ur.user_id     = u.id
            AND ur.revoked_at IS NULL
       )
     ORDER BY u.id
  LOOP
    PERFORM 1 FROM users WHERE tenant_id = NEW.tenant_id AND id = affected_user_id FOR UPDATE;
    UPDATE users SET version = version + 1 WHERE tenant_id = NEW.tenant_id AND id = affected_user_id;
  END LOOP;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION role_permissions_bump_permission_version() IS
  'ARCHITECTURE §8 / ADR-0009. Adding or revoking a role''s permission changes every current holder''s effective permissions; bumps users.version for each of them. Lock order: roles (FOR UPDATE) then users, one row at a time, ascending id — docs/LOCK_REGISTRY.md, DB-C2.';

CREATE TRIGGER role_permissions_bump_permission_version_ins
  AFTER INSERT ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION role_permissions_bump_permission_version();

CREATE TRIGGER role_permissions_bump_permission_version_rev
  AFTER UPDATE ON role_permissions
  FOR EACH ROW
  WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION role_permissions_bump_permission_version();

-- ---------------------------------------------------------------------------
-- DB-C1: a role's STATUS is part of its effective meaning too.
-- resolvePermissions filters role_permissions to roles with status = ACTIVE
-- (packages/permissions), so deactivating a role changes what every current
-- holder may do exactly as revoking one of its permissions does — and must
-- bump the same way. The role row is already locked by the UPDATE that fired
-- this trigger, so unlike the two functions above there is no separate
-- `roles` lock to take here.
-- ---------------------------------------------------------------------------

CREATE FUNCTION roles_bump_permission_version() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  affected_user_id uuid;
BEGIN
  FOR affected_user_id IN
    SELECT u.id
      FROM users u
     WHERE u.tenant_id = NEW.tenant_id
       AND EXISTS (
         SELECT 1
           FROM user_roles ur
          WHERE ur.tenant_id   = NEW.tenant_id
            AND ur.role_id     = NEW.id
            AND ur.user_id     = u.id
            AND ur.revoked_at IS NULL
       )
     ORDER BY u.id
  LOOP
    PERFORM 1 FROM users WHERE tenant_id = NEW.tenant_id AND id = affected_user_id FOR UPDATE;
    UPDATE users SET version = version + 1 WHERE tenant_id = NEW.tenant_id AND id = affected_user_id;
  END LOOP;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION roles_bump_permission_version() IS
  'ARCHITECTURE §8 / ADR-0009, DB-C1. Deactivating or reactivating a role changes every current holder''s effective permissions exactly as a role_permissions change does; bumps users.version for each of them. No roles lock to take here: the row is already locked by the UPDATE that fired this trigger.';

CREATE TRIGGER roles_bump_permission_version
  AFTER UPDATE ON roles
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION roles_bump_permission_version();

-- ---------------------------------------------------------------------------
-- Row level security — ADR-0004
-- ---------------------------------------------------------------------------
ALTER TABLE roles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles             FORCE  ROW LEVEL SECURITY;
ALTER TABLE role_permissions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions  FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_roles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles        FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON roles
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON role_permissions
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON user_roles
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON roles IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';
COMMENT ON POLICY tenant_isolation ON role_permissions IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';
COMMENT ON POLICY tenant_isolation ON user_roles IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- THE REVOKE IS NOT OPTIONAL (005's lesson). ALTER DEFAULT PRIVILEGES hands
-- every new table here table-level SELECT, INSERT, UPDATE to finsoft_app and
-- SELECT to readonly_support before this section runs. Table-level UPDATE
-- supersedes any column list added on top, and table-level INSERT lets a
-- caller name any column and override every DEFAULT — id, created_at,
-- status, version, is_system. The REVOKE is the control; the column list
-- that follows is what survives it.
--
-- DELETE is granted to nobody, by omission — the default privileges never
-- included it, and this file adds no GRANT DELETE anywhere (rule 4).
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON roles            FROM finsoft_app;
REVOKE INSERT, UPDATE ON role_permissions FROM finsoft_app;
REVOKE INSERT, UPDATE ON user_roles       FROM finsoft_app;

GRANT SELECT ON roles            TO finsoft_app;
GRANT SELECT ON role_permissions TO finsoft_app;
GRANT SELECT ON user_roles       TO finsoft_app;

-- What a caller may state when a role is created. Not id, status or version
-- — the database's to default. is_system defaults to false; seedSystemRoles
-- is the one caller that ever needs it true, so it is included here rather
-- than given its own escape hatch.
GRANT INSERT (tenant_id, code, name, is_system, created_by, updated_by)
  ON roles TO finsoft_app;

GRANT INSERT (tenant_id, role_id, permission_code, created_by, updated_by)
  ON role_permissions TO finsoft_app;

GRANT INSERT (tenant_id, user_id, role_id, created_by, updated_by)
  ON user_roles TO finsoft_app;

-- What a role's lifecycle legitimately writes after INSERT: rename, retire,
-- reactivate. Never its code or its is_system flag.
GRANT UPDATE (name, status, updated_at, updated_by, version)
  ON roles TO finsoft_app;

-- A grant is only ever revoked. role_id and permission_code are what it IS.
GRANT UPDATE (revoked_at, revoked_by, updated_at, updated_by, version)
  ON role_permissions TO finsoft_app;

GRANT UPDATE (revoked_at, revoked_by, updated_at, updated_by, version)
  ON user_roles TO finsoft_app;

GRANT SELECT ON roles            TO readonly_support;
GRANT SELECT ON role_permissions TO readonly_support;
GRANT SELECT ON user_roles       TO readonly_support;
