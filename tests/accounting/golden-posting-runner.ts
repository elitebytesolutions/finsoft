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
  findLinesByEntryId,
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
import { periodEngine, type FinancialEventName } from '@finsoft/accounting-kernel'
// Clock injection is test-only: these are deliberately not on the package's public surface.
import { fixedClock } from '../../packages/accounting-kernel/src/clock.ts'
import {
  createPostingEngine,
  type PostResult,
} from '../../packages/accounting-kernel/src/posting-engine.ts'
import { createReversalEngine } from '../../packages/accounting-kernel/src/reversal.ts'
import { Money } from '@finsoft/validation'
import { controlAccountLedger, trialBalance } from '@finsoft/reporting'
import {
  accountMovement,
  countAuditRecords,
  countJournalEntries,
  entryNumbersInSeries,
  reversalPairResidualByAccount,
  reversalPairResidualByParty,
  reversalResiduals,
} from './golden-support.ts'
import { checkInvariant9, invariant9Available } from './ar-invariant-9.ts'
import type { ReceivablesPort } from './receivables-port.ts'
// modules/customers exists (M3-C, merged): the real, shipped use cases —
// each opens its own withTenant internally, so these are called under
// `runAs`, never inside `act`/`withTenant`.
import {
  createCustomer,
  deactivateCustomer,
  getCustomer,
  reactivateCustomer,
} from '../../modules/customers/index.ts'

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

/**
 * The steps this milestone can execute: all of a `milestone`-executable
 * scenario, or its `stepsExecutableFrom[milestone]` subset (P08: M2 steps
 * 1-5, M3 steps 6-9). Defaults to M2 — every existing M2 caller
 * (`posting-scenarios.spec.ts`, `golden-posting-registry.spec.ts`) is
 * unchanged by this parameter's addition.
 */
