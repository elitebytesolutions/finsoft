import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  findEntryById,
  findLinesByEntryId,
  findPeriodForDate,
  listAllAccounts,
  trialBalanceRawSums,
  withGlobal,
  withTenant,
  type JournalEntryRow,
  type TenantTx,
} from '@finsoft/database'
import { createTenantFixture, runAs, sqlstate, type TenantFixture } from '@finsoft/database/testing'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import {
  fixedClock,
  KernelInvariantError,
  periodEngine,
  PostingError,
} from '@finsoft/accounting-kernel'
import { Money } from '@finsoft/validation'
// Clock injection is test-only; these are deliberately not on the package's public surface.
import {
  assertEntryWellFormed,
  createPostingEngine,
  type PostCommand,
  type PostResult,
} from '../../packages/accounting-kernel/src/posting-engine.ts'
import { createReversalEngine } from '../../packages/accounting-kernel/src/reversal.ts'
import {
  countAuditRecords,
  countJournalEntries,
  entryNumbersInSeries,
  reversalResiduals,
  unbalancedEntries,
  unbalancedTrialBalances,
} from './golden-support.ts'

/*
 * FinancialInvariantSuite — Invariants 1, 2, 4, 5, 6, 8 (M2-A).
 *
 * One fixture tenant with real activity, built through the kernel exactly as
 * production posts: vouchers, a reversal while the original's period is open,
 * a reversal after it closed, closed and locked periods. "Today" is fixed so
 * the suite does not depend on the day it runs.
 *
 * Detectors (1, 2, 6) run over EVERY tenant in the database, each under its
 * own tenant context: the suite connects as finsoft_app with RLS forced and
 * cannot, by design, read across tenants in one query. Every detector also
 * asserts it is not vacuous.
 *
 * THE ONE TEST FILE THAT WRITES THE JOURNAL AROUND THE KERNEL. Invariants 1,
 * 4 and 5 are only proven by attempting the forbidden write and watching the
 * database refuse it, so eslint.config.mjs exempts this file — by name —
 * from the journal-write boundary rule, as it exempts database/tests.
 */

const TODAY = '2026-09-27'
const clock = fixedClock(`${TODAY}T12:00:00.000Z`)
const engine = createPostingEngine(clock)
const reversal = createReversalEngine(clock)

let tenant: TenantFixture
let accounts: Map<string, string>
let augustVoucher: PostResult
let septemberVoucher: PostResult

const asOwner = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
  runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () => withTenant(fn))

const asTenantReader = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
  runAs({ tenantId, userId: null }, () => withTenant(fn))

function jv(
  key: string,
  occurredAt: string,
  lines: [string, 'debit' | 'credit', string][],
  ids = accounts,
): PostCommand {
  return {
    event: 'JOURNAL_VOUCHER_POSTED',
    referenceType: 'journal_voucher',
    referenceId: randomUUID(),
    occurredAt,
    idempotencyKey: key,
    payload: {
      narration: `Invariant suite ${key}`,
      lines: lines.map(([code, side, amount]) => ({ accountId: ids.get(code)!, [side]: amount })),
    },
  }
}

const post = (command: PostCommand) => asOwner((tx) => engine.post(command, tx))

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection, but the call succeeded')
}

const codeOf = (error: unknown): string =>
  error instanceof PostingError ? error.code : `not a PostingError: ${String(error)}`

async function everyTenant(): Promise<string[]> {
  const rows = await withGlobal((tx) => tx.selectFrom('tenants').select('id').execute())
  return rows.map((row) => row.id)
}

function bypassEntry(periodId: string, occurredAt: string, number: string, key: string) {
  return {
    tenant_id: tenant.tenantId,
    entry_number: number,
    posting_rule: 'JOURNAL_VOUCHER_POSTED@1',
    event: 'JOURNAL_VOUCHER_POSTED',
    occurred_at: occurredAt,
    fiscal_period_id: periodId,
    narration: 'bypass attempt',
    source_type: 'journal_voucher',
    source_id: randomUUID(),
    idempotency_key: key,
    request_fingerprint: '0'.repeat(64),
    created_by: tenant.ownerId,
    updated_by: tenant.ownerId,
  }
}

