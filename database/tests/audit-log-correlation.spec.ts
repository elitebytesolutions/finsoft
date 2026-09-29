import { recordAudit, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { withCorrelation } from '@finsoft/observability'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * M1-C: recordAudit defaults request_id/ip from the ambient correlation
 * context when its caller omits them, never fabricates one when there is no
 * context, and always lets an explicit caller value — including an explicit
 * null — win. See the M1-C comment on recordAudit in
 * packages/database/src/audit/writer.ts for the three rules this asserts.
 *
 * Exercised against real PostgreSQL, reading back the actual stored
 * `request_id`/`ip` columns — the whole point is that the value that gets
 * HASHED into the chain is the one this test checks, not an intermediate
 * in-memory value.
 */

let tenant: TenantFixture

beforeAll(async () => {
  await prepareTestDatabase()
  tenant = await createTenantFixture('CORR')
}, 60_000)

afterAll(async () => teardownTestDatabase())

interface StoredRow {
  request_id: string | null
  ip: string | null
}

async function append(action: string) {
  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant(async (tx) => {
      const result = await recordAudit(tx, {
        actorUserId: tenant.ownerId,
        action,
        entityType: 'probe',
        entityId: null,
        beforeJson: null,
        afterJson: null,
      })
      const [row] = await rawOn<StoredRow>(
        tx,
        'select request_id, ip from audit_log where id = $1',
        [result.id],
      )
      return { result, row: row! }
    }),
  )
}

describe('recordAudit — request_id/ip default from the ambient correlation context', () => {
  it('defaults both from context when the caller omits them', async () => {
    const requestId = '11111111-2222-4333-8444-555555555555'
    const { row } = await withCorrelation({ requestId, ip: '203.0.113.20' }, () =>
      append('CTX_BOTH'),
    )

    expect(row.request_id).toBe(requestId)
    expect(row.ip).toBe('203.0.113.20')
  })

  it('normalises the context ip the same way an explicit ip would be normalised', async () => {
    const requestId = '11111111-2222-4333-8444-555555555556'
    const { row } = await withCorrelation({ requestId, ip: '2001:0DB8::1' }, () =>
      append('CTX_IPV6'),
    )

    // RFC 5952 canonical form — lowercase, compressed. ip.ts's own job.
    expect(row.ip).toBe('2001:db8::1')
  })

  it('stays null when there is no context and the caller omits the fields', async () => {
    const { row } = await append('NO_CONTEXT')

    expect(row.request_id).toBeNull()
    expect(row.ip).toBeNull()
  })

  it('an explicit null always wins over an ambient context', async () => {
    const requestId = '11111111-2222-4333-8444-555555555557'
    const { row } = await withCorrelation({ requestId, ip: '203.0.113.21' }, () =>
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant(async (tx) => {
          const result = await recordAudit(tx, {
            actorUserId: tenant.ownerId,
            action: 'EXPLICIT_NULL_WINS',
            entityType: 'probe',
            entityId: null,
            beforeJson: null,
            afterJson: null,
            ip: null,
            requestId: null,
          })
          const [stored] = await rawOn<StoredRow>(
            tx,
            'select request_id, ip from audit_log where id = $1',
            [result.id],
          )
          return { result, row: stored! }
        }),
      ),
    )

    expect(row.request_id).toBeNull()
    expect(row.ip).toBeNull()
  })

  it('an explicit value always wins over an ambient context', async () => {
    const contextRequestId = '11111111-2222-4333-8444-555555555558'
    const explicitRequestId = '99999999-8888-4777-9666-555555555555'
    const { row } = await withCorrelation({ requestId: contextRequestId, ip: '203.0.113.22' }, () =>
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant(async (tx) => {
          const result = await recordAudit(tx, {
            actorUserId: tenant.ownerId,
            action: 'EXPLICIT_VALUE_WINS',
            entityType: 'probe',
            entityId: null,
            beforeJson: null,
            afterJson: null,
            ip: '198.51.100.9',
            requestId: explicitRequestId,
          })
          const [stored] = await rawOn<StoredRow>(
            tx,
            'select request_id, ip from audit_log where id = $1',
            [result.id],
          )
          return { result, row: stored! }
        }),
      ),
    )

    expect(row.request_id).toBe(explicitRequestId)
    expect(row.ip).toBe('198.51.100.9')
  })

  it('defaults only the omitted field when one of the two is explicit', async () => {
    const contextRequestId = '11111111-2222-4333-8444-555555555559'
    const { row } = await withCorrelation({ requestId: contextRequestId, ip: '203.0.113.23' }, () =>
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant(async (tx) => {
          const result = await recordAudit(tx, {
            actorUserId: tenant.ownerId,
            action: 'PARTIAL_DEFAULT',
            entityType: 'probe',
            entityId: null,
            beforeJson: null,
            afterJson: null,
            ip: null, // explicit: no address for this one
            // requestId omitted: defaults from context
          })
          const [stored] = await rawOn<StoredRow>(
            tx,
            'select request_id, ip from audit_log where id = $1',
            [result.id],
          )
          return { result, row: stored! }
        }),
      ),
    )

    expect(row.request_id).toBe(contextRequestId)
    expect(row.ip).toBeNull()
  })

  it('a context with no ip (worker/job shape) defaults request_id only, ip stays null', async () => {
    const requestId = '11111111-2222-4333-8444-55555555555a'
    const { row } = await withCorrelation({ requestId }, () => append('JOB_SHAPE_CONTEXT'))

    expect(row.request_id).toBe(requestId)
    expect(row.ip).toBeNull()
  })
})