export function executableSteps(
  scenario: PostingScenario,
  milestone: 'M2' | 'M3' = 'M2',
): readonly Record<string, unknown>[] {
  const subset = scenario.stepsExecutableFrom?.[milestone]
  if (subset) return scenario.steps.filter((step) => subset.includes(step.step as number))
  if (scenario.executableFrom !== milestone) {
    throw new Error(
      `${scenario.id} is executable from ${scenario.executableFrom}, not ${milestone}.`,
    )
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

export interface RunPostingScenarioOptions {
  /**
   * Provides `SALE_POSTED` / `CUSTOMER_PAYMENT_RECEIVED` posting, document
   * lifecycle (drafts, reversal-by-document) and document-owned reads
   * (outstanding, status, numbers) through `modules/receivables`. Omitted
   * (the default) on every branch where that module does not exist — any
   * step needing it then throws a clear "no receivables port" error rather
   * than silently doing nothing, so a scenario wired in without one fails
   * loudly instead of passing vacuously.
   */
  readonly receivables?: ReceivablesPort
}

/** Runs the scenario's executable steps against the real kernel and database, asserting every figure. */
export async function runPostingScenario(
  scenario: PostingScenario,
  options: RunPostingScenarioOptions = {},
): Promise<void> {
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

  /*
   * P04–P12's `fixture.customers`: `{ ref, tenant, status }`. Registered
   * through the REAL `modules/customers` `createCustomer` use case — one
   * transaction, `registerParty` (ADR-0026) then the `customers` row — not
   * a bare `registerParty` call, because the `customer` verb (P12) needs a
   * real `customers` table row to deactivate/reactivate (getCustomer reads
   * that table, not `parties`). `fields` are throwaway; the golden files
   * assert no field of a customer's master data, only its id/status/AR
   * balance. `createCustomer` opens its own `withTenant` internally
   * (modules/customers's own rule — never called inside `act`).
   */
  const customerIdByRef = new Map<string, string>()
  for (const [index, raw] of (scenario.fixture.customers ?? []).entries()) {
    const entry = raw as { readonly ref: string; readonly tenant: string }
    const handle = byAlias.get(entry.tenant)
    if (!handle)
      throw new Error(
        `golden runner: customer "${entry.ref}" names unknown tenant "${entry.tenant}".`,
      )
    const { customer } = await runAs(
      { tenantId: handle.fixture.tenantId, userId: handle.fixture.ownerId },
      () =>
        createCustomer({
          fields: {
            name: `Golden fixture ${entry.ref}`,
            phone: null,
            email: null,
            address: null,
            city: null,
            ntn: null,
            creditDays: 0,
          },
          idempotencyKey: `golden-customer-${scenario.id}-${index}`,
          actor: { userId: handle.fixture.ownerId },
        }),
    )
    customerIdByRef.set(entry.ref, customer.id)
  }
  const customerId = (ref: string): string => {
    const found = customerIdByRef.get(ref)
    if (!found) throw new Error(`golden runner: unknown customer reference "${ref}".`)
    return found
  }
  const customerRefById = new Map<string, string>()
  for (const [ref, id] of customerIdByRef) customerRefById.set(id, ref)

  /** entryNumber (JE-.../RV-...) -> the document's own number (INV-.../RCT-...), for `customerLedger`'s `document` column. */
  const documentNumberByEntryNumber = new Map<string, string>()

  function requireReceivables(where: string): ReceivablesPort {
    if (!options.receivables) {
      throw new Error(
        `golden runner: ${where} needs modules/receivables (a ReceivablesPort), and none was ` +
          'provided. This scenario/step is not executable without it — it belongs in ' +
          'golden-posting-registry.ts PENDING, not in a spec that calls runPostingScenario ' +
          'unconditionally.',
      )
    }
    return options.receivables
  }

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

  /** debits before credits, then account code, then party ref — README §6's canonical order. */
  const canonicalLines = (
    lines: readonly { account: string; debit: string; credit: string; party?: string }[],
  ) =>
    [...lines].sort((a, b) => {
      const aDebit = Money.isZero(Money.from(a.debit)) ? 1 : 0
      const bDebit = Money.isZero(Money.from(b.debit)) ? 1 : 0
      return (
        aDebit - bDebit ||
        a.account.localeCompare(b.account) ||
        (a.party ?? '').localeCompare(b.party ?? '')
      )
    })
  /** A party_id (uuid) back to the fixture's customer ref (README §6: "the party id of fixture customer CUST-A"). */
  const partyRef = (partyId: string | null): string | undefined =>
    partyId === null ? undefined : customerRefById.get(partyId)
  const linesOf = (lines: readonly JournalLineRow[]) =>
    canonicalLines(
      lines.map((line) => {
        const party = partyRef(line.partyId)
        return {
          account: code(line.accountId),
          ...(party !== undefined ? { party } : {}),
          debit: line.debit,
          credit: line.credit,
        }
      }),
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

  /** A `PostingError`, or a duck-typed equivalent (`CustomerError` — modules/customers/domain/errors.ts — carries the same `.code`/`.details` shape but is a different class). */
  function isDomainError(
    error: unknown,
  ): error is { code: string; message: string; details: Record<string, unknown> } {
    return (
      error instanceof Error &&
      typeof (error as { code?: unknown }).code === 'string' &&
      typeof (error as { details?: unknown }).details === 'object' &&
      (error as { details?: unknown }).details !== null
    )
  }

  function checkRejection(where: string, error: unknown, exp: Expect): void {
    if (!isDomainError(error)) throw error
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
        canonicalLines(
          exp.lines as { account: string; debit: string; credit: string; party?: string }[],
        ),
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

  const DOCUMENT_EVENTS = new Set(['SALE_POSTED', 'CUSTOMER_PAYMENT_RECEIVED'])

  /** exp keys `checkPosted` does not know, specific to a module document. */
  const DOCUMENT_EXPECT_KEYS = [
    'documentNumber',
    'documentStatus',
    'allocations',
    'invoiceOutstanding',
    'inventoryMovementsWritten',
  ]

  /** Re-reads the entry `checkPosted` needs from `entryId`, so the SAME checks run for a module post as for a kernel one. */
  async function documentEntryAsPostResult(
    outcome: 'POSTED' | 'REPLAYED',
    documentNumber: string,
    entryId: string,
  ): Promise<PostResult> {
    const [entry, lines] = await act((tx) =>
      Promise.all([
        findEntryById(tx, tenantId, entryId),
        findLinesByEntryId(tx, tenantId, entryId),
      ]),
    )
    if (!entry)
      throw new Error(`golden runner: receivables port returned unknown entryId ${entryId}.`)
    return { outcome, journalEntryId: entry.id, documentNumber, entry, lines }
  }

  function checkDocumentExtras(
    where: string,
    documentRef: string,
    result: { documentNumber: string; documentStatus: string },
    exp: Expect,
  ): void {
    if (exp.documentNumber !== undefined)
      expect(result.documentNumber, `${where}: documentNumber`).toBe(exp.documentNumber)
    if (exp.documentStatus !== undefined) {
      /*
       * Two shapes, both written verbatim by golden files: a `post` step's
       * own expect.documentStatus is a bare string (the document just
       * posted). A `reverseDocument` step's is `{ ref: status }` (P06, P09)
       * — this lane does not know why the author chose that shape there and
       * not here, only that both are real, so both are checked.
       */
      const spec = exp.documentStatus
      const expected =
        typeof spec === 'string' ? spec : (spec as Record<string, string>)[documentRef]
      expect(result.documentStatus, `${where}: documentStatus`).toBe(expected)
    }
    if (exp.inventoryMovementsWritten !== undefined) {
      // MVP service-only invoices move no stock, ever (README §1 "Out").
      expect(exp.inventoryMovementsWritten, `${where}: inventoryMovementsWritten`).toBe(0)
    }
  }

  /*
   * Derived from the scenario itself, not from whether a receivables port
   * was passed: P11's `customer` verb (and R4 in golden-posting-runner-m3.
   * spec.ts) is `executableFrom: "M3"` but needs no port at all. P08 is the
   * one case with BOTH: `executableFrom: "M2"` overall, but
   * `stepsExecutableFrom.M3` names its invoice steps (6-9) — those only run
   * when a receivables port is actually given, matching golden-posting-
   * registry.ts's own PENDING/M3 entry for exactly that subset.
   */
  const runsAsM3 =
    scenario.executableFrom === 'M3' ||
    (options.receivables !== undefined && scenario.stepsExecutableFrom?.M3 !== undefined)
  const milestone: 'M2' | 'M3' = runsAsM3 ? 'M3' : 'M2'
  for (const step of executableSteps(scenario, milestone)) {
    const where = `${scenario.id} step ${String(step.step)}`
    const verb = step.do as string
    const isDocumentPost = verb === 'post' && DOCUMENT_EVENTS.has(step.event as string)

    if (isDocumentPost) {
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
        'error',
        'errorDetail',
        'entriesAfter',
        'auditRecordsWritten',
        ...DOCUMENT_EXPECT_KEYS,
      ])
      assertOnlyKnownKeys(where, step, [...STEP_INPUT_KEYS, 'referenceType', 'referenceId'])
      const auditBefore = await act((tx) => countAuditRecords(tx, tenantId))
      const port = requireReceivables(where)
      const documentRef = step.referenceId as string
      const rawPayload = step.payload as Record<string, unknown>

      try {
        const docResult =
          step.event === 'SALE_POSTED'
            ? await act((tx) =>
                port.postInvoice(tx, {
                  documentRef,
                  customerId: customerId(rawPayload.customer as string),
                  idempotencyKey: step.idempotencyKey as string,
                  occurredAt: step.occurredAt as string,
                  payload: rawPayload,
                }),
              )
            : await act((tx) =>
                port.postReceipt(tx, {
                  documentRef,
                  customerId: customerId(rawPayload.customer as string),
                  idempotencyKey: step.idempotencyKey as string,
                  occurredAt: step.occurredAt as string,
                  payload: rawPayload,
                }),
              )
        const result = await documentEntryAsPostResult(
          docResult.outcome,
          docResult.entryNumber,
          docResult.entryId,
        )
        await checkPosted(where, result, exp)
        checkDocumentExtras(where, documentRef, docResult, exp)
        documentNumberByEntryNumber.set(docResult.entryNumber, docResult.documentNumber)
      } catch (error) {
        checkRejection(where, error, exp)
      }

      if (typeof exp.auditRecordsWritten === 'number') {
        const auditAfter = await act((tx) => countAuditRecords(tx, tenantId))
        expect(auditAfter - auditBefore, `${where}: auditRecordsWritten`).toBe(
          exp.auditRecordsWritten,
        )
      }
      await checkAfterCounts(where, exp)
      continue
    }

    if (verb === 'reverseDocument') {
      const exp = step.expect as Expect
      assertOnlyKnownKeys(`${where}.expect`, exp, [
        'outcome',
        'entryNumber',
        'occurredAt',
        'period',
        'postingRule',
        'reversalOf',
        'lines',
        'totals',
        'originalAfter',
        'error',
        'errorDetail',
        'entriesAfter',
        ...DOCUMENT_EXPECT_KEYS,
      ])
      assertOnlyKnownKeys(where, step, [...STEP_INPUT_KEYS, 'document'])
      const port = requireReceivables(where)
      const documentRef = step.document as string

      try {
        const docResult = await act((tx) =>
          port.reverseDocument(tx, {
            documentRef,
            reason: step.reason as string,
            idempotencyKey: step.idempotencyKey as string,
          }),
        )
        const result = await documentEntryAsPostResult(
          docResult.outcome,
          docResult.entryNumber,
          docResult.entryId,
        )
        await checkPosted(where, result, exp)
        checkDocumentExtras(where, documentRef, docResult, exp)
        documentNumberByEntryNumber.set(docResult.entryNumber, docResult.documentNumber)
      } catch (error) {
        checkRejection(where, error, exp)
      }
      await checkAfterCounts(where, exp)
      continue
    }

    if (verb === 'saveDraft' || verb === 'editDraft' || verb === 'cancelDraft') {
      const exp = step.expect as Expect
      assertOnlyKnownKeys(`${where}.expect`, exp, [
        'outcome',
        'documentStatus',
        'documentNumber',
        'allocations',
        'journalEntriesWritten',
        'auditRecordsWritten',
        'entriesAfter',
        'error',
        'errorDetail',
      ])
      assertOnlyKnownKeys(where, step, [...STEP_INPUT_KEYS, 'documentType', 'document', 'fields'])
      const port = requireReceivables(where)
      const documentType = step.documentType as 'sales_invoice' | 'customer_receipt'
      const documentRef = step.document as string
      const entriesBefore = await act((tx) => countJournalEntries(tx, tenantId))

      try {
        const draft = await act((tx) => {
          if (verb === 'saveDraft') {
            const fields = step.fields as Record<string, unknown>
            return port.saveDraft(tx, {
              documentType,
              documentRef,
              customerId: customerId(fields.customer as string),
              fields,
            })
          }
          if (verb === 'editDraft') {
            return port.editDraft(tx, {
              documentType,
              documentRef,
              fields: step.fields as Record<string, unknown>,
            })
          }
          return port.cancelDraft(tx, {
            documentType,
            documentRef,
            reason: step.reason as string | undefined,
          })
        })
        if (exp.documentStatus !== undefined)
          expect(draft.documentStatus, `${where}: documentStatus`).toBe(exp.documentStatus)
        expect(draft.documentNumber, `${where}: a draft never carries a document number`).toBe(
          exp.documentNumber ?? null,
        )
        if (verb === 'cancelDraft') expect(exp.outcome, `${where}: outcome`).toBe('TRANSITIONED')
      } catch (error) {
        checkRejection(where, error, exp)
      }

      if (typeof exp.journalEntriesWritten === 'number') {
        const after = await act((tx) => countJournalEntries(tx, tenantId))
        expect(after - entriesBefore, `${where}: journalEntriesWritten`).toBe(
          exp.journalEntriesWritten,
        )
      }
      await checkAfterCounts(where, exp)
      continue
    }

    if (verb === 'customer') {
      const exp = step.expect as Expect
      assertOnlyKnownKeys(`${where}.expect`, exp, [
        'outcome',
        'customerStatus',
        'journalEntriesWritten',
        'entriesAfter',
        'error',
        'errorDetail',
      ])
      assertOnlyKnownKeys(where, step, [...STEP_INPUT_KEYS, 'customer'])
      /*
       * modules/customers ALREADY EXISTS (M3-C, merged) — this verb needs no
       * receivables port. deactivateCustomer/reactivateCustomer are the
       * real, shipped use cases, called exactly as the API controller calls
       * them (apps/api/src/customers/customers.controller.ts), including
       * their own business rules (CUSTOMER_HAS_BALANCE — P12 step 2, per
       * Accounting seat ruling 2, 2026-09-29) — a rejection here is
       * `CustomerError`, not `PostingError`; `checkRejection` handles both
       * (isDomainError, duck-typed on `.code`/`.details`).
       */
      const entriesBefore = await act((tx) => countJournalEntries(tx, tenantId))
      const id = customerId(step.customer as string)
      const asActingOwner = <T>(fn: () => Promise<T>): Promise<T> =>
        runAs({ tenantId: acting.fixture.tenantId, userId: acting.fixture.ownerId }, fn)

      const before = await asActingOwner(() => getCustomer(id))
      try {
        if (step.action === 'deactivate') {
          await asActingOwner(() =>
            deactivateCustomer({
              id,
              expectedVersion: before.customer.version,
              actor: { userId: acting.fixture.ownerId },
            }),
          )
        } else {
          await asActingOwner(() =>
            reactivateCustomer({
              id,
              expectedVersion: before.customer.version,
              actor: { userId: acting.fixture.ownerId },
            }),
          )
        }
        expect(exp.outcome, `${where}: outcome`).toBe('TRANSITIONED')
      } catch (error) {
        checkRejection(where, error, exp)
      }
      if (exp.customerStatus !== undefined) {
        // The `customer` verb's own expect.customerStatus is a bare string —
        // this step's own target, unlike the `assert` verb's
        // `customerStatus`, a { ref: status } map over possibly several
        // customers (P12 step 6).
        const after = await asActingOwner(() => getCustomer(id))
        expect(after.customer.status, `${where}: customerStatus`).toBe(exp.customerStatus)
      }
      if (typeof exp.journalEntriesWritten === 'number') {
        const after = await act((tx) => countJournalEntries(tx, tenantId))
        expect(after - entriesBefore, `${where}: journalEntriesWritten`).toBe(
          exp.journalEntriesWritten,
        )
      }
      await checkAfterCounts(where, exp)
      continue
    }

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
        'trialBalanceMidRange',
        'trialBalances',
        'periodMovement',
        'invariant6',
        'accountLedger',
        'customerLedger',
        'invoiceOutstanding',
        'invariant9',
        'documentStatuses',
        'documentNumbersIssued',
        'customerStatus',
        'entryStatuses',
        'journalEntryCount',
        'roundingAccountBalance',
        'suspenseAccountBalance',
        'periodStatus',
      ])
      if (step.trialBalance)
        await checkTrialBalance(`${where} trialBalance`, step.trialBalance as Expect)
      if (step.trialBalanceAfter)
        await checkTrialBalance(`${where} trialBalanceAfter`, step.trialBalanceAfter as Expect)
      if (step.trialBalanceMidRange)
        await checkTrialBalance(
          `${where} trialBalanceMidRange`,
          step.trialBalanceMidRange as Expect,
        )
      if (step.trialBalances) {
        for (const [i, tb] of (step.trialBalances as Expect[]).entries()) {
          await checkTrialBalance(`${where} trialBalances[${i}]`, tb)
        }
      }
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
        assertOnlyKnownKeys(`${where} invariant6`, spec, [
          'perAccountResidual',
          'perCustomerResidual',
          '$comment',
        ])
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
        if (spec.perCustomerResidual !== undefined) {
          const byId = await act((tx) => reversalPairResidualByParty(tx, tenantId))
          const byRef = Object.fromEntries(
            [...byId].map(([id, residual]) => [customerRefById.get(id) ?? id, residual]),
          )
          expect(byRef, `${where}: invariant6 per-customer residual map`).toEqual(
            spec.perCustomerResidual,
          )
        }
      }
      if (step.accountLedger) await checkAccountLedger(where, step.accountLedger as Expect)
      if (step.customerLedger) await checkCustomerLedger(where, step.customerLedger as Expect)
      if (step.invoiceOutstanding) {
        const port = requireReceivables(`${where}.invoiceOutstanding`)
        for (const [ref, expected] of Object.entries(
          step.invoiceOutstanding as Record<string, string>,
        )) {
          const actual = await act((tx) => port.invoiceOutstanding(tx, ref))
          expect(actual, `${where}: invoiceOutstanding.${ref}`).toBe(expected)
        }
      }
      if (step.invariant9) {
        const spec = step.invariant9 as {
          customer: string
          gl: string
          subledger: string
          difference: string
        }
        assertOnlyKnownKeys(`${where} invariant9`, spec, [
          'customer',
          'gl',
          'subledger',
          'difference',
        ])
        const available = await act((tx) => invariant9Available(tx))
        if (!available) {
          throw new Error(
            `${where}: invariant9 asserted but sales_invoices/customer_receipts do not exist ` +
              'yet, or SALE_POSTED/CUSTOMER_PAYMENT_RECEIVED are not IMPLEMENTED_EVENTS. This ' +
              "step's scenario belongs in golden-posting-registry.ts PENDING.",
          )
        }
        const asOf = scenario.fixture.today
        const id = customerId(spec.customer)
        const result = await act((tx) => checkInvariant9(tx, tenantId, asOf))
        const row = result.rows.find((r) => r.customerId === id) ?? {
          customerId: id,
          gl: '0.0000',
          sub: '0.0000',
          difference: '0.0000',
        }
        expect(
          { customer: spec.customer, gl: row.gl, subledger: row.sub, difference: row.difference },
          `${where}: invariant9`,
        ).toEqual(spec)
      }
      if (step.documentStatuses) {
        const port = requireReceivables(`${where}.documentStatuses`)
        for (const [ref, expected] of Object.entries(
          step.documentStatuses as Record<string, string>,
        )) {
          const documentType = ref.startsWith('INV') ? 'sales_invoice' : 'customer_receipt'
          const actual = await act((tx) => port.documentStatus(tx, documentType, ref))
          expect(actual, `${where}: documentStatuses.${ref}`).toBe(expected)
        }
      }
      if (step.documentNumbersIssued) {
        const spec = step.documentNumbersIssued as Record<string, readonly string[]>
        for (const [series, expected] of Object.entries(spec)) {
          const actual =
            series === 'INV' || series === 'RCT'
              ? await act((tx) =>
                  requireReceivables(`${where}.documentNumbersIssued`).documentNumbersIssued(
                    tx,
                    series,
                  ),
                )
              : await act((tx) => entryNumbersInSeries(tx, tenantId, series))
          expect([...actual], `${where}: documentNumbersIssued.${series}`).toEqual([...expected])
        }
      }
      if (step.customerStatus) {
        for (const [ref, expected] of Object.entries(
          step.customerStatus as Record<string, string>,
        )) {
          const id = customerId(ref)
          const current = await runAs(
            { tenantId: acting.fixture.tenantId, userId: acting.fixture.ownerId },
            () => getCustomer(id),
          )
          expect(current.customer.status, `${where}: customerStatus.${ref}`).toBe(expected)
        }
      }
      if (step.entryStatuses) {
        for (const [entryNumber, expected] of Object.entries(
          step.entryStatuses as Record<string, string>,
        )) {
          const id = entryIdByNumber.get(entryNumber)
          if (!id) throw new Error(`${where}: entryStatuses names unknown entry "${entryNumber}".`)
          const entry = await act((tx) => findEntryById(tx, tenantId, id))
          expect(entry?.status, `${where}: entryStatuses.${entryNumber}`).toBe(expected)
        }
      }
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

  /**
   * The customer ledger — K5's `controlAccountLedger`, AR_CONTROL filtered
   * to one customer party (ledger-and-trial-balance.md §2: "not a separate
   * store"). The `document` column (`INV-…` / `RCT-…`) is not a K5 field —
   * K4 (the entry's own `referenceNumber`) is an M3-P kernel addition
   * (README §4) — so it is resolved from `documentNumberByEntryNumber`,
   * populated as THIS RUN posts and reverses documents. That is sound for a
   * run that posts everything itself (every golden scenario does), and
   * would be wrong for a ledger read against pre-existing data — which is
   * exactly the gap K4 exists to close, left here as a comment rather than
   * silently worked around.
   */
  async function checkCustomerLedger(where: string, spec: Expect): Promise<void> {
    assertOnlyKnownKeys(`${where} customerLedger`, spec, [
      'customer',
      'from',
      'to',
      'openingBalance',
      'lines',
      'closingBalance',
    ])
    const id = customerId(spec.customer as string)
    const result = await act((tx) =>
      controlAccountLedger(tx, tenantId, 'AR', id, {
        from: spec.from as string,
        to: spec.to as string,
        limit: 500,
        after: null,
      }),
    )
    expect(result.next, `${where}: customer ledger fits one page`).toBeNull()
    expect(result.openingBalance, `${where}: customer ledger opening`).toBe(spec.openingBalance)
    const actual = result.lines.map((line) => {
      const document = documentNumberByEntryNumber.get(line.entryNumber)
      if (!document) {
        throw new Error(
          `${where}: no document number recorded for entry ${line.entryNumber} — every ` +
            'customerLedger line in a golden file is a document posted or reversed earlier ' +
            'in the SAME run.',
        )
      }
      return {
        entryNumber: line.entryNumber,
        document,
        date: line.occurredAt,
        debit: line.debit,
        credit: line.credit,
        runningBalance: line.runningBalance,
      }
    })
    expect(actual, `${where}: customer ledger lines`).toEqual(spec.lines)
    expect(result.closingBalance, `${where}: customer ledger closing`).toBe(spec.closingBalance)
  }
}