function bypassLine(
  entryId: string,
  lineNumber: number,
  code: string,
  debit: string,
  credit: string,
) {
  return {
    tenant_id: tenant.tenantId,
    entry_id: entryId,
    line_number: lineNumber,
    account_id: accounts.get(code)!,
    account_control: 'NONE',
    debit,
    credit,
    created_by: tenant.ownerId,
    updated_by: tenant.ownerId,
  }
}

/** A transaction that holds the posting of `command` open until released — to force a real race. */
function heldPosting(command: PostCommand) {
  let release!: () => void
  const hold = new Promise<void>((resolve) => (release = resolve))
  let signal!: () => void
  const posted = new Promise<void>((resolve) => (signal = resolve))
  const done = asOwner(async (tx) => {
    const result = await engine.post(command, tx)
    signal()
    await hold
    return result
  })
  return { posted, release, done }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function registerPostingInvariantChecks(): void {
  describe('Invariants 1, 2, 4, 5, 6, 8 — against the real kernel and database (M2-A)', () => {
    beforeAll(async () => {
      tenant = await createTenantFixture('FIS')
      const all = await asOwner(async (tx) => {
        await seedChartOfAccounts(tx, tenant.tenantId)
        await createFiscalYear(tx, tenant.tenantId, 2027)
        return listAllAccounts(tx, tenant.tenantId)
      })
      accounts = new Map(all.map((account) => [account.code, account.id]))

      await post(
        jv('inv-capital', '2026-07-01', [
          ['1120', 'debit', '750000.0000'],
          ['3100', 'credit', '750000.0000'],
        ]),
      )
      augustVoucher = await post(
        jv('inv-aug', '2026-08-12', [
          ['6200', 'debit', '45000.0000'],
          ['6300', 'debit', '1249.5000'],
          ['6400', 'debit', '8750.5000'],
          ['1120', 'credit', '55000.0000'],
        ]),
      )
      septemberVoucher = await post(
        jv('inv-sep', '2026-09-03', [
          ['6300', 'debit', '0.0001'],
          ['1110', 'credit', '0.0001'],
        ]),
      )
      // Reversal while the original's period is OPEN: R takes E's date.
      await asOwner((tx) =>
        reversal.reverse(
          {
            entryId: septemberVoucher.entry.id,
            reason: 'Duplicate',
            idempotencyKey: 'inv-rev-sep',
          },
          tx,
        ),
      )
      // Close July and August, then reverse the August voucher: R is dated today.
      await asOwner((tx) => periodEngine.close('2026-07', tx))
      await asOwner((tx) => periodEngine.close('2026-08', tx))
      await asOwner((tx) =>
        reversal.reverse(
          {
            entryId: augustVoucher.entry.id,
            reason: 'Wrong vendor',
            idempotencyKey: 'inv-rev-aug',
          },
          tx,
        ),
      )
      await asOwner((tx) => periodEngine.lock('2026-07', tx))
    }, 120_000)

    describe('Invariant 1: Σ debit = Σ credit for every posted journal entry', () => {
      it('holds for every entry of every tenant, and the check is not vacuous', async () => {
        let entriesChecked = 0
        for (const tenantId of await everyTenant()) {
          const offenders = await asTenantReader(tenantId, (tx) => unbalancedEntries(tx, tenantId))
          expect(offenders, `tenant ${tenantId}: unbalanced or incomplete entries`).toEqual([])
          entriesChecked += await asTenantReader(tenantId, (tx) =>
            countJournalEntries(tx, tenantId),
          )
        }
        expect(entriesChecked).toBeGreaterThanOrEqual(5)
      })

      it('the kernel rejects a voucher out by 0.0001 — rejected, never completed', async () => {
        const before = await asOwner((tx) => countJournalEntries(tx, tenant.tenantId))
        const error = await rejectionOf(
          post(
            jv('inv-unbalanced', '2026-09-10', [
              ['6300', 'debit', '100.0000'],
              ['1110', 'credit', '99.9999'],
            ]),
          ),
        )
        expect(codeOf(error)).toBe('JV_UNBALANCED')
        expect((error as PostingError).details).toEqual({
          debit: '100.0000',
          credit: '99.9999',
          difference: '0.0001',
        })
        expect(await asOwner((tx) => countJournalEntries(tx, tenant.tenantId))).toBe(before)
      })

      it('step 7 reports a rule-built imbalance or party mismatch and never adds a balancing line', () => {
        const line = (n: number, debit: string, credit: string) => ({
          lineNumber: n,
          accountId: randomUUID(),
          accountControl: 'NONE' as const,
          debit,
          credit,
          partyType: null,
          partyId: null,
          memo: null,
        })
        expect(() =>
          assertEntryWellFormed([line(1, '10.0000', '0.0000'), line(2, '0.0000', '9.9999')]),
        ).toThrow(KernelInvariantError)
        // README §4.1: an AR line without a customer never reaches the database.
        expect(() =>
          assertEntryWellFormed([
            { ...line(1, '10.0000', '0.0000'), accountControl: 'AR' },
            line(2, '0.0000', '10.0000'),
          ]),
        ).toThrow(KernelInvariantError)
      })

      it('the database refuses to COMMIT an unbalanced entry written around the kernel', async () => {
        const period = await asOwner((tx) => findPeriodForDate(tx, tenant.tenantId, '2026-09-10'))
        const error = await rejectionOf(
          asOwner(async (tx) => {
            const entry = await tx
              .insertInto('journal_entries')
              .values(
                bypassEntry(period!.id, '2026-09-10', 'JV-2027-999901', 'inv-bypass-unbalanced'),
              )
              .returning('id')
              .executeTakeFirstOrThrow()
            await tx
              .insertInto('journal_lines')
              .values([
                bypassLine(entry.id, 1, '6300', '100.0000', '0'),
                bypassLine(entry.id, 2, '1110', '0', '99.9999'),
              ])
              .execute()
          }),
        )
        expect(sqlstate(error)).toBe('23514')
        expect(
          await asOwner((tx) => entryNumbersInSeries(tx, tenant.tenantId, 'JV')),
        ).not.toContain('JV-2027-999901')
      })
    })

    describe('Invariant 2: trial balance debits = credits, every tenant, every period', () => {
      it('holds at every fiscal period end of every tenant, and the check is not vacuous', async () => {
        let tenantsWithActivity = 0
        for (const tenantId of await everyTenant()) {
          const offenders = await asTenantReader(tenantId, (tx) =>
            unbalancedTrialBalances(tx, tenantId),
          )
          expect(offenders, `tenant ${tenantId}: trial balance out of balance`).toEqual([])
          if ((await asTenantReader(tenantId, (tx) => countJournalEntries(tx, tenantId))) > 0)
            tenantsWithActivity += 1
        }
        expect(tenantsWithActivity).toBeGreaterThanOrEqual(1)
      })

      it('the ledger query agrees, exactly', async () => {
        const rows = await asOwner((tx) => trialBalanceRawSums(tx, tenant.tenantId, '2027-06-30'))
        expect(rows.length).toBeGreaterThan(0)
        const debit = Money.sum(rows.map((row) => Money.from(row.debit)))
        const credit = Money.sum(rows.map((row) => Money.from(row.credit)))
        expect(Money.serialize(debit, 4)).toBe(Money.serialize(credit, 4))
      })
    })

    describe('Invariant 4: a posted transaction cannot be modified', () => {
      const snapshot = (entryId: string) =>
        asOwner(async (tx) => ({
          entry: await findEntryById(tx, tenant.tenantId, entryId),
          lines: await findLinesByEntryId(tx, tenant.tenantId, entryId),
        }))

      const attempts: [string, (tx: TenantTx, entry: JournalEntryRow) => Promise<unknown>][] = [
        [
          'UPDATE narration',
          (tx, e) =>
            tx
              .updateTable('journal_entries')
              .set({ narration: 'edited' })
              .where('id', '=', e.id)
              .execute(),
        ],
        [
          'UPDATE occurred_at',
          (tx, e) =>
            tx
              .updateTable('journal_entries')
              .set({ occurred_at: '2026-09-01' })
              .where('id', '=', e.id)
              .execute(),
        ],
        [
          'UPDATE entry_number',
          (tx, e) =>
            tx
              .updateTable('journal_entries')
              .set({ entry_number: 'JV-2027-888888' })
              .where('id', '=', e.id)
              .execute(),
        ],
        [
          'REVERSED -> POSTED',
          (tx, e) =>
            tx
              .updateTable('journal_entries')
              .set({
                status: 'POSTED',
                reversed_by: null,
                reversed_at: null,
                version: e.version + 1,
              })
              .where('id', '=', e.id)
              .execute(),
        ],
        [
          'UPDATE a line amount',
          (tx, e) =>
            tx
              .updateTable('journal_lines')
              .set({ debit: '1.0000' })
              .where('entry_id', '=', e.id)
              .execute(),
        ],
        [
          'DELETE the lines',
          (tx, e) => tx.deleteFrom('journal_lines').where('entry_id', '=', e.id).execute(),
        ],
        [
          'DELETE the entry',
          (tx, e) => tx.deleteFrom('journal_entries').where('id', '=', e.id).execute(),
        ],
        [
          'append a balanced pair of lines',
          (tx, e) =>
            tx
              .insertInto('journal_lines')
              .values([
                bypassLine(e.id, 90, '6300', '5.0000', '0'),
                bypassLine(e.id, 91, '1110', '0', '5.0000'),
              ])
              .execute(),
        ],
      ]

      it.each(attempts)(
        'refuses: %s — and the entry is byte-identical afterwards',
        async (_label, attempt) => {
          // The REVERSED August voucher: it has already had its one permitted update.
          const before = await snapshot(augustVoucher.entry.id)
          const error = await rejectionOf(asOwner((tx) => attempt(tx, before.entry!)))
          expect(
            ['42501', '23514'],
            `sqlstate ${String(sqlstate(error))}: ${String(error)}`,
          ).toContain(sqlstate(error))
          expect(await snapshot(augustVoucher.entry.id)).toEqual(before)
        },
      )

      it('a POSTED entry cannot be marked REVERSED without a reversing entry', async () => {
        const capital = await asOwner(async (tx) => {
          const row = await tx
            .selectFrom('journal_entries')
            .select('id')
            .where('entry_number', '=', 'JV-2027-000001')
            .executeTakeFirstOrThrow()
          return findEntryById(tx, tenant.tenantId, row.id)
        })
        expect(capital!.status).toBe('POSTED')
        const error = await rejectionOf(
          asOwner((tx) =>
            tx
              .updateTable('journal_entries')
              .set({ status: 'REVERSED', version: capital!.version + 1 })
              .where('id', '=', capital!.id)
              .execute(),
          ),
        )
        expect(['23514', '42501']).toContain(sqlstate(error))
      })
    })

    describe('Invariant 5: a closed fiscal period cannot receive a posting', () => {
      it('the kernel refuses a CLOSED period, naming it and the current open period', async () => {
        const error = await rejectionOf(
          post(
            jv('inv-closed', '2026-08-31', [
              ['6400', 'debit', '1.0000'],
              ['1120', 'credit', '1.0000'],
            ]),
          ),
        )
        expect(codeOf(error)).toBe('PERIOD_CLOSED')
        expect((error as PostingError).details).toMatchObject({
          period: '2026-08',
          currentOpenPeriod: '2026-09',
        })
      })

      it('the kernel refuses a LOCKED period', async () => {
        const error = await rejectionOf(
          post(
            jv('inv-locked', '2026-07-15', [
              ['6400', 'debit', '1.0000'],
              ['1120', 'credit', '1.0000'],
            ]),
          ),
        )
        expect(codeOf(error)).toBe('PERIOD_LOCKED')
      })

      it('no actor without a user posts — there is no service account (rule 22)', async () => {
        const error = await rejectionOf(
          asTenantReader(tenant.tenantId, (tx) =>
            engine.post(
              jv('inv-job', '2026-09-10', [
                ['6400', 'debit', '1.0000'],
                ['1120', 'credit', '1.0000'],
              ]),
              tx,
            ),
          ),
        )
        expect(codeOf(error)).toBe('FORBIDDEN')
      })

      it('the database refuses a direct INSERT into a closed period — no bypass around the kernel', async () => {
        const august = await asOwner((tx) => findPeriodForDate(tx, tenant.tenantId, '2026-08-20'))
        expect(august!.status).toBe('CLOSED')
        const error = await rejectionOf(
          asOwner((tx) =>
            tx
              .insertInto('journal_entries')
              .values(bypassEntry(august!.id, '2026-08-20', 'JV-2027-999902', 'inv-bypass-closed'))
              .execute(),
          ),
        )
        expect(sqlstate(error)).toBe('23514')
      })

      it("a reversal is refused when today's own period is closed — never redirected", async () => {
        const other = await createTenantFixture('FIS5')
        const as = <T>(fn: (tx: TenantTx) => Promise<T>) =>
          runAs({ tenantId: other.tenantId, userId: other.ownerId }, () => withTenant(fn))
        const ids = new Map(
          (
            await as(async (tx) => {
              await seedChartOfAccounts(tx, other.tenantId)
              await createFiscalYear(tx, other.tenantId, 2027)
              return listAllAccounts(tx, other.tenantId)
            })
          ).map((account) => [account.code, account.id]),
        )
        const e = await as((tx) =>
          engine.post(
            jv(
              'inv5-e',
              '2026-08-05',
              [
                ['6300', 'debit', '10.0000'],
                ['1110', 'credit', '10.0000'],
              ],
              ids,
            ),
            tx,
          ),
        )
        for (const label of ['2026-07', '2026-08', '2026-09'])
          await as((tx) => periodEngine.close(label, tx))
        const error = await rejectionOf(
          as((tx) =>
            reversal.reverse({ entryId: e.entry.id, reason: 'late', idempotencyKey: 'inv5-r' }, tx),
          ),
        )
        expect(codeOf(error)).toBe('PERIOD_CLOSED')
        expect(await as((tx) => countJournalEntries(tx, other.tenantId))).toBe(1)
        expect((await as((tx) => findEntryById(tx, other.tenantId, e.entry.id)))!.status).toBe(
          'POSTED',
        )
      })
    })

    describe("Invariant 6: a reversal exactly neutralises the original's financial impact", () => {
      it('every reversal pair of every tenant nets to 0.0000 per account and per party', async () => {
        let pairs = 0
        for (const tenantId of await everyTenant()) {
          const offenders = await asTenantReader(tenantId, (tx) => reversalResiduals(tx, tenantId))
          expect(offenders, `tenant ${tenantId}: reversal residuals`).toEqual([])
          pairs += (
            await asTenantReader(tenantId, (tx) => entryNumbersInSeries(tx, tenantId, 'RV'))
          ).length
        }
        expect(pairs).toBeGreaterThanOrEqual(2)
      })

      it("open period: R takes E's date. Closed period: R takes today and discloses", async () => {
        const [sepR, augR] = await asOwner(async (tx) => {
          const sep = await findEntryById(tx, tenant.tenantId, septemberVoucher.entry.id)
          const aug = await findEntryById(tx, tenant.tenantId, augustVoucher.entry.id)
          return [
            await findEntryById(tx, tenant.tenantId, sep!.reversedBy!),
            await findEntryById(tx, tenant.tenantId, aug!.reversedBy!),
          ]
        })
        expect(sepR!.occurredAt).toBe('2026-09-03')
        expect(sepR!.narration).toBe('Reversal of JV-2027-000003: Duplicate')
        expect(augR!.occurredAt).toBe(TODAY)
        expect(augR!.narration).toBe('Reversal of JV-2027-000002 (2026-08, CLOSED): Wrong vendor')

        const [eLines, rLines] = await asOwner(async (tx) => [
          await findLinesByEntryId(tx, tenant.tenantId, augustVoucher.entry.id),
          await findLinesByEntryId(tx, tenant.tenantId, augR!.id),
        ])
        // E's own lines, same order, same account/control/party, sides swapped.
        expect(
          rLines.map((l) => [
            l.lineNumber,
            l.accountId,
            l.accountControl,
            l.partyId,
            l.debit,
            l.credit,
          ]),
        ).toEqual(
          eLines.map((l) => [
            l.lineNumber,
            l.accountId,
            l.accountControl,
            l.partyId,
            l.credit,
            l.debit,
          ]),
        )
      })

      it('a reversal cannot be reversed, and E cannot be reversed twice', async () => {
        const augR = await asOwner(
          async (tx) =>
            (await findEntryById(tx, tenant.tenantId, augustVoucher.entry.id))!.reversedBy!,
        )
        const rr = await rejectionOf(
          asOwner((tx) =>
            reversal.reverse({ entryId: augR, reason: 'undo', idempotencyKey: 'inv-rr' }, tx),
          ),
        )
        expect(codeOf(rr)).toBe('REVERSAL_OF_REVERSAL')
        const twice = await rejectionOf(
          asOwner((tx) =>
            reversal.reverse(
              { entryId: augustVoucher.entry.id, reason: 'again', idempotencyKey: 'inv-rev-aug-2' },
              tx,
            ),
          ),
        )
        expect(codeOf(twice)).toBe('ALREADY_REVERSED')
        // A replay of the original reversal request still returns R (§7).
        const replay = await asOwner((tx) =>
          reversal.reverse(
            {
              entryId: augustVoucher.entry.id,
              reason: 'Wrong vendor',
              idempotencyKey: 'inv-rev-aug',
            },
            tx,
          ),
        )
        expect(replay.outcome).toBe('REPLAYED')
        expect(replay.entry.id).toBe(augR)
      })
    })

    describe('Invariant 8: a duplicated API call cannot double-post', () => {
      it('three sequential identical requests: one entry, one number, one posting audit record', async () => {
        const command = jv('inv-dup-seq', '2026-09-11', [
          ['6300', 'debit', '1500.0000'],
          ['1120', 'credit', '1500.0000'],
        ])
        const entriesBefore = await asOwner((tx) => countJournalEntries(tx, tenant.tenantId))
        const auditBefore = await asOwner((tx) =>
          countAuditRecords(tx, tenant.tenantId, 'JOURNAL_ENTRY_POSTED'),
        )
        const results = [await post(command), await post(command), await post(command)]
        expect(results.map((r) => r.outcome)).toEqual(['POSTED', 'REPLAYED', 'REPLAYED'])
        expect(new Set(results.map((r) => r.entry.id)).size).toBe(1)
        expect(new Set(results.map((r) => r.documentNumber)).size).toBe(1)
        expect(await asOwner((tx) => countJournalEntries(tx, tenant.tenantId))).toBe(
          entriesBefore + 1,
        )
        expect(
          await asOwner((tx) => countAuditRecords(tx, tenant.tenantId, 'JOURNAL_ENTRY_POSTED')),
        ).toBe(auditBefore + 1)

        const reused = await rejectionOf(
          post({ ...command, payload: { ...(command.payload as object), narration: 'changed' } }),
        )
        expect(codeOf(reused)).toBe('IDEMPOTENCY_KEY_REUSED')
      })

      it('a genuinely concurrent duplicate replays, and consumes no number (no gap)', async () => {
        /*
         * Forced race. A posts and holds its transaction open; B (same key,
         * same request) starts, passes step 2 — A is not yet visible — and
         * blocks on the document counter row A holds. A commits; B takes the
         * next number, its INSERT ... ON CONFLICT DO NOTHING finds A's row,
         * and it rolls back to the numbering savepoint and replays A. The
         * draft this replaced caught 23505 and then queried the aborted
         * transaction, failing here with 25P02.
         */
        const command = jv('inv-dup-race', '2026-09-12', [
          ['6300', 'debit', '700.0000'],
          ['1120', 'credit', '700.0000'],
        ])
        const a = heldPosting(command)
        await a.posted
        const b = asOwner((tx) => engine.post(command, tx))
        await pause(400)
        a.release()
        const [ra, rb] = await Promise.all([a.done, b])

        expect(ra.outcome).toBe('POSTED')
        expect(rb.outcome).toBe('REPLAYED')
        expect(rb.entry.id).toBe(ra.entry.id)
        expect(
          await asOwner((tx) => countAuditRecords(tx, tenant.tenantId, 'JOURNAL_ENTRY_POSTED')),
        ).toBe(await asOwner((tx) => countJournalEntries(tx, tenant.tenantId)))

        // Gapless: the next voucher takes the very next number after A's.
        const next = await post(
          jv('inv-dup-next', '2026-09-12', [
            ['6300', 'debit', '1.0000'],
            ['1120', 'credit', '1.0000'],
          ]),
        )
        const seq = (n: string) => Number(n.split('-')[2])
        expect(seq(next.documentNumber)).toBe(seq(ra.documentNumber) + 1)
      })

      it('a concurrent request reusing the key with different content is refused', async () => {
        const command = jv('inv-dup-race-2', '2026-09-13', [
          ['6300', 'debit', '800.0000'],
          ['1120', 'credit', '800.0000'],
        ])
        const a = heldPosting(command)
        await a.posted
        const altered = {
          ...command,
          payload: { ...(command.payload as object), narration: 'different' },
        }
        const b = rejectionOf(asOwner((tx) => engine.post(altered, tx)))
        await pause(400)
        a.release()
        const [, error] = await Promise.all([a.done, b])
        expect(codeOf(error)).toBe('IDEMPOTENCY_KEY_REUSED')
      })
    })
  })
}
