import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listAllAccounts, withTenant, type TenantTx } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import { withCorrelation } from '@finsoft/observability'
import {
  FinancialEvent,
  periodEngine,
  postingEngine,
  reversalEngine,
} from '@finsoft/accounting-kernel'

/*
 * M2-A, Council T3 final item: the Architecture seat's M1-C ruling ("every
 * audit row must carry a request id") applies to the accounting kernel's own
 * audit writes — posting, reversal and period transitions — exactly as it
 * applies to auth. Those call sites (posting-engine.ts, reversal.ts,
 * queries/periods.ts) now OMIT `requestId`/`ip` on their AuditEventInput
 * rather than passing an explicit `null`, so `recordAudit`
 * (packages/database/src/audit/writer.ts) defaults both from the ambient
 * correlation context established by `withCorrelation` — the same contract
 * M1-C's own database/tests/audit-log-correlation.spec.ts asserts for
 * `recordAudit` in isolation. This test asserts it end to end, through the
 * real kernel, against real stored rows: a posting, a reversal and a period
 * close inside a correlation context carry that context's request id, and
 * outside any context the column stays null rather than being fabricated.
 */

interface AccountIds {
  bank: string
  capital: string
}

interface StoredAuditRow {
  action: string
  request_id: string | null
}

/** Today, minus a small buffer, and the fiscal year that date falls in (fiscalYearStartMonth=7, periods.md §2). */
function pastOccurredAtAndFiscalYear(): { occurredAt: string; fiscalYear: number } {
  const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  const occurredAt = past.toISOString().slice(0, 10)
  const year = past.getUTCFullYear()
  const month = past.getUTCMonth() + 1
  const fiscalYear = month >= 7 ? year + 1 : year
  return { occurredAt, fiscalYear }
}

async function setUpTenant(
  label: string,
): Promise<{ fixture: TenantFixture; accounts: AccountIds }> {
  const fixture = await createTenantFixture(label)
  const { fiscalYear } = pastOccurredAtAndFiscalYear()
  const accounts = await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant(async (tx) => {
      await seedChartOfAccounts(tx, fixture.tenantId)
      await createFiscalYear(tx, fixture.tenantId, fiscalYear)
      const rows = await listAllAccounts(tx, fixture.tenantId)
      const byCode = new Map(rows.map((r) => [r.code, r.id]))
      return {
        bank: byCode.get('1120')!,
        capital: byCode.get('3100')!,
      }
    }),
  )
  return { fixture, accounts }
}

async function auditRowsFor(
  fixture: TenantFixture,
  entityType: string,
  entityId: string,
  action: string,
): Promise<StoredAuditRow[]> {
  return runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant((tx) =>
      rawOn<StoredAuditRow>(
        tx,
        'select action, request_id from audit_log where entity_type = $1 and entity_id = $2 and action = $3 order by seq',
        [entityType, entityId, action],
      ),
    ),
  )
}

const post = (fixture: TenantFixture, accounts: AccountIds, occurredAt: string, key: string) =>
  runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant((tx: TenantTx) =>
      postingEngine.post(
        {
          event: FinancialEvent.JOURNAL_VOUCHER_POSTED,
          referenceType: 'journal_voucher',
          referenceId: randomUUID(),
          occurredAt,
          idempotencyKey: key,
          payload: {
            narration: 'M2-A correlation probe',
            lines: [
              { accountId: accounts.bank, debit: '1000.0000' },
              { accountId: accounts.capital, credit: '1000.0000' },
            ],
          },
        },
        tx,
      ),
    ),
  )

const reverse = (fixture: TenantFixture, entryId: string, key: string) =>
  runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant((tx: TenantTx) =>
      reversalEngine.reverse(
        { entryId, reason: 'correlation probe reversal', idempotencyKey: key },
        tx,
      ),
    ),
  )

const closePeriod = (fixture: TenantFixture, label: string) =>
  runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant((tx: TenantTx) => periodEngine.close(label, tx)),
  )

beforeAll(async () => {
  await prepareTestDatabase()
}, 120_000)

afterAll(async () => teardownTestDatabase())

