import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import {
  closeDatabase,
  listAuditEvents,
  openDatabase,
  withTenant,
  type TenantTx,
} from '@finsoft/database'
import {
  createTenantFixture,
  migrateTestDatabase,
  prepareTestDatabase,
  runAs,
  TEST_TARGET,
  type TenantFixture,
} from '@finsoft/database/testing'
import { createFiscalYear } from '@finsoft/database/provisioning'
import { periodEngine, PostingError } from '@finsoft/accounting-kernel'

/*
 * The kernel's period transitions — close, reopen, lock — now that their
 * bodies live in packages/accounting-kernel/src/queries/periods.ts (T3
 * Council, Arch 1/2/5, Acct F3/R3). periods.md §4, §4.1, §7, §9; ADR-0012.
 *
 * Every refusal code periods.md §9 names for a transition, the audit record
 * each success writes and each refusal does not, the no-user refusal (rule
 * 22), tenant scoping of the label, and a real two-backend race on the same
 * period — the case the kernel now decides from the row read under the
 * calendar lock rather than from a caller-supplied version.
 */

type Status = 'OPEN' | 'CLOSED' | 'LOCKED'

const as = <T>(t: TenantFixture, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
  runAs({ tenantId: t.tenantId, userId: t.ownerId }, () => withTenant(fn))

async function newTenant(label: string): Promise<TenantFixture> {
  const t = await createTenantFixture(label)
  await as(t, (tx) => createFiscalYear(tx, t.tenantId, 2027))
  return t
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PostingError) return error.code
    throw error
  }
  return 'RESOLVED'
}

async function statuses(t: TenantFixture): Promise<Record<string, Status>> {
  const rows = await as(t, (tx) =>
    sql<{ label: string; status: Status }>`
      SELECT label, status FROM fiscal_periods WHERE tenant_id = ${t.tenantId} ORDER BY period_start
    `.execute(tx),
  )
  return Object.fromEntries(rows.rows.map((r) => [r.label, r.status]))
}

async function periodAudit(t: TenantFixture): Promise<string[]> {
  const page = await as(t, (tx) =>
    listAuditEvents(tx, { entityType: 'fiscal_periods', limit: 100 }),
  )
  return page.items
    .map((r) => r.action)
    .filter((a) => a !== 'FISCAL_YEAR_CREATED')
    .sort()
}

const close = (t: TenantFixture, label: string) => as(t, (tx) => periodEngine.close(label, tx))
const lock = (t: TenantFixture, label: string) => as(t, (tx) => periodEngine.lock(label, tx))
const reopen = (t: TenantFixture, label: string, reason = 'correction') =>
  as(t, (tx) => periodEngine.reopen(label, reason, tx))

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
  // The race below needs two real backends (see financial-invariant-suite.spec.ts).
  await closeDatabase()
  process.env['DATABASE_POOL_MAX'] = '4'
  await openDatabase(TEST_TARGET)
}, 120_000)

afterAll(async () => {
  await closeDatabase()
  process.env['DATABASE_POOL_MAX'] = '1'
})

