-- 007_users_column_scoped_regrant.sql
--
-- TD-005 (docs/WAVE_1_REGISTER.md, W1-002) and ADR-0023 §1's tenants
-- narrowing. Migration 002 granted table-level UPDATE on `users` with no
-- REVOKE and no column scoping, so `users.tenant_id` and `users.created_by`
-- have been application-writable since Wave 0. Login is the first code path
-- to write to `users` at all (`last_login_at`), which is what makes this
-- live rather than theoretical, and TD-005 says the forward migration
-- belongs to whichever task makes that first write.
--
-- Given its own numbered migration rather than riding with 006, for the
-- reasons docs/WAVE_1_REGISTER.md gives: a different signatory (a privilege
-- change on the password table is the Security Guardian's, not the Database
-- Guardian's alone); a different lock footprint (GRANT/REVOKE takes no lock
-- on the target relation at all, unlike 006's CREATE POLICY, which takes
-- AccessExclusiveLock on refresh_tokens); and this is not finished by a
-- regrant alone — migration 005's own lesson is that "a column grant is only
-- half a control... only a trigger says which DIRECTION they may change in",
-- and users has no transition trigger before this file.
--
-- ADR-0023 §1 also narrows `tenants`: the login narrowing made `tenants.code`
-- and `tenants.status` login inputs, and `finsoft_app` held table-level
-- UPDATE on both with no predicate requirement anywhere below the
-- application layer. A single missing WHERE on any future tenant-admin
-- handler would rewrite another tenant's code or suspend another tenant's
-- users, and nothing catches it — RLS does not apply to `tenants` (it is
-- global, ADR-0004:77), so this grant is the only backstop there is.
--
-- `/auth/login` must not ship before this migration, per ADR-0023's closing
-- line: "An earlier version named only 006, which permitted login to ship
-- reading tenants.code and tenants.status while finsoft_app still held
-- table-level UPDATE on both."
--
-- Lock footprint: GRANT/REVOKE take no lock on the target relation.
-- `CREATE TRIGGER` on `users` takes SHARE ROW EXCLUSIVE, blocking writes to
-- `users` for the transaction's duration; `users` is near-empty in Wave 1.
--
-- How this is reversed: it is not, in place (ADR-0013). A later migration
-- widening a grant back is possible; narrowing again is one line, widening
-- after the fact is an audit — which is exactly the asymmetry ADR-0023 §1
-- argues for.

-- ---------------------------------------------------------------------------
-- users: revoke the table-level grant, restate as a column list
--
-- Table-level UPDATE (from FND-005's ALTER DEFAULT PRIVILEGES, restated
-- explicitly by 002) supersedes any column list added on top of it — adding
-- one without the REVOKE first would restrict nothing, exactly as migration
-- 005's header warns for readonly_support. The REVOKE is the control.
--
-- Excluded, and each is deliberate:
--   id             surrogate identity, never application-writable
--   tenant_id      TD-005's finding. Ownership must never move after creation.
--   created_at     rule 13: the server clock at creation, never rewritten
--   created_by     authorship of creation is immutable
--   email          "not rewritable except by the defined path" — no
--                  email-change endpoint exists yet in Wave 1, so no grant
--                  exists for it either. A future migration adds both
--                  together, reviewed together.
--
-- Included, because Wave 1 needs them to function:
--   full_name      profile edits
--   password_hash  password set on invite acceptance, reset, rehash-on-login
--   status         INVITED -> ACTIVE -> SUSPENDED/DISABLED lifecycle
--   last_login_at  written by login
--   updated_at     kept honest by set_updated_at() regardless, restated here
--                  for completeness with the trigger below
--   updated_by     authorship of the update
--   version        optimistic lock, incremented by the application
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON users FROM finsoft_app;

GRANT UPDATE (
  full_name,
  password_hash,
  status,
  last_login_at,
  updated_at,
  updated_by,
  version
) ON users TO finsoft_app;