describe('accounting-kernel audit rows default request_id from the ambient correlation context', () => {
  it('a posting inside withCorrelation writes an audit row carrying that request id', async () => {
    const { fixture, accounts } = await setUpTenant('CORA')
    const { occurredAt } = pastOccurredAtAndFiscalYear()
    const requestId = '21111111-2222-4333-8444-555555555561'

    const result = await withCorrelation({ requestId }, () =>
      post(fixture, accounts, occurredAt, 'corr-post-1'),
    )

    const rows = await auditRowsFor(
      fixture,
      'journal_entries',
      result.journalEntryId,
      'JOURNAL_ENTRY_POSTED',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.request_id).toBe(requestId)
  })

  it('a reversal inside withCorrelation writes its own audit row carrying that request id', async () => {
    const { fixture, accounts } = await setUpTenant('CORB')
    const { occurredAt } = pastOccurredAtAndFiscalYear()
    const postRequestId = '21111111-2222-4333-8444-555555555562'
    const reverseRequestId = '21111111-2222-4333-8444-555555555563'

    const posted = await withCorrelation({ requestId: postRequestId }, () =>
      post(fixture, accounts, occurredAt, 'corr-post-2'),
    )

    const reversed = await withCorrelation({ requestId: reverseRequestId }, () =>
      reverse(fixture, posted.journalEntryId, 'corr-reverse-2'),
    )

    // The original entry's REVERSED audit row is keyed by the ORIGINAL entry's id (reversal.ts).
    const reversalRows = await auditRowsFor(
      fixture,
      'journal_entries',
      posted.journalEntryId,
      'JOURNAL_ENTRY_REVERSED',
    )
    expect(reversalRows).toHaveLength(1)
    expect(reversalRows[0]!.request_id).toBe(reverseRequestId)

    // And the reversal's own POSTED audit row carries the same (reversal-time) request id.
    const reversalPostRows = await auditRowsFor(
      fixture,
      'journal_entries',
      reversed.journalEntryId,
      'JOURNAL_ENTRY_POSTED',
    )
    expect(reversalPostRows).toHaveLength(1)
    expect(reversalPostRows[0]!.request_id).toBe(reverseRequestId)
  })

  it('a period close inside withCorrelation writes an audit row carrying that request id', async () => {
    const { fixture } = await setUpTenant('CORC')
    const { fiscalYear } = pastOccurredAtAndFiscalYear()
    const requestId = '21111111-2222-4333-8444-555555555564'

    // The first monthly period of the fiscal year just created (periods.md §4.1: closes in calendar order).
    const label = `${fiscalYear - 1}-07`

    const closed = await withCorrelation({ requestId }, () => closePeriod(fixture, label))

    const rows = await auditRowsFor(fixture, 'fiscal_periods', closed.id, 'PERIOD_CLOSED')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.request_id).toBe(requestId)
  })

  it('outside any correlation context, the same three operations leave request_id null', async () => {
    const { fixture, accounts } = await setUpTenant('CORD')
    const { occurredAt, fiscalYear } = pastOccurredAtAndFiscalYear()

    const posted = await post(fixture, accounts, occurredAt, 'corr-post-4')
    const postRows = await auditRowsFor(
      fixture,
      'journal_entries',
      posted.journalEntryId,
      'JOURNAL_ENTRY_POSTED',
    )
    expect(postRows).toHaveLength(1)
    expect(postRows[0]!.request_id).toBeNull()

    const reversed = await reverse(fixture, posted.journalEntryId, 'corr-reverse-4')
    const reversalRows = await auditRowsFor(
      fixture,
      'journal_entries',
      posted.journalEntryId,
      'JOURNAL_ENTRY_REVERSED',
    )
    expect(reversalRows).toHaveLength(1)
    expect(reversalRows[0]!.request_id).toBeNull()
    expect(reversed.journalEntryId).toBeTruthy()

    const label = `${fiscalYear - 1}-07`
    const closed = await closePeriod(fixture, label)
    const closeRows = await auditRowsFor(fixture, 'fiscal_periods', closed.id, 'PERIOD_CLOSED')
    expect(closeRows).toHaveLength(1)
    expect(closeRows[0]!.request_id).toBeNull()
  })
})
