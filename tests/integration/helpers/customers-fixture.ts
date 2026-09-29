import { withTenant } from '@finsoft/database'
import { createTenantFixture, runAs, unique, type TenantFixture } from '@finsoft/database/testing'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import { seedSystemRoles } from '@finsoft/permissions'

/*
 * A tenant provisioned the way the customers integration suite needs it:
 * standard-v1 chart of accounts (so AR_CONTROL resolves for K5), FY2027,
 * the three MVP system roles, an ACTIVE owner (customer.view + .create),
 * an ACTIVE viewer (customer.view only — VIEWER_PERMISSIONS,
 * packages/permissions/src/system-roles.ts), and an ACTIVE user with no
 * role at all (holds zero permissions). Mirrors
 * tests/integration/helpers/accounting-fixture.ts's own shape.
 */
export interface CustomersTenantFixture extends TenantFixture {
  readonly viewerId: string
  readonly noRoleId: string
}

export async function createCustomersTenant(label: string): Promise<CustomersTenantFixture> {
  const tenant = await createTenantFixture(label)

  const { viewerId, noRoleId } = await runAs(
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

        return { viewerId: viewer.id, noRoleId: noRole.id }
      }),
  )

  return { ...tenant, viewerId, noRoleId }
}