describe('periodEngine — the kernel-owned transitions', () => {
  it('close -> lock -> in order; each success writes exactly one audit record and bumps version', async () => {
    const t = await newTenant('PT1')
    const closed = await close(t, '2026-07')
    expect(closed).toMatchObject({
      label: '2026-07',
      status: 'CLOSED',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      fiscalYear: 2027,
      periodIndex: 1,
      version: 1,
      tenantId: t.tenantId,
    })
    const locked = await lock(t, '2026-07')
    expect(locked).toMatchObject({ status: 'LOCKED', version: 2 })
    await close(t, '2026-08')
    const reopened = await reopen(t, '2026-08', '  late vendor bill  ')
    expect(reopened).toMatchObject({ status: 'OPEN', version: 2 })
    const stored = await as(t, (tx) =>
      sql<{ reopen_reason: string; closed_by: string | null; reopened_by: string }>`
        SELECT reopen_reason, closed_by, reopened_by FROM fiscal_periods
         WHERE tenant_id = ${t.tenantId} AND label = '2026-08'
      `.execute(tx),
    )
    expect(stored.rows[0]).toEqual({
      reopen_reason: 'late vendor bill',
      closed_by: null,
      reopened_by: t.ownerId,
    })
    expect(await periodAudit(t)).toEqual([
      'PERIOD_CLOSED',
      'PERIOD_CLOSED',
      'PERIOD_LOCKED',
      'PERIOD_REOPENED',
    ])
  })

  it('refuses every out-of-order and wrong-state transition with its periods.md §9 code, writing nothing', async () => {
    const t = await newTenant('PT2')
    const cases: [string, () => Promise<unknown>, string][] = [
      ['close Aug while Jul OPEN', () => close(t, '2026-08'), 'PERIOD_CLOSE_OUT_OF_ORDER'],
      ['reopen an OPEN period', () => reopen(t, '2026-07'), 'PERIOD_NOT_CLOSED'],
      ['lock an OPEN period', () => lock(t, '2026-07'), 'PERIOD_NOT_CLOSED'],
      ['unknown label', () => close(t, '2031-01'), 'PERIOD_NOT_FOUND'],
      ['malformed label', () => close(t, 'July'), 'PAYLOAD_INVALID'],
      ['empty reopen reason', () => reopen(t, '2026-07', '   '), 'PERIOD_REOPEN_REASON_REQUIRED'],
      [
        'reopen reason over 500',
        () => reopen(t, '2026-07', 'x'.repeat(501)),
        'PERIOD_REOPEN_REASON_REQUIRED',
      ],
    ]
    for (const [label, attempt, code] of cases) {
      expect(await codeOf(attempt()), label).toBe(code)
    }

    await close(t, '2026-07')
    await close(t, '2026-08')
    const more: [string, () => Promise<unknown>, string][] = [
      ['close an already CLOSED period', () => close(t, '2026-07'), 'PERIOD_CLOSED'],
      ['reopen Jul while Aug CLOSED', () => reopen(t, '2026-07'), 'PERIOD_REOPEN_OUT_OF_ORDER'],
      ['lock Aug while Jul not LOCKED', () => lock(t, '2026-08'), 'PERIOD_LOCK_OUT_OF_ORDER'],
    ]
    for (const [label, attempt, code] of more) {
      expect(await codeOf(attempt()), label).toBe(code)
    }

    await lock(t, '2026-07')
    const onLocked: [string, () => Promise<unknown>, string][] = [
      ['close a LOCKED period', () => close(t, '2026-07'), 'PERIOD_LOCKED'],
      ['reopen a LOCKED period', () => reopen(t, '2026-07'), 'PERIOD_LOCKED'],
      ['lock a LOCKED period', () => lock(t, '2026-07'), 'PERIOD_LOCKED'],
    ]
    for (const [label, attempt, code] of onLocked) {
      expect(await codeOf(attempt()), label).toBe(code)
    }

    // Only the three successful transitions left a trace.
    expect(await periodAudit(t)).toEqual(['PERIOD_CLOSED', 'PERIOD_CLOSED', 'PERIOD_LOCKED'])
    expect((await statuses(t))['2026-07']).toBe('LOCKED')
    expect((await statuses(t))['2026-08']).toBe('CLOSED')
  })

  it('no user, no transition (rule 22) — there is no job or service account that closes a period', async () => {
    const t = await newTenant('PT3')
    const code = await codeOf(
      runAs({ tenantId: t.tenantId, userId: null }, () =>
        withTenant((tx) => periodEngine.close('2026-07', tx)),
      ),
    )
    expect(code).toBe('FORBIDDEN')
    expect((await statuses(t))['2026-07']).toBe('OPEN')
  })

  it("a label resolves only within the caller's own tenant", async () => {
    const a = await newTenant('PT4A')
    const b = await newTenant('PT4B')
    await close(a, '2026-07')
    expect((await statuses(a))['2026-07']).toBe('CLOSED')
    expect((await statuses(b))['2026-07']).toBe('OPEN')
  })

  it('two concurrent closes of the same period: one transitions, the other is answered PERIOD_CLOSED', async () => {
    const t = await newTenant('PT5')
    // Hold the calendar lock in one transaction while the second close queues behind it.
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    let signal!: () => void
    const closedFirst = new Promise<void>((resolve) => (signal = resolve))
    const first = as(t, async (tx) => {
      const row = await periodEngine.close('2026-07', tx)
      signal()
      await hold
      return row
    })
    await closedFirst
    const second = codeOf(close(t, '2026-07'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    release()
    const [row, code] = await Promise.all([first, second])
    expect(row.status).toBe('CLOSED')
    expect(code).toBe('PERIOD_CLOSED')
    expect(await periodAudit(t)).toEqual(['PERIOD_CLOSED'])
  })
})
