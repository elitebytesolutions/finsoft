import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import {
  createTenantFixture,
  REPO_ROOT,
  runAs,
  type TenantFixture,
} from '@finsoft/database/testing'
import {
  accountLedgerLines,
  accountOpeningBalance,
  findEntryById,
  findPeriodById,
  findPeriodForDate,
  listAllAccounts,
  resolveAccountsByRole,
  withTenant,
  type AccountRow,
  type JournalLineRow,
  type TenantTx,
} from '@finsoft/database'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import { periodEngine, PostingError, type FinancialEventName } from '@finsoft/accounting-kernel'
// Clock injection is test-only: these are deliberately not on the package's public surface.
import { fixedClock } from '../../packages/accounting-kernel/src/clock.ts'
import {
  createPostingEngine,
  type PostResult,
} from '../../packages/accounting-kernel/src/posting-engine.ts'
import { createReversalEngine } from '../../packages/accounting-kernel/src/reversal.ts'
import { Money } from '@finsoft/validation'
import { trialBalance } from '@finsoft/reporting'
import {
  accountMovement,
  countAuditRecords,
  countJournalEntries,
  reversalPairResidualByAccount,
  reversalResiduals,
} from './golden-support.ts'

/*
 * The posting-scenario/v1 runner. docs/posting-rules/README.md §6.
 *
 * STRICT BY CONSTRUCTION. Every key of every step's `expect` (and of every
 * `assert` step) must be one this runner checks; an unrecognised key throws
 * rather than passing silently. A runner that skips an expectation it does
 * not understand turns a golden file into a comment — the previous draft did
 * exactly that with `errorDetail` (it compared only keys the error happened
 * to carry) and never compared `outcome` against the kernel's own outcome.
 *
 * Every figure is compared as an exact string at storage scale. No tolerance.
 *
 * Each step runs in its OWN transaction, as the golden files require ("every
 * step runs in its own transaction"). A rejected step's transaction rolls
 * back, so `entriesAfter` proves the rejection left no trace.
 */

const GOLDEN_DIR = join(REPO_ROOT, 'tests', 'accounting', 'golden')

export interface PostingScenario {
  readonly id: string
  readonly executableFrom: string
  readonly stepsExecutableFrom?: Readonly<Record<string, readonly number[]>>
  readonly fixture: {
    readonly today: string
    readonly timezone: string
    readonly periods: { readonly fiscalYear: number }
    readonly tenants: readonly string[]
    readonly actingTenant?: string
    readonly customers?: readonly unknown[]
  }
  readonly steps: readonly Record<string, unknown>[]
}

export function loadScenario(filename: string): PostingScenario {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, filename), 'utf8')) as PostingScenario
}

/** The steps this milestone can execute: all of an M2 scenario, or its stepsExecutableFrom.M2 subset. */
export function executableSteps(scenario: PostingScenario): readonly Record<string, unknown>[] {
  const subset = scenario.stepsExecutableFrom?.M2
  if (subset) return scenario.steps.filter((step) => subset.includes(step.step as number))
  if (scenario.executableFrom !== 'M2') {
    throw new Error(`${scenario.id} is executable from ${scenario.executableFrom}, not M2.`)
  }
  return scenario.steps
}

interface TenantHandle {
  readonly fixture: TenantFixture
  readonly accountsByCode: ReadonlyMap<string, AccountRow>
  readonly codeById: ReadonlyMap<string, string>
}

type Expect = Record<string, unknown>

/** Keys of a step that are its INPUT, not an expectation. */
const STEP_INPUT_KEYS = new Set([
  'step',
  'do',
  '$comment',
  'event',
  'idempotencyKey',
  'occurredAt',
  'payload',
  'entry',
  'reason',
  'action',
  'period',
  'expect',
])

function assertOnlyKnownKeys(
  where: string,
  record: Record<string, unknown>,
  known: readonly string[],
): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `golden runner: ${where} carries expectation(s) this runner does not check: ${unknown.join(', ')}.`,
    )
  }
}

