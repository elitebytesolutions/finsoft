-- 018_accounts_create_and_edit.sql
--
-- Owner: packages/accounting-kernel
--
-- Chart-of-accounts create and edit in the MVP (M2-C). docs/posting-rules/
-- coa-standard.md §5 (amended 2026-09-29) and §8, specifically §8.7's
-- database requirements R1, R3-R11. NON_NEGOTIABLES rules 2, 4, 7, 9, 17.
-- Council: Accounting seat (coa-standard.md §8, dated); Security seat
-- (APPROVED WITH CONDITIONS, tightening R1-R13, this lane's delivery brief);
-- Architecture seat (kernel export shape, C10 ownership).
--
-- ===========================================================================
-- R2 IS NOT IN THIS MIGRATION — REPORTED, NOT WORKED AROUND
-- ===========================================================================
--
-- R2 asks for the user-create INSERT path to be structurally unable to write
-- a header, a control account, a role or a restricted account, via a
-- narrowly-scoped definer-owned (Postgres' privilege-elevating function
-- mechanism) seeding function replacing finsoft_app's current column-scoped
-- INSERT grant on kind/control_kind/role/restricted (used today only by
-- tenant-provisioning seeding, seedChartOfAccounts).
--
-- The Security seat's own tightening of R2 requires that function's OWNER
-- to be a NOLOGIN, NOBYPASSRLS role that "owns nothing else" (S4 exception
-- (c), this lane's delivery brief). The one such role that already exists,
-- `finsoft_refresh` (migration 006, ADR-0023 §2), already owns
-- `auth_lookup.resolve_refresh` — reusing it here would make it own two
-- functions, failing "owns nothing else" for both. A fresh, dedicated role
-- cannot be created by this migration: `finsoft_migration` has no
-- CREATEROLE (measured, migration 006's own header), so a new role can only
-- be provisioned in `infrastructure/docker/postgres/init/00-bootstrap.sh` —
-- a file OUTSIDE this lane's ALLOWED paths.
--
-- The "provisioning transaction" flag alternative the Accounting seat's
-- spec also named is explicitly REJECTED by the Security seat (this lane's
-- delivery brief) — there is no third mechanism this lane may use instead.
--
-- Per AGENTS.md ("if the correct fix is outside ALLOWED, stop and report —
-- do not leave a compensating workaround inside your boundary"), this
-- migration does NOT narrow finsoft_app's existing INSERT grant on
-- kind/control_kind/role/restricted (doing so without the replacement
-- definer function would break tenant provisioning, which is worse). The
-- APPLICATION-layer half of R2 IS implemented: `chartOfAccounts.create`
-- (packages/accounting-kernel/src/chart-of-accounts.ts) hardcodes
-- kind='POSTABLE', control_kind='NONE', role=NULL, restricted=false —
-- there is no field through which a request can ask for anything else. The
-- DATABASE-privilege backstop stays open until a follow-up migration lands
-- the definer function against a role provisioned in 00-bootstrap.sh. See
-- this lane's report (BLOCKED) and docs/TECH_DEBT.md.
--
-- ===========================================================================
-- R1 — column-scoped UPDATE grant
-- ===========================================================================
-- Migration 010 granted finsoft_app no UPDATE at all. name/code/parent_id
-- are the only user-editable fields (coa-standard.md §8.2); updated_by and
-- version are the bookkeeping columns every edit also sets. type, kind,
-- control_kind, role, restricted, normal_balance, is_active, tenant_id, id
-- and created_* stay ungranted — R3/R4's triggers are the backstop for
-- every OTHER role (finsoft_migration, an admin script), but for
-- finsoft_app this grant alone already makes those columns unwritable.
GRANT UPDATE (name, code, parent_id, updated_by, version) ON accounts TO finsoft_app;

-- ===========================================================================
-- R5 — parent integrity: a postable account's parent is a HEADER of the
-- SAME TENANT (already an FK fact, accounts_parent_fkey) and the SAME TYPE.
-- Binds every role, including finsoft_migration and the (not yet built) R2
-- seeding path — this is a structural fact about the tree, not a
-- user-request validation.
-- ===========================================================================
CREATE FUNCTION accounts_enforce_parent_integrity() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  parent_kind text;
  parent_type text;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT kind, type INTO parent_kind, parent_type
    FROM accounts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounts: parent % does not belong to tenant % (ACCOUNT_PARENT_NOT_FOUND)', NEW.parent_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF parent_kind <> 'HEADER' THEN
    RAISE EXCEPTION 'accounts: parent % is not a HEADER account (coa-standard.md §8.7 R5, ACCOUNT_PARENT_NOT_HEADER)', NEW.parent_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF parent_type <> NEW.type THEN
    RAISE EXCEPTION 'accounts: parent % has type %, account % has type % (coa-standard.md §8.7 R5, ACCOUNT_PARENT_TYPE_MISMATCH)', NEW.parent_id, parent_type, NEW.id, NEW.type
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION accounts_enforce_parent_integrity() IS
  'coa-standard.md §8.7 R5: a postable account''s parent is a HEADER of the same tenant and the same type — for every role, on INSERT and on an UPDATE of parent_id or type.';

CREATE TRIGGER accounts_enforce_parent_integrity
  BEFORE INSERT OR UPDATE OF parent_id, type ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_enforce_parent_integrity();

-- ===========================================================================
-- R3 + R4 + R8 — extending migration 012's accounts_enforce_posted_immutability
--
-- R3: a protected row (HEADER, role-holding, control kind other than NONE,
--     or restricted) rejects ANY change, for every role.
-- R4: code and parent_id join type/kind/control_kind on the "immutable
--     once the account has a journal line" list.
-- R8: the has-a-journal-line check for code/parent_id takes an explicit
--     `FOR UPDATE` on the account's own row before its fresh read of
--     journal_lines — LOCK_REGISTRY, new row-lock entry below. It locks
--     ONE row (the row already being updated by this very statement), so
--     it cannot deadlock: there is no second row anywhere in this
--     transaction's lock order for it to be waited on by.
-- ===========================================================================
CREATE OR REPLACE FUNCTION accounts_enforce_posted_immutability() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  is_protected boolean;
  has_lines    boolean;
BEGIN
  -- R3. Checked against every column a change could plausibly touch, not
  -- only the ones any grant currently permits — this is the backstop for
  -- every role, not only finsoft_app (whose R1 grant already excludes
  -- type/kind/control_kind/role/restricted/normal_balance/is_active).
  is_protected := (OLD.kind = 'HEADER' OR OLD.role IS NOT NULL OR OLD.control_kind <> 'NONE' OR OLD.restricted);
  IF is_protected AND (
       NEW.name <> OLD.name OR NEW.code <> OLD.code OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
       OR NEW.type <> OLD.type OR NEW.normal_balance <> OLD.normal_balance OR NEW.kind <> OLD.kind
       OR NEW.control_kind <> OLD.control_kind OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW.restricted <> OLD.restricted OR NEW.is_active <> OLD.is_active
     )
  THEN
    RAISE EXCEPTION 'accounts: % is a protected account (header, role-holding, control, or restricted) and cannot be edited (coa-standard.md §8.2, ACCOUNT_PROTECTED)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- R4/R8. type/kind/control_kind (012's original scope) plus code/parent_id
  -- (R4's widening). code and parent_id are checked identically to avoid a
  -- gap R8 exists to close — see this migration's own header.
  IF (NEW.type <> OLD.type OR NEW.kind <> OLD.kind OR NEW.control_kind <> OLD.control_kind
      OR NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id
      OR NEW.code <> OLD.code OR NEW.parent_id IS DISTINCT FROM OLD.parent_id)
  THEN
    -- R8: the account row FOR UPDATE — one row, the row this very UPDATE
    -- statement already targets. A concurrent first journal_lines INSERT
    -- for this account takes an implicit FOR KEY SHARE on this same row
    -- (journal_lines_account_fkey), which conflicts with FOR UPDATE, so it
    -- either already committed (and the fresh read below sees it) or it
    -- now waits behind this transaction.
    PERFORM 1 FROM accounts WHERE tenant_id = OLD.tenant_id AND id = OLD.id FOR UPDATE;

    SELECT EXISTS(
      SELECT 1 FROM journal_lines WHERE tenant_id = OLD.tenant_id AND account_id = OLD.id
    ) INTO has_lines;

    IF has_lines THEN
      RAISE EXCEPTION 'accounts: % has a journal line — type, kind, control_kind, code and parent_id are immutable (coa-standard.md §5/§8.2, ACCOUNT_HAS_POSTINGS)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION accounts_enforce_posted_immutability() IS
  'coa-standard.md §8.2, §8.7 R3/R4/R8. A protected account rejects any change, every role. code/parent_id join type/kind/control_kind as immutable once the account has a journal line, checked under an explicit FOR UPDATE on the account''s own row (LOCK_REGISTRY).';

-- The trigger itself already exists (migration 012) and needs no re-creation
-- — CREATE OR REPLACE FUNCTION above is enough to widen its body.

-- ===========================================================================
-- R7 — at most one AR-control account per tenant, at most one AP-control.
-- Existing tenants comply by construction: migration 010's seeding writes
-- exactly one AR-control (1200) and one AP-control (2100) account per
-- tenant, from a fixed template, so this index cannot fail against data
-- already in place.
-- ===========================================================================
CREATE UNIQUE INDEX accounts_tenant_ar_ap_control_key
  ON accounts (tenant_id, control_kind) WHERE control_kind IN ('AR', 'AP');

COMMENT ON INDEX accounts_tenant_ar_ap_control_key IS
  'coa-standard.md §8.7 R7 / TD-011: at most one AR-control and at most one AP-control account per tenant — Invariant 9 depends on this structurally, not just on the absence of a create-control-account UI.';

-- ===========================================================================
-- R10 — the table comment no longer says the chart ships read-only.
-- ===========================================================================
COMMENT ON TABLE accounts IS
  'COA/standard-v1 (docs/posting-rules/coa-standard.md). Per-tenant chart of accounts. Tenant-owned, RLS enabled and forced. From M2-C (migration 018): a user holding account.manage may create a postable account under an existing header and edit its name/code/parent within coa-standard.md §8.2''s limits, through packages/accounting-kernel''s chartOfAccounts.create/update only. Headers, control accounts, role-holding accounts and restricted accounts stay read-only to users. There is no delete and no deactivate in the MVP (§8.4, deferred to Wave 2 remainder).';
