-- 019_add_account_manage_permission.sql
--
-- Owner: packages/permissions
--
-- ADR-0028 §9's header convention, extended to this migration's actual
-- owner exactly as migration 014's own header explains: role_permissions is
-- platform/RBAC master data (migration 008), and packages/permissions is
-- ARCHITECTURE §8's single source of truth for the permission catalogue.
--
-- Security seat ruling on M2-C (coa-standard.md §8.5, this lane's delivery
-- brief, APPROVED WITH CONDITIONS): adds ONE permission code to the
-- catalogue (packages/permissions/src/catalog.ts) — account.manage — and
-- backfills the matching role_permissions grants into every EXISTING
-- tenant's system roles, so a tenant provisioned before this migration ends
-- up with exactly the grants packages/permissions/src/system-roles.ts's
-- SYSTEM_ROLE_SEEDS says a freshly-provisioned tenant should have.
--
-- account.manage is held by Owner and Accountant, not Viewer
-- (coa-standard.md §8.5). It is NOT privileged (no MFA step-up) —
-- packages/permissions/src/catalog.ts's PRIVILEGED_PERMISSIONS set is
-- unchanged by this migration.
--
-- ---------------------------------------------------------------------------
-- This is master data, not a posting or a financial mutation — identical
-- reasoning to migration 014's own header, not repeated in full here.
-- role_permissions is ordinary tenant-owned master data (migration 008), the
-- grants below write it directly (as 008 itself, and insertSeededRoles, do),
-- and NO audit_log row is written from SQL for the same reason 014 gives
-- (the hash chain needs a real actor, request id and previous-hash read
-- under RLS, none of which a BYPASSRLS migration role running with no
-- request can supply without inventing a synthetic actor).
--
-- Tenant isolation without RLS: identical to 014 — finsoft_migration holds
-- BYPASSRLS, so the JOIN below matching each new grant to roles of the SAME
-- tenant_id the role itself belongs to is the ONLY thing preventing tenant
-- A's grant from landing on tenant B's role. role_permissions.tenant_id is
-- copied from r.tenant_id, the same row the join matched, never a
-- separately-computed value.
--
-- created_by/updated_by: the owning role's own created_by, matching 014 and
-- insertSeededRoles()'s authorship discipline for these same tables.
--
-- Idempotent by construction: role_permissions_active_unique (migration
-- 008) is this statement's ON CONFLICT target, so a grant already active is
-- skipped, never duplicated.
-- ---------------------------------------------------------------------------

INSERT INTO role_permissions (tenant_id, role_id, permission_code, created_by, updated_by)
SELECT r.tenant_id, r.id, g.permission_code, r.created_by, r.created_by
FROM roles r
JOIN (
  VALUES
    ('owner',      'account.manage'),
    ('accountant', 'account.manage')
) AS g (role_code, permission_code) ON g.role_code = r.code
WHERE r.is_system
ON CONFLICT (tenant_id, role_id, permission_code) WHERE revoked_at IS NULL DO NOTHING;
