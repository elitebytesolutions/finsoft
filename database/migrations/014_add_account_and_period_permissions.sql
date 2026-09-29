-- 014_add_account_and_period_permissions.sql
--
-- Council ruling on M2-B (Accounting + Security + Architecture seats,
-- 2026-09-29, docs/design/M2/api-contract.md §6/§9): adds four permission
-- codes to the catalogue (packages/permissions/src/catalog.ts) —
-- account.view, period.view, period.close, period.reopen — and backfills
-- the matching role_permissions grants into every EXISTING tenant's system
-- roles, so a tenant provisioned before this migration ends up with exactly
-- the grants packages/permissions/src/system-roles.ts's SYSTEM_ROLE_SEEDS
-- says a freshly-provisioned tenant should have. There is deliberately no
-- 'period.lock' code and no backfill for one — M2 builds view/close/reopen
-- only.
--
-- ---------------------------------------------------------------------------
-- This is master data, not a posting or a financial mutation
-- ---------------------------------------------------------------------------
--
-- role_permissions is ordinary tenant-owned master data (migration 008), not
-- one of the kernel-owned registers ADR-0013:31 fences off — this migration
-- writes it directly, the same way 008 itself does, and the same way
-- seedSystemRoles()/insertSeededRoles() do at ordinary tenant provisioning.
--
-- NO audit_log row is written here. audit_log's hash chain (ADR-0020) is
-- built by the application layer from a real actor, request id and previous-
-- hash read under RLS; a migration running as finsoft_migration (BYPASSRLS,
-- no acting user, no request) cannot supply any of that without inventing a
-- synthetic actor, which would misrepresent who made the change. The grants
-- below are themselves the auditable record: any operator can read
-- role_permissions.created_at/created_by and see exactly when and, by
-- authorship, in whose provisioning lineage each grant was added.
--
-- ---------------------------------------------------------------------------
-- Grants (docs/design/M2/api-contract.md §6, Council ruling table)
-- ---------------------------------------------------------------------------
--
--   account.view    owner, accountant, viewer
--   period.view     owner, accountant, viewer
--   period.close    owner, accountant
--   period.reopen   owner                        (reopen stays the narrower,
--                                                  more privileged path —
--                                                  periods.md §8, ADR-0012)
--
-- ---------------------------------------------------------------------------
-- Tenant isolation without RLS
-- ---------------------------------------------------------------------------
--
-- finsoft_migration holds BYPASSRLS (migration 001's header) so that a
-- single statement can reach every tenant's rows in one pass. With row
-- security bypassed, the JOIN below — matching each new grant to roles of
-- the SAME tenant_id the role itself belongs to — is the ONLY thing
-- preventing tenant A's grant from being inserted against tenant B's role.
-- There is no second predicate anywhere in this statement filtering by
-- tenant; the correctness of tenant isolation here rests entirely on
-- `role_permissions.tenant_id` being copied from `r.tenant_id`, the SAME row
-- the join matched, never a separately-computed value.
--
-- created_by / updated_by is the owning role's OWN created_by — the
-- provisioned owner who originally caused that tenant's system roles to be
-- seeded — never a migration-role synthetic actor, matching the authorship
-- discipline insertSeededRoles() already uses for the SAME tables.
--
-- Idempotent by construction: role_permissions_active_unique (migration 008,
-- a partial unique index on (tenant_id, role_id, permission_code) WHERE
-- revoked_at IS NULL) is this statement's ON CONFLICT target, so a grant
-- already active is skipped, never duplicated. Re-running this migration
-- file (impossible through the normal migrator, which tracks applied
-- versions, but true of the statement itself) would be a no-op the second
-- time.
-- ---------------------------------------------------------------------------

INSERT INTO role_permissions (tenant_id, role_id, permission_code, created_by, updated_by)
SELECT r.tenant_id, r.id, g.permission_code, r.created_by, r.created_by
FROM roles r
JOIN (
  VALUES
    ('owner',      'account.view'),
    ('owner',      'period.view'),
    ('owner',      'period.close'),
    ('owner',      'period.reopen'),
    ('accountant', 'account.view'),
    ('accountant', 'period.view'),
    ('accountant', 'period.close'),
    ('viewer',     'account.view'),
    ('viewer',     'period.view')
) AS g (role_code, permission_code) ON g.role_code = r.code
WHERE r.is_system
ON CONFLICT (tenant_id, role_id, permission_code) WHERE revoked_at IS NULL DO NOTHING;
