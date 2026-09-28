import { Client } from 'pg'
import { recordAudit, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * TD-001. ADR-0020 §5 states a lock_timeout bounds the queue on the
 * terminal advisory lock "so contention surfaces as a bounded error rather
 * than an unbounded stall" — Database Guardian review found no mechanism
 * shipped that value anywhere, and named this migration/lane as what forces
 * the decision. `recordAudit` and `createAuditChainAnchor` now
 * `SET LOCAL lock_timeout` immediately before taking the lock; this proves
 * it actually bounds the wait rather than merely reading as a comment.
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

function migrationClient(): Client {
  const url = process.env['TEST_MIGRATION_DATABASE_URL']
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
  return new Client({ connectionString: url })
}

function lockKeyExprFor(tenantId: string): string {
  return `(
    ('x' || substr(replace('${tenantId}', '-', ''),  1, 16))::bit(64)::bigint
    # ('x' || substr(replace('${tenantId}', '-', ''), 17, 16))::bit(64)::bigint
  )`
}

describe('lock_timeout on the terminal advisory lock', () => {
  it('recordAudit fails with 55P03 rather than stalling, when the lock is already held', async () => {
    const tenant = await createTenantFixture('LTO')

    const holder = migrationClient()
    await holder.connect()

    try {
      // Hold the SAME terminal advisory lock this tenant's recordAudit call
      // will need, indefinitely (no COMMIT until this test releases it).
      await holder.query('BEGIN')
      await holder.query(`SELECT pg_advisory_xact_lock(${lockKeyExprFor(tenant.tenantId)})`)

      const start = Date.now()
      await expect(
        runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
          withTenant((tx) =>
            recordAudit(tx, {
              actorUserId: tenant.ownerId,
              action: 'SHOULD_TIME_OUT',
              entityType: 'probe',
              entityId: null,
              beforeJson: null,
              afterJson: null,
              ip: null,
              requestId: null,
            }),
          ),
        ),
      ).rejects.toMatchObject({ name: 'AuditLockTimeoutError' })

      const elapsed = Date.now() - start
      // 2000ms configured; bounded well under the 15000ms statement_timeout
      // that would otherwise be the only thing standing between this and an
      // unbounded stall (TD-001's own framing).
      expect(elapsed).toBeGreaterThanOrEqual(1800)
      expect(elapsed).toBeLessThan(10_000)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
  }, 20_000)

  it('does not time out when the lock is free', async () => {
    const tenant = await createTenantFixture('LTF')
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) =>
          recordAudit(tx, {
            actorUserId: tenant.ownerId,
            action: 'SHOULD_SUCCEED',
            entityType: 'probe',
            entityId: null,
            beforeJson: null,
            afterJson: null,
            ip: null,
            requestId: null,
          }),
        ),
      ),
    ).resolves.toMatchObject({ seq: '1' })
  })
})
