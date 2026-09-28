import { Client } from 'pg'
import { withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * DB-C2: the lock order migration 008's permission_version cascades take,
 * exercised with TWO REAL, INDEPENDENT PostgreSQL connections.
 *
 * WHY THIS FILE, NOT tests/integration, AND NOT THE SHARED HARNESS POOL
 *
 * The shared harness pins DATABASE_POOL_MAX=1 (packages/database/src/testing/
 * harness.ts) so that every "concurrent" call in this suite is provably
 * forced through the SAME physical backend — which is exactly what makes
 * tests/security/tenant-isolation-concurrent.spec.ts meaningful, and exactly
 * what makes it USELESS here: a genuine row-lock wait needs two DIFFERENT
 * backends, because a second `withTenant` call cannot even hand its
 * statement to PostgreSQL until the pool's one connection is checked back
 * in. Two raw `pg.Client` connections, each doing its own `BEGIN` and its own
 * `set_config('app.tenant_id', ...)`, are what genuinely exercise
 * PostgreSQL's lock manager instead of the pool's queue.
 *
 * `set_config('app.tenant_id', ...)` outside packages/database is normally an
 * ESLint violation (ADR-0004's Compliance section) — this directory is
 * exempted for exactly this reason, alongside database/tests, which reads
 * app.tenant_id from the catalog for the same purpose (eslint.config.mjs).
 *
 * THE RACE NAMED BY THE DATABASE GUARDIAN: a concurrent
 *   - role_permissions revoke (role_permissions_bump_permission_version)
 *   - user_roles grant/revoke (user_roles_bump_permission_version)
 * on the SAME role, before either cascade took a lock on `roles` first,
 * could each proceed to lock `users` rows in whatever order PostgreSQL's
 * planner chose — unordered relative to each other. The fix makes them
 * queue on the ROLE itself before either touches a user row at all: the
 * role_permissions path takes FOR UPDATE (it is the write), the user_roles
 * path takes FOR SHARE (it only reads which role changed). This test proves
 * the SERIALISATION that produces: the second cascade genuinely blocks on
 * PostgreSQL's lock manager — not the pool — until the first commits, and
 * then completes cleanly. No 40P01 is possible in this shape any more,
 * because only one of the two can ever be waiting at a time.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function rawClient(): Promise<Client> {
  const url = process.env['TEST_DATABASE_URL']
  if (!url) throw new Error('TEST_DATABASE_URL is required')
  const client = new Client({ connectionString: url })
  await client.connect()
  return client
}

interface Fixture {
  tenant: TenantFixture
  roleId: string
  grantId: string
  assignmentId: string
}

async function seedFixture(): Promise<Fixture> {
  const tenant = await createTenantFixture('LOCK')

  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant(async (tx) => {
      const role = await tx
        .insertInto('roles')
        .values({
          tenant_id: tenant.tenantId,
          code: 'lockorder',
          name: 'Lock Order Fixture',
          created_by: tenant.ownerId,
          updated_by: tenant.ownerId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      const grant = await tx
        .insertInto('role_permissions')
        .values({
          tenant_id: tenant.tenantId,
          role_id: role.id,
          permission_code: 'customer.view',
          created_by: tenant.ownerId,
          updated_by: tenant.ownerId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      const user = await tx
        .insertInto('users')
        .values({
          tenant_id: tenant.tenantId,
          email: `lockorder.${tenant.code.toLowerCase()}@example.test`,
          full_name: 'Lock Order Subject',
          status: 'ACTIVE',
          password_hash: 'test-hash-not-real',
          created_by: tenant.ownerId,
          updated_by: tenant.ownerId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      const assignment = await tx
        .insertInto('user_roles')
        .values({
          tenant_id: tenant.tenantId,
          user_id: user.id,
          role_id: role.id,
          created_by: tenant.ownerId,
          updated_by: tenant.ownerId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      return { tenant, roleId: role.id, grantId: grant.id, assignmentId: assignment.id }
    }),
  )
}

describe('DB-C2: role_permissions and user_roles cascades lock roles before users', () => {
  let fixture: Fixture
  let connA: Client
  let connB: Client

  beforeAll(async () => {
    await prepareTestDatabase()
    fixture = await seedFixture()
  }, 60_000)

  afterAll(async () => {
    await connA?.end()
    await connB?.end()
    await teardownTestDatabase()
  })

  it('genuinely blocks a concurrent role_permissions revoke behind a user_roles change on the same role, then completes cleanly (no 40P01)', async () => {
    connA = await rawClient()
    connB = await rawClient()

    await connA.query('BEGIN')
    await connA.query("select set_config('app.tenant_id', $1, true)", [fixture.tenant.tenantId])

    await connB.query('BEGIN')
    await connB.query("select set_config('app.tenant_id', $1, true)", [fixture.tenant.tenantId])

    /*
     * Connection A: revoke the user_roles assignment. Fires
     * user_roles_bump_permission_version, which takes FOR SHARE on
     * `roles` before touching `users` — and then holds both, uncommitted.
     */
    await connA.query(
      `update user_roles set revoked_at = now(), revoked_by = $2, version = 1 where id = $1`,
      [fixture.assignmentId, fixture.tenant.ownerId],
    )

    /*
     * Connection B: revoke the role_permissions grant on the SAME role.
     * Fires role_permissions_bump_permission_version, which needs FOR
     * UPDATE on that SAME `roles` row — a mode that conflicts with A's
     * FOR SHARE. Issued but not awaited yet: this is the statement whose
     * blocking behaviour the test exists to observe.
     */
    const bStatement = connB.query(
      `update role_permissions set revoked_at = now(), revoked_by = $2, version = 1 where id = $1`,
      [fixture.grantId, fixture.tenant.ownerId],
    )

    /*
     * B must still be waiting. Racing against a timer is the only way to
     * observe "has not resolved yet" from outside the server; long enough
     * that a merely slow statement would have finished, short enough that
     * the suite is not needlessly slow.
     */
    const outcome = await Promise.race([
      bStatement.then(() => 'B_COMPLETED' as const),
      sleep(400).then(() => 'STILL_BLOCKED' as const),
    ])
    expect(
      outcome,
      'connection B must be blocked on the roles(FOR UPDATE) lock while A holds FOR SHARE — ' +
        'if it completed immediately, the two cascades raced on `users` unordered instead of ' +
        'queueing on `roles` first (DB-C2).',
    ).toBe('STILL_BLOCKED')

    // Release A. B must now be free to proceed and complete without error.
    await connA.query('COMMIT')

    await expect(bStatement).resolves.toBeDefined()
    await connB.query('COMMIT')

    // Both effects are visible — through the harness now that neither raw
    // connection's transaction-scoped app.tenant_id survives its COMMIT.
    const check = await runAs(
      { tenantId: fixture.tenant.tenantId, userId: fixture.tenant.ownerId },
      () =>
        withTenant(async (tx) => ({
          assignmentRevoked: await tx
            .selectFrom('user_roles')
            .select('revoked_at')
            .where('id', '=', fixture.assignmentId)
            .executeTakeFirstOrThrow(),
          grantRevoked: await tx
            .selectFrom('role_permissions')
            .select('revoked_at')
            .where('id', '=', fixture.grantId)
            .executeTakeFirstOrThrow(),
        })),
    )
    expect(check.assignmentRevoked.revoked_at).not.toBeNull()
    expect(check.grantRevoked.revoked_at).not.toBeNull()
  }, 15_000)
})