-- ---------------------------------------------------------------------------
-- users: transition enforcement
--
-- THE OTHER HALF. A column grant bounds WHICH columns finsoft_app may write;
-- only a trigger bounds which DIRECTION they may move in. Without it, the
-- grant above still permits `UPDATE users SET status = 'ACTIVE' WHERE
-- status = 'DISABLED'` — reactivating a deactivated account — and
-- `SET version = 0`, rewinding the optimistic lock exactly as migration 005's
-- header describes for a table that had none.
-- ---------------------------------------------------------------------------
CREATE FUNCTION users_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Identity and authorship-of-creation never move. finsoft_app holds no
  -- UPDATE grant on any of these after this migration; this is defence in
  -- depth against a future grant widened without review, in the same style
  -- as sessions_enforce_transition.
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'users: identity and creation-authorship columns are immutable (user %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- "Email not rewritable except by the defined path" (TD-005). No such path
  -- exists in Wave 1 — no email-change endpoint, no grant on the column —
  -- so the rule today is simply: never. This is the trigger half of a
  -- control whose grant half is the REVOKE above; a future migration that
  -- adds the endpoint adds the grant and widens this check together.
  IF NEW.email <> OLD.email THEN
    RAISE EXCEPTION 'users: email is not rewritable in Wave 1; no email-change path exists yet (user %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Status moves along one directed graph. DISABLED is terminal: a
  -- deactivated user is reinstated by provisioning a new row's worth of
  -- process, not by an UPDATE, and this table's own CHECK
  -- (users_active_requires_password) already assumes status is the honest
  -- record of lifecycle, not something an UPDATE can wind backward.
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'INVITED'   AND NEW.status IN ('ACTIVE', 'DISABLED')) OR
      (OLD.status = 'ACTIVE'    AND NEW.status IN ('SUSPENDED', 'DISABLED')) OR
      (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE', 'DISABLED'))
    ) THEN
      RAISE EXCEPTION 'users: % -> % is not a permitted status transition (user %)',
        OLD.status, NEW.status, OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- last_login_at is written by login and moves forward only — the same
  -- reasoning as sessions.last_seen_at: a login timestamp that could be
  -- rewound is a login timestamp nobody can trust for a lockout or an
  -- incident timeline.
  IF OLD.last_login_at IS NOT NULL
     AND NEW.last_login_at IS NOT NULL
     AND NEW.last_login_at < OLD.last_login_at THEN
    RAISE EXCEPTION 'users: last_login_at may not move backward (user %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- An optimistic lock that can be wound back is not a lock.
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'users: version must increase on every update (user %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER users_enforce_transition
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_enforce_transition();

COMMENT ON TRIGGER users_enforce_transition ON users IS
  'TD-005. The direction half of the control the column-scoped GRANT above starts: status follows '
  'one directed graph with DISABLED terminal, version and last_login_at move forward only, and '
  'identity/email/creation-authorship never move at all.';

-- ---------------------------------------------------------------------------
-- tenants: narrow the grant ADR-0023 §1 requires
--
-- `tenants.code` and `tenants.status` are now login inputs (the tenant-code
-- field ADR-0023 §1 adds). `tenants` is global — no tenant_id, no RLS — so
-- this column grant is the ONLY backstop against a missing WHERE on some
-- future tenant-admin handler silently renaming or suspending another
-- tenant, denying that tenant's users the ability to authenticate at all.
--
-- Excluded: id, code, status, base_currency (CHECK-pinned to PKR; no
-- legitimate write path exists), created_at.
-- Included: the metadata a tenant profile screen legitimately edits.
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON tenants FROM finsoft_app;

GRANT UPDATE (
  name,
  legal_name,
  ntn,
  strn,
  timezone,
  updated_at
) ON tenants TO finsoft_app;

COMMENT ON COLUMN tenants.code IS
  'Business identifier and a login input (ADR-0023 §1). finsoft_app holds no UPDATE grant on '
  'this column as of migration 007 — renaming a tenant is a separately permissioned, separately '
  'audited action, not a side effect of a profile edit.';
COMMENT ON COLUMN tenants.status IS
  'ACTIVE | SUSPENDED | CLOSED, and a login input (ADR-0023 §1). finsoft_app holds no UPDATE '
  'grant on this column as of migration 007 — see the comment on tenants.code.';