function periodBounds(label: string): { from: string; to: string } {
  const [year, month] = label.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${label}-01`, to: `${label}-${String(last).padStart(2, '0')}` }
}

/** A signed net (debit − credit) presented the trial-balance way: one side carries it. */
function presentNet(debit: string, credit: string): { debit: string; credit: string } {
  const net = Money.subtract(Money.from(debit), Money.from(credit))
  return Money.isNegative(net)
    ? { debit: '0.0000', credit: Money.serialize(Money.negate(net), 4) }
    : { debit: Money.serialize(net, 4), credit: '0.0000' }
}

function totalsOf(rows: readonly { debit: string; credit: string }[]): {
  debit: string
  credit: string
} {
  return {
    debit: Money.serialize(Money.sum(rows.map((row) => Money.from(row.debit))), 4),
    credit: Money.serialize(Money.sum(rows.map((row) => Money.from(row.credit))), 4),
  }
}

async function setUpTenants(scenario: PostingScenario): Promise<Map<string, TenantHandle>> {
  const byAlias = new Map<string, TenantHandle>()
  for (const alias of scenario.fixture.tenants) {
    const fixture = await createTenantFixture(alias)
    const accounts = await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
      withTenant(async (tx) => {
        await seedChartOfAccounts(tx, fixture.tenantId)
        await createFiscalYear(tx, fixture.tenantId, scenario.fixture.periods.fiscalYear)
        return listAllAccounts(tx, fixture.tenantId)
      }),
    )
    byAlias.set(alias, {
      fixture,
      accountsByCode: new Map(accounts.map((account) => [account.code, account])),
      codeById: new Map(accounts.map((account) => [account.id, account.code])),
    })
  }
  return byAlias
}

/** Runs the scenario's M2-executable steps against the real kernel and database, asserting every figure. */
export async function runPostingScenario(scenario: PostingScenario): Promise<void> {
  const byAlias = await setUpTenants(scenario)
  const acting = byAlias.get(scenario.fixture.actingTenant ?? scenario.fixture.tenants[0]!)!
  const tenantId = acting.fixture.tenantId

  // The fixture's `today`, at noon UTC — 17:00 in Asia/Karachi, the same calendar day.
  const clock = fixedClock(`${scenario.fixture.today}T12:00:00.000Z`)
  const engine = createPostingEngine(clock)
  const reversal = createReversalEngine(clock)

  const entryIdByNumber = new Map<string, string>()
  // journal-voucher.md §2: referenceId is generated once per voucher and reused
  // on every retry of the same submission (same key -> same referenceId).
  const referenceIdByKey = new Map<string, string>()
  const referenceIdFor = (key: string): string => {
    if (!referenceIdByKey.has(key)) referenceIdByKey.set(key, randomUUID())
    return referenceIdByKey.get(key)!
  }

  const inTenant = <T>(handle: TenantHandle, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    runAs({ tenantId: handle.fixture.tenantId, userId: handle.fixture.ownerId }, () =>
      withTenant(fn),
    )
  const act = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => inTenant(acting, fn)

  const accountId = (ref: string): string => {
    const [alias, code] = ref.includes(':') ? (ref.split(':') as [string, string]) : [null, ref]
    const handle = alias === null ? acting : byAlias.get(alias)
    const account = handle?.accountsByCode.get(code)
    if (!account) throw new Error(`golden runner: unknown account reference "${ref}".`)
    return account.id
  }
  const code = (id: string): string => {
    const found = acting.codeById.get(id)
    if (!found) throw new Error(`golden runner: account id ${id} is not the acting tenant's.`)
    return found
  }

  /** debits before credits, then account code — README §6's canonical order. */
  const canonicalLines = (lines: readonly { account: string; debit: string; credit: string }[]) =>
    [...lines].sort((a, b) => {
      const aDebit = Money.isZero(Money.from(a.debit)) ? 1 : 0
      const bDebit = Money.isZero(Money.from(b.debit)) ? 1 : 0
      return aDebit - bDebit || a.account.localeCompare(b.account)
    })
  const linesOf = (lines: readonly JournalLineRow[]) =>
    canonicalLines(
      lines.map((line) => ({
        account: code(line.accountId),
        debit: line.debit,
        credit: line.credit,
      })),
    )

  /*
   * The SHIPPED report, not a parallel computation: @finsoft/reporting's
   * trialBalance() — its rows, its column presentation, its totals — is what
   * is compared with the hand-computed figures (T3 Council, Acct F5/R5). A
   * runner that re-derived the trial balance itself would prove only that two
   * implementations agree, not that the one users see is right.
   */
  async function checkTrialBalance(label: string, tb: Record<string, unknown>): Promise<void> {
    assertOnlyKnownKeys(label, tb, ['asOf', 'rows', 'totals'])
    const report = await act((tx) => trialBalance(tx, tenantId, tb.asOf as string))
    expect(report.asOf, `${label} asOf`).toBe(tb.asOf)
    const actual = report.lines
      .map((line) => ({ account: line.code, debit: line.debit, credit: line.credit }))
      .sort((a, b) => a.account.localeCompare(b.account))
    const expected = [...(tb.rows as { account: string }[])].sort((a, b) =>
      a.account.localeCompare(b.account),
    )
    expect(actual, `${label} rows as of ${String(tb.asOf)}`).toEqual(expected)
    expect({ debit: report.totalDebit, credit: report.totalCredit }, `${label} totals`).toEqual(
      tb.totals,
    )
    // Invariant 2, on every trial balance a golden file names — the report's own totals.
    expect(report.totalDebit, `${label}: Invariant 2`).toBe(report.totalCredit)
  }

  async function checkAfterCounts(where: string, exp: Expect): Promise<void> {
    if (typeof exp.entriesAfter === 'number') {
      expect(await act((tx) => countJournalEntries(tx, tenantId)), `${where}: entriesAfter`).toBe(
        exp.entriesAfter,
      )
    }
    if (exp.entriesAfterInTenant) {
      for (const [alias, count] of Object.entries(
        exp.entriesAfterInTenant as Record<string, number>,
      )) {
        const handle = byAlias.get(alias)!
        expect(
          await inTenant(handle, (tx) => countJournalEntries(tx, handle.fixture.tenantId)),
          `${where}: entriesAfterInTenant.${alias}`,
        ).toBe(count)
      }
    }
    if (typeof exp.postingAuditRecordsAfter === 'number') {
      expect(
        await act((tx) => countAuditRecords(tx, tenantId, 'JOURNAL_ENTRY_POSTED')),
        `${where}: postingAuditRecordsAfter`,
      ).toBe(exp.postingAuditRecordsAfter)
    }
  }

  function checkRejection(where: string, error: unknown, exp: Expect): void {
    if (!(error instanceof PostingError)) throw error
    expect(exp.outcome, `${where}: the kernel rejected (${error.code}: ${error.message})`).toBe(
      'REJECTED',
    )
    expect(error.code, `${where}: error code`).toBe(exp.error)
    if (exp.errorDetail) {
      for (const [key, value] of Object.entries(exp.errorDetail as Record<string, unknown>)) {
        expect(key in error.details, `${where}: error carries detail "${key}"`).toBe(true)
        expect(error.details[key], `${where}: errorDetail.${key}`).toEqual(value)
      }
    }
  }

  async function checkPosted(where: string, result: PostResult, exp: Expect): Promise<void> {
    expect(result.outcome, `${where}: outcome`).toBe(exp.outcome)
    entryIdByNumber.set(result.entry.entryNumber, result.entry.id)
    expect(result.documentNumber).toBe(result.entry.entryNumber)
    if (exp.entryNumber !== undefined)
      expect(result.entry.entryNumber, `${where}: entryNumber`).toBe(exp.entryNumber)
    if (exp.postingRule !== undefined)
      expect(result.entry.postingRule, `${where}: postingRule`).toBe(exp.postingRule)
    if (exp.status !== undefined) expect(result.entry.status, `${where}: status`).toBe(exp.status)
    if (exp.occurredAt !== undefined)
      expect(result.entry.occurredAt, `${where}: occurredAt`).toBe(exp.occurredAt)
    if (exp.period !== undefined) {
      const period = await act((tx) => findPeriodById(tx, tenantId, result.entry.fiscalPeriodId))
      expect(period?.label, `${where}: period`).toBe(exp.period)
    }
    if (exp.lines !== undefined) {
      expect(linesOf(result.lines), `${where}: lines`).toEqual(
        canonicalLines(exp.lines as { account: string; debit: string; credit: string }[]),
      )
    }
    if (exp.totals !== undefined)
      expect(totalsOf(result.lines), `${where}: totals`).toEqual(exp.totals)
    if (exp.reversalOf !== undefined) {
      const original = await act((tx) => findEntryById(tx, tenantId, result.entry.reversalOf ?? ''))
      expect(original?.entryNumber, `${where}: reversalOf`).toBe(exp.reversalOf)
    }
    if (exp.originalAfter !== undefined) {
      const spec = exp.originalAfter as Record<string, string>
      assertOnlyKnownKeys(`${where}.originalAfter`, spec, ['entry', 'status', 'reversedBy'])
      const original = await act((tx) =>
        findEntryById(tx, tenantId, entryIdByNumber.get(spec.entry!)!),
      )
      expect(original?.status, `${where}: originalAfter.status`).toBe(spec.status)
      const reversedBy = await act((tx) => findEntryById(tx, tenantId, original?.reversedBy ?? ''))
      expect(reversedBy?.entryNumber, `${where}: originalAfter.reversedBy`).toBe(spec.reversedBy)
    }
  }

  for (const step of executableSteps(scenario)) {
    const where = `${scenario.id} step ${String(step.step)}`
    const verb = step.do as string

    if (verb === 'post' || verb === 'reverse') {
      const exp = step.expect as Expect
      assertOnlyKnownKeys(`${where}.expect`, exp, [
        'outcome',
        'entryNumber',
        'period',
        'postingRule',
        'status',
        'lines',
        'totals',
        'occurredAt',
        'reversalOf',
        'disclosure',
        'originalAfter',
        'error',
        'errorDetail',
        'entriesAfter',
        'entriesAfterInTenant',
        'auditRecordsWritten',
        'postingAuditRecordsAfter',
      ])
      assertOnlyKnownKeys(where, step, [...STEP_INPUT_KEYS])
      const auditBefore = await act((tx) => countAuditRecords(tx, tenantId))

      try {
        if (verb === 'post') {
          const raw = step.payload as Record<string, unknown>
          const payload = {
            ...raw,
            lines: (raw.lines as Record<string, unknown>[]).map((line) => {
              const { account, ...rest } = line
              return { accountId: accountId(account as string), ...rest }
            }),
          }
          const result = await act((tx) =>
            engine.post(
              {
                event: step.event as FinancialEventName,
                referenceType: 'journal_voucher',
                referenceId: referenceIdFor(step.idempotencyKey as string),
                occurredAt: step.occurredAt as string,
                idempotencyKey: step.idempotencyKey as string,
                payload,
              },
              tx,
            ),
          )
          expect(exp.disclosure, `${where}: a post carries no disclosure`).toBeUndefined()
          await checkPosted(where, result, exp)
        } else {
          const entryId = entryIdByNumber.get(step.entry as string)
          if (!entryId) throw new Error(`${where}: unknown entry "${String(step.entry)}".`)
          const result = await act((tx) =>
            reversal.reverse(
              {
                entryId,
                reason: step.reason as string,
                idempotencyKey: step.idempotencyKey as string,
              },
              tx,
            ),
          )
          await checkPosted(where, result, exp)
          if (exp.disclosure !== undefined) {
            expect(result.disclosure, `${where}: disclosure`).toEqual(exp.disclosure)
            const d = exp.disclosure as { originalPeriod: string; originalPeriodStatus: string }
            // reversal.md §4: the disclosure is IN the entry, not only in the API result.
            expect(result.entry.narration, `${where}: disclosed narration`).toContain(
              `(${d.originalPeriod}, ${d.originalPeriodStatus})`,
            )
          }
        }
      } catch (error) {
        checkRejection(where, error, exp)
      }

      if (typeof exp.auditRecordsWritten === 'number') {
        const auditAfter = await act((tx) => countAuditRecords(tx, tenantId))
        expect(auditAfter - auditBefore, `${where}: auditRecordsWritten`).toBe(
          exp.auditRecordsWritten,
        )
      }
      if (exp.outcome === 'REJECTED') {
        // A rejection writes no audit record of a posting (README §4).
        expect(
          await act((tx) => countAuditRecords(tx, tenantId)),
          `${where}: no audit on rejection`,
        ).toBe(auditBefore)
      }
      await checkAfterCounts(where, exp)
      continue
    }

    if (verb === 'period') {
      const exp = step.expect as Expect
      assertOnlyKnownKeys(`${where}.expect`, exp, [
        'outcome',
        'error',
        'periodStatus',
        'journalEntriesWritten',
        'auditRecordsWritten',
      ])
      assertOnlyKnownKeys(where, step, [...STEP_INPUT_KEYS])
      const entriesBefore = await act((tx) => countJournalEntries(tx, tenantId))
      const auditBefore = await act((tx) => countAuditRecords(tx, tenantId))
      const label = step.period as string
      try {
        await act((tx) =>
          step.action === 'close'
            ? periodEngine.close(label, tx)
            : step.action === 'lock'
              ? periodEngine.lock(label, tx)
              : periodEngine.reopen(label, step.reason as string, tx),
        )
        expect(exp.outcome, `${where}: outcome`).toBe('TRANSITIONED')
      } catch (error) {
        checkRejection(where, error, exp)
      }
      if (exp.periodStatus)
        await checkPeriodStatus(where, exp.periodStatus as Record<string, string>)
      if (typeof exp.journalEntriesWritten === 'number') {
        const after = await act((tx) => countJournalEntries(tx, tenantId))
        expect(after - entriesBefore, `${where}: journalEntriesWritten`).toBe(
          exp.journalEntriesWritten,
        )
      }
      const auditAfter = await act((tx) => countAuditRecords(tx, tenantId))
      if (typeof exp.auditRecordsWritten === 'number') {
        expect(auditAfter - auditBefore, `${where}: auditRecordsWritten`).toBe(
          exp.auditRecordsWritten,
        )
      }
      if (exp.outcome === 'REJECTED')
        expect(auditAfter, `${where}: no audit on rejection`).toBe(auditBefore)
      continue
    }

    if (verb === 'assert') {
      assertOnlyKnownKeys(where, step, [
        'step',
        'do',
        '$comment',
        'trialBalance',
        'trialBalanceAfter',
        'periodMovement',
        'invariant6',
        'accountLedger',
        'journalEntryCount',
        'roundingAccountBalance',
        'suspenseAccountBalance',
        'periodStatus',
      ])
      if (step.trialBalance)
        await checkTrialBalance(`${where} trialBalance`, step.trialBalance as Expect)
      if (step.trialBalanceAfter)
        await checkTrialBalance(`${where} trialBalanceAfter`, step.trialBalanceAfter as Expect)
      if (step.periodMovement) {
        for (const [label, spec] of Object.entries(step.periodMovement as Record<string, Expect>)) {
          assertOnlyKnownKeys(`${where} periodMovement.${label}`, spec, ['rows', 'totals'])
          const { from, to } = periodBounds(label)
          const rows = await act((tx) => accountMovement(tx, tenantId, from, to))
          const actual = rows.map((row) => ({
            account: row.code,
            ...presentNet(row.debit, row.credit),
          }))
          expect(actual, `${where}: movement ${label}`).toEqual(
            [...(spec.rows as { account: string }[])].sort((a, b) =>
              a.account.localeCompare(b.account),
            ),
          )
          expect(totalsOf(actual), `${where}: movement ${label} totals`).toEqual(spec.totals)
        }
      }
      if (step.invariant6) {
        const spec = step.invariant6 as Expect
        assertOnlyKnownKeys(`${where} invariant6`, spec, ['perAccountResidual'])
        // The WHOLE map (T3 Council, Acct F5/R5): every account any reversal
        // pair touches must appear in the golden file with its residual, and
        // nothing the golden file names may be missing. Comparing only the
        // keys the file lists would let a non-zero residual on an account the
        // author did not think of pass silently.
        const residuals = await act((tx) => reversalPairResidualByAccount(tx, tenantId))
        expect(
          Object.fromEntries([...residuals].sort(([a], [b]) => a.localeCompare(b))),
          `${where}: invariant6 per-account residual map`,
        ).toEqual(spec.perAccountResidual)
        // And finer than the file states: per reversal pair, per account, per
        // party, plus pair shape. Empty = every residual is exactly zero.
        expect(
          await act((tx) => reversalResiduals(tx, tenantId)),
          `${where}: invariant6 per (pair, account, party)`,
        ).toEqual([])
      }
      if (step.accountLedger) await checkAccountLedger(where, step.accountLedger as Expect)
      if (typeof step.journalEntryCount === 'number') {
        expect(
          await act((tx) => countJournalEntries(tx, tenantId)),
          `${where}: journalEntryCount`,
        ).toBe(step.journalEntryCount)
      }
      if (typeof step.roundingAccountBalance === 'string') {
        expect(await roleBalance('ROUNDING'), `${where}: rounding account`).toBe(
          step.roundingAccountBalance,
        )
      }
      if (typeof step.suspenseAccountBalance === 'string') {
        expect(await roleBalance('SUSPENSE'), `${where}: suspense account`).toBe(
          step.suspenseAccountBalance,
        )
      }
      if (step.periodStatus)
        await checkPeriodStatus(where, step.periodStatus as Record<string, string>)
      continue
    }

    throw new Error(`golden runner: unrecognised verb "${verb}" (${where}).`)
  }

  async function checkPeriodStatus(where: string, expected: Record<string, string>): Promise<void> {
    for (const [label, status] of Object.entries(expected)) {
      const period = await act((tx) => findPeriodForDate(tx, tenantId, `${label}-01`))
      expect(period?.status, `${where}: period ${label}`).toBe(status)
    }
  }

  /** A role account's signed balance (debit-positive), read from the shipped trial balance. */
  async function roleBalance(role: string): Promise<string> {
    return act(async (tx) => {
      const account = (await resolveAccountsByRole(tx, tenantId, [role])).get(role)
      if (!account) throw new Error(`golden runner: role ${role} does not resolve.`)
      const line = (await trialBalance(tx, tenantId, '9999-12-31')).lines.find(
        (l) => l.accountId === account.id,
      )
      return line
        ? Money.serialize(Money.subtract(Money.from(line.debit), Money.from(line.credit)), 4)
        : '0.0000'
    })
  }

  async function checkAccountLedger(where: string, spec: Expect): Promise<void> {
    assertOnlyKnownKeys(`${where} accountLedger`, spec, [
      'account',
      'from',
      'to',
      'openingBalance',
      'lines',
      'closingBalance',
    ])
    const id = accountId(spec.account as string)
    const { opening, page } = await act(async (tx) => ({
      opening: await accountOpeningBalance(tx, tenantId, id, spec.from as string, null),
      page: await accountLedgerLines(
        tx,
        tenantId,
        id,
        spec.from as string,
        spec.to as string,
        null,
        {
          limit: 500,
          after: null,
        },
      ),
    }))
    // Running balance: signed, debit-positive (README §6), computed here with Money.
    let running = Money.subtract(Money.from(opening.debit), Money.from(opening.credit))
    expect(Money.serialize(running, 4), `${where}: ledger opening`).toBe(spec.openingBalance)
    expect(page.next, `${where}: ledger fits one page`).toBeNull()
    const actual = page.rows.map((line) => {
      running = Money.add(running, Money.subtract(Money.from(line.debit), Money.from(line.credit)))
      return {
        entryNumber: line.entryNumber,
        date: line.occurredAt,
        debit: line.debit,
        credit: line.credit,
        runningBalance: Money.serialize(running, 4),
      }
    })
    expect(actual, `${where}: ledger lines`).toEqual(spec.lines)
    expect(Money.serialize(running, 4), `${where}: ledger closing`).toBe(spec.closingBalance)
  }
}
