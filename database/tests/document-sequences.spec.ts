import {
  assignDocumentNumber,
  assignTenantDocumentNumber,
  closeDatabase,
  openDatabase,
  withTenant,
} from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  teardownTestDatabase,
  TEST_TARGET,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationClient, stateOf } from './accounting-support.ts'

/*
 * document_sequences — migration 013, rule 12, PO decision K7.
 *
 * Two scopes: FISCAL_YEAR (JV-2027-000001, reset per year) and TENANT
 * (CUST-000001, one series for the life of the tenant). The concurrency
 * cases run on a pool of several REAL connections — on the default pool of
 * one, a second caller would queue for the connection instead of racing for
 * the row, and the test would pass whether or not the row lock existed.
 */

beforeAll(async () => {
  await prepareTestDatabase()
  await closeDatabase()
  process.env['DATABASE_POOL_MAX'] = '6'
  await openDatabase(TEST_TARGET)
}, 60_000)

afterAll(async () => {
  await closeDatabase()
  process.env['DATABASE_POOL_MAX'] = '1'
  await openDatabase(TEST_TARGET)
  await teardownTestDatabase()
})

function fy(t: TenantFixture, series: string, year: number): Promise<string> {
  return runAs({ tenantId: t.tenantId, userId: t.ownerId }, () =>
    withTenant((tx) => assignDocumentNumber(tx, t.tenantId, series, year, t.ownerId)),
  )
}

function life(t: TenantFixture, series: string): Promise<string> {
  return runAs({ tenantId: t.tenantId, userId: t.ownerId }, () =>
    withTenant((tx) => assignTenantDocumentNumber(tx, t.tenantId, series, t.ownerId)),
  )
}

describe('formatting', () => {
  it('FISCAL_YEAR: SERIES-FY-NNNNNN, restarting at 1 each fiscal year', async () => {
    const t = await createTenantFixture('SQF')
    expect(await fy(t, 'JV', 2027)).toBe('JV-2027-000001')
    expect(await fy(t, 'JV', 2027)).toBe('JV-2027-000002')
    expect(await fy(t, 'JV', 2028)).toBe('JV-2028-000001')
    expect(await fy(t, 'RV', 2027)).toBe('RV-2027-000001')
  })

  it('TENANT (K7): SERIES-NNNNNN, one series for life', async () => {
    const t = await createTenantFixture('SQT')
    expect(await life(t, 'CUST')).toBe('CUST-000001')
    expect(await life(t, 'CUST')).toBe('CUST-000002')
  })

  it('keeps tenants independent', async () => {
    const a = await createTenantFixture('SQA')
    const b = await createTenantFixture('SQB')
    expect(await life(a, 'CUST')).toBe('CUST-000001')
    expect(await life(b, 'CUST')).toBe('CUST-000001')
    expect(await life(a, 'CUST')).toBe('CUST-000002')
  })
})

describe('schema rules', () => {
  it('binds a series to one scope per tenant (23P01)', async () => {
    const t = await createTenantFixture('SQS')
    await life(t, 'CUST')
    expect(await stateOf(fy(t, 'CUST', 2027))).toBe('23P01')
  })

  it('requires fiscal_year exactly when scope = FISCAL_YEAR (23514)', async () => {
    const t = await createTenantFixture('SQC')
    const insert = (scope: string, year: number | null) =>
      stateOf(
        runAs({ tenantId: t.tenantId, userId: t.ownerId }, () =>
          withTenant((tx) =>
            rawOn(
              tx,
              `insert into document_sequences (tenant_id, series, scope, fiscal_year, created_by, updated_by)
               values ($1, 'ZZ', $2, $3, $4, $4)`,
              [t.tenantId, scope, year, t.ownerId],
            ),
          ),
        ),
      )
    expect(await insert('FISCAL_YEAR', null)).toBe('23514')
    expect(await insert('TENANT', 2027)).toBe('23514')
  })

  it('refuses a caller-seeded counter (last_number is not INSERT-able, 42501)', async () => {
    const t = await createTenantFixture('SQN')
    const state = await stateOf(
      runAs({ tenantId: t.tenantId, userId: t.ownerId }, () =>
        withTenant((tx) =>
          rawOn(
            tx,
            `insert into document_sequences (tenant_id, series, scope, last_number, created_by, updated_by)
             values ($1, 'QQ', 'TENANT', 500, $2, $2)`,
            [t.tenantId, t.ownerId],
          ),
        ),
      ),
    )
    expect(state).toBe('42501')
  })

  it('never lets a counter go backwards, for any role (23514)', async () => {
    const t = await createTenantFixture('SQB')
    await life(t, 'CUST')
    await life(t, 'CUST')
    const client = migrationClient()
    await client.connect()
    try {
      const state = await stateOf(
        client.query(
          `update document_sequences set last_number = 1 where tenant_id = $1 and series = 'CUST'`,
          [t.tenantId],
        ),
      )
      expect(state).toBe('23514')
    } finally {
      await client.end()
    }
  })
})

describe('concurrency (rule 12: duplicates impossible)', () => {
  const BURST = 12

  it('TENANT scope: a concurrent burst on a brand-new series yields exactly 1..N, no duplicate', async () => {
    const t = await createTenantFixture('SQX')
    const results = await Promise.all(Array.from({ length: BURST }, () => life(t, 'CUST')))
    const expected = Array.from(
      { length: BURST },
      (_, i) => `CUST-${String(i + 1).padStart(6, '0')}`,
    )
    expect([...results].sort()).toEqual(expected)
  }, 30_000)

  it('FISCAL_YEAR scope: the same burst yields exactly 1..N', async () => {
    const t = await createTenantFixture('SQY')
    const results = await Promise.all(Array.from({ length: BURST }, () => fy(t, 'JV', 2027)))
    const expected = Array.from(
      { length: BURST },
      (_, i) => `JV-2027-${String(i + 1).padStart(6, '0')}`,
    )
    expect([...results].sort()).toEqual(expected)
  }, 30_000)

  it('TENANT scope: a second caller WAITS on the first holder, then gets the next number', async () => {
    const t = await createTenantFixture('SQW')
    await life(t, 'CUST') // CUST-000001 exists; the row is there to be locked.

    let releaseA!: () => void
    const aMayCommit = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let aAssigned!: (n: string) => void
    const aHasNumber = new Promise<string>((resolve) => {
      aAssigned = resolve
    })

    const a = runAs({ tenantId: t.tenantId, userId: t.ownerId }, () =>
      withTenant(async (tx) => {
        const n = await assignTenantDocumentNumber(tx, t.tenantId, 'CUST', t.ownerId)
        aAssigned(n)
        await aMayCommit // hold the row lock open
        return n
      }),
    )

    const aNumber = await aHasNumber
    let bSettled = false
    const b = life(t, 'CUST').then((n) => {
      bSettled = true
      return n
    })

    await new Promise((r) => setTimeout(r, 300))
    expect(bSettled, 'B must be blocked on the counter row while A holds it').toBe(false)

    releaseA()
    const [aFinal, bNumber] = await Promise.all([a, b])
    expect(aFinal).toBe(aNumber)
    expect(aNumber).toBe('CUST-000002')
    expect(bNumber).toBe('CUST-000003')
  }, 30_000)
})
