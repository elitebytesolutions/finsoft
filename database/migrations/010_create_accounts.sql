-- 010_create_accounts.sql
--
-- The per-tenant chart of accounts. docs/posting-rules/coa-standard.md
-- (COA/standard-v1), ADR-0005 ("per-tenant variation is configuration"),
-- NON_NEGOTIABLES rules 4, 7, 11, 17.
--
-- A posting rule names a ROLE (e.g. AR_CONTROL); the kernel resolves it to
-- exactly one active, postable account of the posting tenant. Each role is
-- held by at most one currently-active account per tenant
-- (accounts_tenant_active_role_key, below) — "none" resolved is a
-- configuration error the kernel raises (ACCOUNT_ROLE_UNMAPPED), not
-- something this schema can forbid declaratively.
--
-- `code` is text, not a fixed-width numeric column: standard-v1 uses 4-digit
-- codes, but Wave 10 loads Bhatti Traders' legacy tree verbatim
-- (`10-01-01 Cash in Hand`, coa-standard.md §1), at a deeper level than this
-- template's two.
--
-- ---------------------------------------------------------------------------
-- What is NOT enforced here, and why
--
-- coa-standard.md §5: "Once an account has a journal line, its type, kind and
-- control kind are immutable, and it can never be deleted" and "Deactivation
-- is rejected while the account's balance is non-zero, or while it holds a
-- role." Both require reading journal_lines, which does not exist until
-- migration 012 — the immutability-once-posted trigger is added there
-- (ALTER TABLE accounts ...), following the precedent of migration 007/008
-- extending migration 002's `users` table.
--
-- The MVP additionally "ships the chart read-only to users" (coa-standard.md
-- §5): create, rename and deactivate are Wave 2 remainder work. Grants below
-- give finsoft_app INSERT (for tenant-provisioning seeding) and SELECT only —
-- no UPDATE at all — so mutation is impossible at the privilege layer today,
-- which is a stronger and simpler control than a transition trigger for a
-- table nothing is yet allowed to write to twice. A future migration adds a
-- column-scoped UPDATE grant plus a transition-enforcement trigger when Wave
-- 2 builds rename/deactivate, exactly as 007 did for `users`.
--
-- ---------------------------------------------------------------------------
-- control_kind is NOT NULL, 'NONE' for a non-control account (ADR-0026)
--
-- ADR-0026 (Accepted 2026-09-28, journal-line party dimension) makes
-- (tenant_id, id, control_kind) the target of journal_lines' ONLY foreign
-- key to accounts, and copies control_kind onto every line as
-- journal_lines.account_control. A composite FK target column cannot be
-- NULL-for-"no control" and still be matched (MATCH SIMPLE would skip the
-- check for every non-control line), so the non-control case is the value
-- 'NONE', never NULL. accounts_tenant_id_control_kind_key below is that
-- target. Every CHECK in this file that previously read "control_kind IS
-- NULL" as "not a control account" reads "control_kind = 'NONE'" instead.
--
-- Changing control_kind once an account has been posted to is blocked by
-- the journal_lines FK itself (ON UPDATE RESTRICT, migration 012): an
-- UPDATE of a referenced key column with referencing rows raises 23503 for
-- EVERY role, including finsoft_migration and any admin script, because
-- referential-integrity checks are not subject to grants or RLS. That is
-- NOT redundant with the missing UPDATE grant below: the grant binds only
-- finsoft_app, and only until Wave 2 adds a column-scoped UPDATE for
-- rename/deactivate. The FK is the control that survives both.
--
-- Lock footprint: CREATE TABLE locks nothing that already exists except the
-- foreign key on tenant_id (SHARE ROW EXCLUSIVE on `tenants`, held for the
-- transaction). `tenants` has at most a handful of rows at this point.
--
-- How this is reversed: it is not, in place (ADR-0013, forward-only).
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,

  -- Text, not a fixed-width numeric type — see the file header. Not lower-
  -- cased or otherwise normalised: an account code is a business identifier
  -- printed on statements, not a case-insensitive login.
  code           text        NOT NULL CHECK (length(btrim(code)) > 0 AND length(code) <= 32),
  name           text        NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 200),

  type           text        NOT NULL
                             CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),

  -- Presentation only (coa-standard.md §2, "never blocks a posting"). An
  -- overdrawn bank or a credit residual posts and reports normally.
  normal_balance text        NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),

  -- HEADER accounts group the tree and never take a journal line (enforced by
  -- accounts_postable_has_parent below and, once journal_lines exists, by the
  -- line's own FK target). POSTABLE accounts are what a line may reference.
  kind           text        NOT NULL CHECK (kind IN ('HEADER', 'POSTABLE')),

  -- coa-standard.md §2: AR / AP / INVENTORY for a control account, 'NONE'
  -- otherwise — never NULL (ADR-0026; see the file header). Whether the
  -- control kind is a column here or a separate mapping table was the
  -- Database seat's call (coa-standard.md §4) — a column, because it is 1:1
  -- with an account and is now a foreign-key target.
  control_kind   text        NOT NULL DEFAULT 'NONE'
                             CHECK (control_kind IN ('NONE', 'AR', 'AP', 'INVENTORY')),

  -- The stable identifier a posting rule names (AR_CONTROL, CASH_DEFAULT,
  -- SERVICE_REVENUE, ...). Uppercase snake case, matching coa-standard.md's
  -- own spelling. NULL on a header and on any postable account that holds no
  -- role (6100 Salaries, 6900's peers besides ROUNDING, and so on).
  role           text        CHECK (role ~ '^[A-Z][A-Z0-9_]*$'),

  -- coa-standard.md §3: closed to manual JV independently of being a control
  -- account (Retained Earnings, COGS, Rounding Differences). A control
  -- account is already closed to manual JV by virtue of control_kind, so the
  -- two never both apply to one account (accounts_control_not_restricted).
  restricted     boolean     NOT NULL DEFAULT false,

  -- Every postable account's parent is the header of the same branch
  -- (coa-standard.md §2). Self-referential composite FK, ADR-0021's shape —
  -- accounts_tenant_id_id_key below is what makes it possible to reference
  -- (tenant_id, id) from within this same table.
  parent_id      uuid,

  -- Lifecycle, never deletion (rule 4).
  is_active      boolean     NOT NULL DEFAULT true,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  version        integer     NOT NULL DEFAULT 0 CHECK (version >= 0),

  CONSTRAINT accounts_role_only_on_postable
    CHECK (role IS NULL OR kind = 'POSTABLE'),
  CONSTRAINT accounts_control_only_on_postable
    CHECK (control_kind = 'NONE' OR kind = 'POSTABLE'),
  CONSTRAINT accounts_control_not_restricted
    CHECK (control_kind = 'NONE' OR NOT restricted),
  CONSTRAINT accounts_header_has_no_parent
    CHECK (kind <> 'HEADER' OR parent_id IS NULL),
  CONSTRAINT accounts_postable_has_parent
    CHECK (kind <> 'POSTABLE' OR parent_id IS NOT NULL),

  -- coa-standard.md §4: "AR_CONTROL is an ASSET with control AR" and so on.
  -- Checked here as a schema fact rather than left to the kernel alone —
  -- this is what ACCOUNT_ROLE_MISCONFIGURED is guarding against from Wave 10,
  -- when a tenant-specific chart supplies the mapping.
  CONSTRAINT accounts_control_kind_matches_type
    CHECK (
      control_kind = 'NONE'
      OR (control_kind = 'AR' AND type = 'ASSET')
      OR (control_kind = 'AP' AND type = 'LIABILITY')
      OR (control_kind = 'INVENTORY' AND type = 'ASSET')
    ),

  CONSTRAINT accounts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT accounts_tenant_code_key  UNIQUE (tenant_id, code),
  -- ADR-0026: the target of journal_lines' composite FK (tenant_id,
  -- account_id, account_control). Redundant as a uniqueness fact (id alone
  -- is unique) and required anyway: PostgreSQL only accepts a foreign key
  -- whose referenced column list carries a unique constraint of its own.
  CONSTRAINT accounts_tenant_id_control_kind_key UNIQUE (tenant_id, id, control_kind),

  CONSTRAINT accounts_parent_fkey
    FOREIGN KEY (tenant_id, parent_id) REFERENCES accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounts_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounts_updated_by_fkey
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

-- coa-standard.md §5: "UNIQUE (tenant_id, name) among postable accounts" —
-- partial, because two headers of different branches are not required to
-- have distinct names from postable accounts (they are a different kind).
CREATE UNIQUE INDEX accounts_tenant_postable_name_key
  ON accounts (tenant_id, lower(name)) WHERE kind = 'POSTABLE';

-- "Each role is held by exactly one active postable account" — the "two
-- accounts holding a role" half of that sentence. The "or none" half is a
-- configuration error the kernel raises; no declarative constraint can
-- require a row to exist.
CREATE UNIQUE INDEX accounts_tenant_active_role_key
  ON accounts (tenant_id, role) WHERE role IS NOT NULL AND is_active;

CREATE INDEX accounts_tenant_status_idx ON accounts (tenant_id, is_active);
CREATE INDEX accounts_tenant_parent_idx ON accounts (tenant_id, parent_id);

COMMENT ON TABLE accounts IS
  'COA/standard-v1 (docs/posting-rules/coa-standard.md). Per-tenant chart of accounts. Tenant-owned, RLS enabled and forced. Ships read-only in the MVP (no UPDATE grant); create/rename/deactivate are Wave 2 remainder work.';
COMMENT ON COLUMN accounts.role IS
  'The stable identifier a posting rule names (AR_CONTROL, CASH_DEFAULT, ...). Resolution is by role, never by code or name (rule 17).';
COMMENT ON COLUMN accounts.restricted IS
  'coa-standard.md §3: closed to manual JV for a reason other than being a control account (Retained Earnings, COGS, Rounding Differences).';

CREATE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON accounts
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMENT ON POLICY tenant_isolation ON accounts IS
  'ADR-0004. USING filters reads; WITH CHECK stops a row being written under another tenant_id. Both are always present.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- No UPDATE grant at all — see the file header. finsoft_app may INSERT the
-- seeded template (tenant provisioning, packages/database/src/provisioning.ts)
-- and SELECT (the kernel's role resolution, and every future read screen).
-- DELETE is granted to nobody (rule 4).
--
-- THE REVOKE COVERS INSERT TOO (008's lesson, which the first draft of this
-- file missed): ALTER DEFAULT PRIVILEGES hands every new table TABLE-level
-- SELECT, INSERT, UPDATE to finsoft_app, and table-level INSERT lets a caller
-- name any column — id, created_at, version — making the column list below
-- decorative. Revoke first; the column list is what survives.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON accounts FROM finsoft_app;

GRANT SELECT ON accounts TO finsoft_app;
GRANT INSERT (
  tenant_id, code, name, type, normal_balance, kind, control_kind, role,
  restricted, parent_id, is_active, created_by, updated_by
) ON accounts TO finsoft_app;

GRANT SELECT ON accounts TO readonly_support;
