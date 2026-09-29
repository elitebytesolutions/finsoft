import { withTenant, type AccountRow } from '@finsoft/database'
import { createTenantFixture, runAs, unique, type TenantFixture } from '@finsoft/database/testing'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import { seedSystemRoles } from '@finsoft/permissions'

/*
 * A tenant provisioned the way M2-B's tests need it: standard-v1 chart,
 * FY2027 periods, the three MVP system roles seeded and granted, plus an
 * ACTIVE owner (voucher.post/reverse, report.financial — everything) and an
 * ACTIVE viewer (voucher.view, report.financial only — no post/reverse) so
 * every endpoint's RBAC case has a real user to run as.
 *
 * Not `createActiveUserFixture` (tests/integration/helpers/auth-seed.ts):
 * this lane needs a seeded chart of accounts and fiscal year, and a second
 * (viewer) user, neither of which that helper provides.
 */
export interface AccountingTenantFixture extends TenantFixture {
  readonly viewerId: string
  /** ACTIVE, but assigned NO role at all — holds zero permissions. */
  readonly noRoleId: string
  readonly accountsByCode: ReadonlyMap<string, AccountRow>
}

export async function createAccountingTenant(label: string): Promise<AccountingTenantFixture> {
  const tenant = await createTenantFixture(label)

  const { viewerId, noRoleId, accounts } = await runAs(
    { tenantId: tenant.tenantId, userId: tenant.ownerId },
    () =>
      withTenant(async (tx) => {
        await seedChartOfAccounts(tx, tenant.tenantId)
        await createFiscalYear(tx, tenant.tenantId, 2027)
        await seedSystemRoles(tx, tenant.tenantId)

        await tx
          .updateTable('users')
          .set({ status: 'ACTIVE', password_hash: 'test-hash-not-real', version: 1 })
          .where('tenant_id', '=', tenant.tenantId)
          .where('id', '=', tenant.ownerId)
          .execute()

        const ownerRole = await tx
          .selectFrom('roles')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'owner')
          .executeTakeFirstOrThrow()

        await tx
          .insertInto('user_roles')
          .values({
            tenant_id: tenant.tenantId,
            user_id: tenant.ownerId,
            role_id: ownerRole.id,
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .execute()

        const viewerRole = await tx
          .selectFrom('roles')
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .where('code', '=', 'viewer')
          .executeTakeFirstOrThrow()

        const viewer = await tx
          .insertInto('users')
          .values({
            tenant_id: tenant.tenantId,
            email: `viewer.${unique()}@example.test`,
            full_name: 'Viewer User',
            status: 'ACTIVE',
            password_hash: 'test-hash-not-real',
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()

        await tx
          .insertInto('user_roles')
          .values({
            tenant_id: tenant.tenantId,
            user_id: viewer.id,
            role_id: viewerRole.id,
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .execute()

        // No role assigned at all — the negative RBAC case: an ACTIVE user
        // who nonetheless holds zero permissions.
        const noRole = await tx
          .insertInto('users')
          .values({
            tenant_id: tenant.tenantId,
            email: `norole.${unique()}@example.test`,
            full_name: 'No-Role User',
            status: 'ACTIVE',
            password_hash: 'test-hash-not-real',
            created_by: tenant.ownerId,
            updated_by: tenant.ownerId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()

        const allAccounts = await tx
          .selectFrom('accounts')
          .selectAll()
          .where('tenant_id', '=', tenant.tenantId)
          .execute()

        const accountsByCode = new Map<string, AccountRow>(
          allAccounts.map((row) => [
            row.code,
            {
              id: row.id,
              tenantId: row.tenant_id,
              code: row.code,
              name: row.name,
              type: row.type,
              normalBalance: row.normal_balance,
              kind: row.kind,
              controlKind: row.control_kind as AccountRow['controlKind'],
              role: row.role,
              restricted: row.restricted,
              isActive: row.is_active,
            },
          ]),
        )

        return { viewerId: viewer.id, noRoleId: noRole.id, accounts: accountsByCode }
      }),
  )

  return { ...tenant, viewerId, noRoleId, accountsByCode: accounts }
}
