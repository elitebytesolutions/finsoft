import { randomUUID } from 'node:crypto'
import { withTenant } from '@finsoft/database'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * The optional audit origin on seedChartOfAccounts / createFiscalYear
 * (Council review, BACKFILL: "audit records it writes name the CLI").
 * Omitted: the record is unchanged (request_id null, no `via`). Given: the
 * uuid lands in audit_log.request_id and `via` in the hashed after_json.
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

interface AuditRow {
  action: string
  request_id: string | null
  after_json: Record<string, unknown>
}

function asOwner<T>(t: TenantFixture, fn: Parameters<typeof withTenant<T>>[0]): Promise<T> {
  return runAs({ tenantId: t.tenantId, userId: t.ownerId }, () => withTenant(fn))
}

function auditRows(t: TenantFixture): Promise<AuditRow[]> {
  return asOwner(t, (tx) =>
    rawOn<AuditRow>(
      tx,
      `select action, request_id, after_json from audit_log
        where tenant_id = $1 and action in ('CHART_OF_ACCOUNTS_SEEDED', 'FISCAL_YEAR_CREATED')
        order by action`,
      [t.tenantId],
    ),
  )
}

describe('provisioning audit origin', () => {
  it('omitted: request_id is null and after_json carries no via (unchanged behaviour)', async () => {
    const t = await createTenantFixture('AOO')
    await asOwner(t, async (tx) => {
      await seedChartOfAccounts(tx, t.tenantId)
      await createFiscalYear(tx, t.tenantId, 2027)
    })
    const rows = await auditRows(t)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.request_id).toBeNull()
      expect(row.after_json).not.toHaveProperty('via')
    }
  })

  it('given: the uuid is the request_id and via names the tool, on both records', async () => {
    const t = await createTenantFixture('AOG')
    const requestId = randomUUID()
    const origin = { requestId, via: 'backfill-accounting' }
    await asOwner(t, async (tx) => {
      await seedChartOfAccounts(tx, t.tenantId, undefined, origin)
      await createFiscalYear(tx, t.tenantId, 2027, undefined, origin)
    })
    const rows = await auditRows(t)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.request_id).toBe(requestId)
      expect(row.after_json['via']).toBe('backfill-accounting')
    }
  })

  it('rejects a non-uuid requestId before writing anything (audit_log.request_id is uuid)', async () => {
    const t = await createTenantFixture('AOR')
    await expect(
      asOwner(t, (tx) =>
        seedChartOfAccounts(tx, t.tenantId, undefined, { requestId: 'cli:backfill-accounting' }),
      ),
    ).rejects.toThrow(/requestId must be a uuid/)
  })
})
