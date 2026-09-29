import { withTenant } from '@finsoft/database'
import { createTenantFixture, runAs, unique, type TenantFixture } from '@finsoft/database/testing'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import { seedSystemRoles } from '@finsoft/permissions'
import { hashPassword } from '@finsoft/auth'

/*
 * An e2e-ready tenant: standard-v1 chart, FY2027 periods, the three MVP system roles, and
 * REAL argon2id-hashed passwords for an Owner, an Accountant and a Viewer — so a Playwright
 * spec can type them into the actual login form. Modelled on
 * tests/integration/helpers/accounting-fixture.ts (which this lane cannot import: that
 * fixture's users carry `password_hash: 'test-hash-not-real'`, fine for in-process supertest
 * calls, useless for a browser typing a real password) combined with
 * tests/integration/helpers/auth-seed.ts's `createActiveUserFixture` pattern for the real
 * hash, and tools/seed/demo-tenants.mjs's shape for the three roles.
 */
export interface AccountingE2eFixture extends TenantFixture {
  readonly ownerEmail: string
  readonly accountantEmail: string
  readonly viewerEmail: string
  readonly password: string
}

export async function createAccountingE2eTenant(
  label: string,
  password = 'Correct-Horse-Battery-Staple-1',
): Promise<AccountingE2eFixture> {
  const tenant = await createTenantFixture(label)
  const passwordHash = await hashPassword(password)

  const { ownerEmail, accountantEmail, viewerEmail } = await runAs(
    { tenantId: tenant.tenantId, userId: tenant.ownerId },
    () =>
      withTenant(async (tx) => {
        await seedChartOfAccounts(tx, tenant.tenantId)
        await createFiscalYear(tx, tenant.tenantId, 2027)
        await seedSystemRoles(tx, tenant.tenantId)

        const ownerRow = await tx
          .updateTable('users')
          .set({ status: 'ACTIVE', password_hash: passwordHash, version: 1 })
          .where('tenant_id', '=', tenant.tenantId)
          .where('id', '=', tenant.ownerId)
          .returning('email')
          .executeTakeFirstOrThrow()

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

        const makeMember = async (roleCode: 'accountant' | 'viewer', localPart: string) => {
          const role = await tx
            .selectFrom('roles')
            .select('id')
            .where('tenant_id', '=', tenant.tenantId)
            .where('code', '=', roleCode)
            .executeTakeFirstOrThrow()
          const email = `${localPart}.${unique()}@example.test`
          const user = await tx
            .insertInto('users')
            .values({
              tenant_id: tenant.tenantId,
              email,
              full_name: `${roleCode[0]!.toUpperCase()}${roleCode.slice(1)} User`,
              status: 'ACTIVE',
              password_hash: passwordHash,
              created_by: tenant.ownerId,
              updated_by: tenant.ownerId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          await tx
            .insertInto('user_roles')
            .values({
              tenant_id: tenant.tenantId,
              user_id: user.id,
              role_id: role.id,
              created_by: tenant.ownerId,
              updated_by: tenant.ownerId,
            })
            .execute()
          return email
        }

        const accountantEmail = await makeMember('accountant', 'accountant')
        const viewerEmail = await makeMember('viewer', 'viewer')

        return { ownerEmail: ownerRow.email, accountantEmail, viewerEmail }
      }),
  )

  return { ...tenant, ownerEmail, accountantEmail, viewerEmail, password }
}
