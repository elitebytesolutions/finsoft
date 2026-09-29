import { Money } from '@finsoft/validation'
import {
  assertIssuedTenantTx,
  assignDocumentNumber,
  computeRequestFingerprint,
  findEntryById,
  findEntryByIdempotencyKey,
  findEntryBySource,
  findLinesByEntryId,
  findPeriodForDate,
  findTenantTimezone,
  recordAudit,
  TenantContext,
  type AuditEventInput,
  type FiscalPeriodRow,
  type JournalEntryRow,
  type JournalLineRow,
  type NewJournalLine,
  type TenantTx,
} from '@finsoft/database'
import { systemClock, type Clock } from './clock.ts'
import { isIsoCalendarDate, todayInTimezone } from './dates.ts'
import { KernelInvariantError, PostingError } from './errors.ts'
import { FinancialEvent, IMPLEMENTED_EVENTS, type FinancialEventName } from './events.ts'
import {
  insertJournalEntryIfAbsent,
  insertJournalLines,
  openNumberingSavepoint,
  releaseNumberingSavepoint,
  rollbackNumberingSavepoint,
} from './queries/journal-writes.ts'
import { findPeriodSummaryForDate } from './queries/periods.ts'
import {
  buildCustomerReceiptEntry,
  CUSTOMER_RECEIPT_RULE_ID,
  RECEIPT_SERIES,
  RECEIPT_SOURCE_TYPE,
  validateCustomerReceiptPayload,
} from './rules/customer-receipt.ts'
import {
  buildJournalVoucherEntry,
  JOURNAL_VOUCHER_RULE_ID,
  JOURNAL_VOUCHER_SERIES,
  JOURNAL_VOUCHER_SOURCE_TYPE,
  validateJournalVoucherPayload,
} from './rules/journal-voucher.ts'
import { isUuid } from './rules/shared.ts'
import {
  buildServiceSaleEntry,
  SALE_SERIES,
  SALE_SOURCE_TYPE,
  SERVICE_SALE_RULE_ID,
  validateServiceSalePayload,
} from './rules/service-sale.ts'

/*
 * postingEngine.post — the single implementation of ADR-0005's pipeline.
 *
 *   1  validate command shape                          (rule validators, below)
 *   2  idempotency: prior result by key, or by source  (lookUpPriorRequest)
 *   3  resolve the fiscal period from occurredAt; reject unless OPEN
 *   4  load the posting rule for the event
 *   5  resolve accounts (roles, or the JV's explicit ids) and parties
 *   6  build journal lines; MVP rules have no rounding line (README §2.3)
 *   7  assert Σ debit = Σ credit exactly, and every line well-formed
 *   8  assign the document number from the locked counter
 *   9  INSERT journal_entry ... ON CONFLICT DO NOTHING, then journal_lines
 *   10 audit record(s), same transaction, last
 *   11 return { journalEntryId, documentNumber, lines }
 *
 * TENANT AND ACTOR are not parameters. They come from TenantContext, which
 * the transaction `tx` was issued under (ADR-0004, rule 8): a caller cannot
 * substitute either. `userId === null` is FORBIDDEN — there is no service
 * account that posts (rule 22).
 *
 * THE CALLER OWNS THE TRANSACTION. A rejection is a thrown PostingError; the
 * caller's transaction then rolls back and nothing — key, number, entry,
 * audit record — survives (README §4 "rejected requests leave no trace").
 * The engine never commits, never retries, never swallows.
 */

export interface PostCommand {
  readonly event: FinancialEventName
  readonly referenceType: string
  readonly referenceId: string
  /** Business date, tenant timezone, ISO YYYY-MM-DD. */
  readonly occurredAt: string
  readonly idempotencyKey: string
  readonly payload: unknown
}

export interface PostResult {
  /** POSTED: this call wrote the entry. REPLAYED: an identical request already had. */
  readonly outcome: 'POSTED' | 'REPLAYED'
  readonly journalEntryId: string
  readonly documentNumber: string
  readonly entry: JournalEntryRow
  readonly lines: readonly JournalLineRow[]
}

export interface BuiltEntry {
  readonly postingRule: string
  readonly series: string
  readonly narration: string
  readonly reference: string | null
  readonly lines: readonly NewJournalLine[]
}

/** What the pipeline needs; built by `post` for an event, or by the reversal engine. */
export interface PipelineRequest {
  readonly tx: TenantTx
  readonly clock: Clock
  readonly tenantId: string
  readonly actorUserId: string
  readonly event: string
  readonly referenceType: string
  readonly referenceId: string
  readonly occurredAt: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly reversalOf: string | null
  readonly reversalReason: string | null
  /** Steps 4-6. Called only after idempotency and the period gate pass. */
  readonly build: (period: FiscalPeriodRow) => Promise<BuiltEntry>
  /**
   * Runs after the entry and its lines are written and before any audit
   * record. Returns further audit records to append after the entry's own.
   * The reversal engine uses it for E's POSTED -> REVERSED transition.
   */
  readonly afterInsert?: (entry: JournalEntryRow) => Promise<readonly AuditEventInput[]>
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/** The acting principal. Throws unless there is an authenticated user (rule 22). */
export function requirePostingActor(): { tenantId: string; actorUserId: string } {
  const { tenantId, userId } = TenantContext.require()
  if (userId === null) {
    throw new PostingError(
      'FORBIDDEN',
      'No authenticated user in context. There is no service account that posts (rule 22).',
    )
  }
  return { tenantId, actorUserId: userId }
}

export function assertIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new PostingError(
      'PAYLOAD_INVALID',
      'idempotencyKey must be 1-128 characters of [A-Za-z0-9._:-].',
      {
        field: 'idempotencyKey',
      },
    )
  }
}

function toResult(
  outcome: 'POSTED' | 'REPLAYED',
  entry: JournalEntryRow,
  lines: readonly JournalLineRow[],
): PostResult {
  return { outcome, journalEntryId: entry.id, documentNumber: entry.entryNumber, entry, lines }
}

/**
 * Step 2, and the conflict resolution of step 9. Plain SELECTs, no locks.
 *
 *  - same key, same fingerprint      -> the original result (REPLAYED)
 *  - same key, different fingerprint -> IDEMPOTENCY_KEY_REUSED, nothing posted
 *  - different key, same source      -> SOURCE_ALREADY_POSTED, naming the entry
 *  - neither                         -> null: this is a new posting
 *
 * Runs BEFORE the period gate, so a replay returns its original even after
 * the original's period has closed (README §4: a replay is not a posting).
 */
export async function lookUpPriorRequest(
  req: Pick<
    PipelineRequest,
    'tx' | 'tenantId' | 'idempotencyKey' | 'fingerprint' | 'referenceType' | 'referenceId'
  >,
): Promise<PostResult | null> {
  const byKey = await findEntryByIdempotencyKey(req.tx, req.tenantId, req.idempotencyKey)
  if (byKey) {
    if (byKey.requestFingerprint !== req.fingerprint) {
      throw new PostingError(
        'IDEMPOTENCY_KEY_REUSED',
        `idempotencyKey "${req.idempotencyKey}" was already used for a different request (${byKey.entryNumber}).`,
        { idempotencyKey: req.idempotencyKey, existingEntry: byKey.entryNumber },
      )
    }
    return toResult('REPLAYED', byKey, await findLinesByEntryId(req.tx, req.tenantId, byKey.id))
  }
  const bySource = await findEntryBySource(req.tx, req.tenantId, req.referenceType, req.referenceId)
  if (bySource) {
    throw new PostingError(
      'SOURCE_ALREADY_POSTED',
      `${req.referenceType} ${req.referenceId} already has a posted entry (${bySource.entryNumber}).`,
      {
        referenceType: req.referenceType,
        referenceId: req.referenceId,
        existingEntry: bySource.entryNumber,
      },
    )
  }
  return null
}

/**
 * Step 3. periods.md §5 (future tolerance 0 days, tenant timezone) and §4
 * (only OPEN accepts). The period row is taken FOR SHARE by
 * findPeriodForDate (LOCK_REGISTRY 5b), so a concurrent close either waits
 * for this posting or makes it observe CLOSED; migration 012's BEFORE INSERT
 * trigger re-checks the same row — the database's enforcement point, with no
 * bypass for any role (ADR-0012). This is the application's.
 */
async function resolveOpenPeriod(req: PipelineRequest): Promise<FiscalPeriodRow> {
  const timezone = await findTenantTimezone(req.tx, req.tenantId)
  const today = todayInTimezone(req.clock, timezone)
  // Lexicographic order is chronological order for two ISO dates.
  if (req.occurredAt > today) {
    throw new PostingError(
      'DATE_IN_FUTURE',
      `occurredAt ${req.occurredAt} is after today (${today}, ${timezone}).`,
      {
        occurredAt: req.occurredAt,
        today,
      },
    )
  }

  const period = await findPeriodForDate(req.tx, req.tenantId, req.occurredAt)
  if (!period) {
    // No nearest-period fallback and no implicit creation (periods.md §1, §6).
    throw new PostingError('PERIOD_NOT_FOUND', `No fiscal period covers ${req.occurredAt}.`, {
      occurredAt: req.occurredAt,
    })
  }
  if (period.status !== 'OPEN') {
    // journal-voucher.md §10: name the period AND the current open period.
    // Never redirected: the user chooses a date.
    const current = await findPeriodSummaryForDate(req.tx, req.tenantId, today)
    const currentOpenPeriod = current !== null && current.status === 'OPEN' ? current.label : null
    const code = period.status === 'LOCKED' ? 'PERIOD_LOCKED' : 'PERIOD_CLOSED'
    throw new PostingError(
      code,
      `Period ${period.label} is ${period.status}; it accepts no posting.`,
      {
        period: period.label,
        status: period.status,
        currentOpenPeriod,
      },
    )
  }
  return period
}

/**
 * Step 7, for EVERY rule — the application's enforcement point of rule 1,
 * ahead of the database's deferred balance trigger (the backstop) and the
 * FinancialInvariantSuite (the detector). A rule that builds a malformed or
 * unbalanced entry is a kernel defect: it is REPORTED (KernelInvariantError,
 * with both totals and the difference) and never completed with a balancing
 * line (Accounting Guardian absolute stop). A user's unbalanced voucher never
 * reaches here — the JV rule rejects it earlier as JV_UNBALANCED.
 */
export function assertEntryWellFormed(lines: readonly NewJournalLine[]): {
  debit: Money
  credit: Money
} {
  if (lines.length < 2) {
    throw new KernelInvariantError(
      `An entry needs at least two lines; the rule built ${lines.length}.`,
    )
  }
  const seen = new Set<number>()
  for (const line of lines) {
    if (!Number.isInteger(line.lineNumber) || line.lineNumber < 1 || seen.has(line.lineNumber)) {
      throw new KernelInvariantError(
        `Line numbers must be unique positive integers; got ${line.lineNumber}.`,
      )
    }
    seen.add(line.lineNumber)

    const debit = Money.from(line.debit)
    const credit = Money.from(line.credit)
    if (
      Money.isNegative(debit) ||
      Money.isNegative(credit) ||
      Money.isZero(debit) === Money.isZero(credit)
    ) {
      throw new KernelInvariantError(
        `Line ${line.lineNumber} must carry exactly one positive side (debit ${line.debit}, credit ${line.credit}).`,
      )
    }

    // README §4.1 / ADR-0026 statement 3, restated in the application so a
    // rule defect is named here rather than surfacing as a commit-time 23514.
    const partyOk =
      line.accountControl === 'AR'
        ? line.partyType === 'CUSTOMER' && line.partyId !== null
        : line.accountControl === 'AP'
          ? line.partyType === 'VENDOR' && line.partyId !== null
          : line.partyType === null && line.partyId === null
    if (!partyOk) {
      throw new KernelInvariantError(
        `Line ${line.lineNumber}: account control ${line.accountControl} with party ` +
          `${String(line.partyType)}/${String(line.partyId)} violates README §4.1.`,
      )
    }
  }

  const debit = Money.sum(lines.map((line) => Money.from(line.debit)))
  const credit = Money.sum(lines.map((line) => Money.from(line.credit)))
  if (!Money.equals(debit, credit)) {
    throw new KernelInvariantError(
      `Entry does not balance: debit ${Money.serialize(debit, 4)}, credit ${Money.serialize(credit, 4)}, ` +
        `difference ${Money.serialize(Money.subtract(debit, credit), 4)}. Not corrected — reported.`,
    )
  }
  return { debit, credit }
}

/** The audit after-image: the full line set and narration (journal-voucher.md §6). Strings only (ADR-0020). */
function postingAuditRecord(
  entry: JournalEntryRow,
  lines: readonly JournalLineRow[],
  period: FiscalPeriodRow,
  totals: { debit: Money; credit: Money },
  actorUserId: string,
): AuditEventInput {
  return {
    actorUserId,
    action: 'JOURNAL_ENTRY_POSTED',
    entityType: 'journal_entries',
    entityId: entry.id,
    beforeJson: null,
    afterJson: {
      entryNumber: entry.entryNumber,
      postingRule: entry.postingRule,
      event: entry.event,
      occurredAt: entry.occurredAt,
      period: period.label,
      status: entry.status,
      narration: entry.narration,
      reference: entry.reference,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      idempotencyKey: entry.idempotencyKey,
      reversalOf: entry.reversalOf,
      reversalReason: entry.reversalReason,
      totalDebit: Money.serialize(totals.debit, 4),
      totalCredit: Money.serialize(totals.credit, 4),
      lines: lines.map((line) => ({
        lineNumber: String(line.lineNumber),
        accountId: line.accountId,
        accountControl: line.accountControl,
        debit: line.debit,
        credit: line.credit,
        partyType: line.partyType,
        partyId: line.partyId,
        memo: line.memo,
      })),
    },
    ip: null,
    requestId: null,
  }
}

/** Steps 2-11. Every posting and every reversal runs through this one function. */
export async function runPostingPipeline(req: PipelineRequest): Promise<PostResult> {
  const { tx, tenantId, actorUserId } = req

  // --- 2. Idempotency, before the period gate. --------------------------------
  const prior = await lookUpPriorRequest(req)
  if (prior) return prior

  // --- 3. Date and period. ----------------------------------------------------
  const period = await resolveOpenPeriod(req)

  // --- 4-6. Rule: accounts, parties, lines. -----------------------------------
  const built = await req.build(period)

  // --- 7. Balance and line shape, for every rule. -----------------------------
  const totals = assertEntryWellFormed(built.lines)

  // --- 8-9. Number and write, gapless under a concurrent duplicate. -----------
  await openNumberingSavepoint(tx)
  // Year-scoped series (JV, RV, JE): {SERIES}-{FY}-{NNNNNN}, FY = the fiscal
  // year label of the entry's own period (README §4, periods.md §2).
  const entryNumber = await assignDocumentNumber(
    tx,
    tenantId,
    built.series,
    period.fiscalYear,
    actorUserId,
  )
  const entryId = await insertJournalEntryIfAbsent(tx, tenantId, {
    entryNumber,
    postingRule: built.postingRule,
    event: req.event,
    occurredAt: req.occurredAt,
    fiscalPeriodId: period.id,
    narration: built.narration,
    reference: built.reference,
    sourceType: req.referenceType,
    sourceId: req.referenceId,
    idempotencyKey: req.idempotencyKey,
    requestFingerprint: req.fingerprint,
    reversalOf: req.reversalOf,
    reversalReason: req.reversalReason,
    actorUserId,
  })

  if (entryId === null) {
    // A concurrent request with this key or this source committed first; the
    // INSERT waited for it and did nothing. Give the number back, then answer
    // exactly as step 2 would have had that request already been visible.
    await rollbackNumberingSavepoint(tx)
    const winner = await lookUpPriorRequest(req)
    if (winner) return winner
    throw new KernelInvariantError(
      `journal_entries INSERT conflicted, but on neither the idempotency key nor the source (entry number ${entryNumber}).`,
    )
  }
  await releaseNumberingSavepoint(tx)
  await insertJournalLines(tx, tenantId, entryId, actorUserId, built.lines)

  const entry = await findEntryById(tx, tenantId, entryId)
  if (!entry)
    throw new KernelInvariantError(`Entry ${entryId} is not readable after its own INSERT.`)
  const lines = await findLinesByEntryId(tx, tenantId, entryId)

  const followUpAudit = req.afterInsert ? await req.afterInsert(entry) : []

  // --- 10. Audit: same transaction, last (LOCK_REGISTRY 6 is terminal). -------
  await recordAudit(tx, postingAuditRecord(entry, lines, period, totals, actorUserId))
  for (const record of followUpAudit) await recordAudit(tx, record)

  // --- 11. ----------------------------------------------------------------------
  return toResult('POSTED', entry, lines)
}

interface RuleBinding {
  readonly sourceType: string
  readonly prepare: (payload: unknown) => (tx: TenantTx, tenantId: string) => Promise<BuiltEntry>
}

/** Step 4: the rule for each event. Payload validation happens in `prepare` (step 1). */
const RULES: Readonly<Record<FinancialEventName, RuleBinding>> = {
  [FinancialEvent.JOURNAL_VOUCHER_POSTED]: {
    sourceType: JOURNAL_VOUCHER_SOURCE_TYPE,
    prepare: (raw) => {
      const payload = validateJournalVoucherPayload(raw)
      return async (tx, tenantId) => ({
        postingRule: JOURNAL_VOUCHER_RULE_ID,
        series: JOURNAL_VOUCHER_SERIES,
        ...(await buildJournalVoucherEntry(tx, tenantId, payload)),
      })
    },
  },
  [FinancialEvent.SALE_POSTED]: {
    sourceType: SALE_SOURCE_TYPE,
    prepare: (raw) => {
      const payload = validateServiceSalePayload(raw)
      return async (tx, tenantId) => ({
        postingRule: SERVICE_SALE_RULE_ID,
        series: SALE_SERIES,
        ...(await buildServiceSaleEntry(tx, tenantId, payload)),
      })
    },
  },
  [FinancialEvent.CUSTOMER_PAYMENT_RECEIVED]: {
    sourceType: RECEIPT_SOURCE_TYPE,
    prepare: (raw) => {
      const payload = validateCustomerReceiptPayload(raw)
      return async (tx, tenantId) => ({
        postingRule: CUSTOMER_RECEIPT_RULE_ID,
        series: RECEIPT_SERIES,
        ...(await buildCustomerReceiptEntry(tx, tenantId, payload)),
      })
    },
  },
}

export interface PostingEngine {
  post(command: PostCommand, tx: TenantTx): Promise<PostResult>
}

/**
 * Engine construction with an injected clock. NOT exported from the package
 * index: production code uses `postingEngine` (the system clock). A clock is
 * an input to the future-date check and the reversal date rule, so letting a
 * module choose it would let a module choose "today" (rule 13). Tests import
 * this file directly to fix `today` to the golden fixture's date.
 */
export function createPostingEngine(clock: Clock = systemClock): PostingEngine {
  async function post(command: PostCommand, tx: TenantTx): Promise<PostResult> {
    // ADR-0005 Compliance: no transaction-less call; a forged handle throws.
    assertIssuedTenantTx(tx)
    const { tenantId, actorUserId } = requirePostingActor()

    // --- 1. Command shape. -----------------------------------------------------
    const rule = (RULES as Record<string, RuleBinding | undefined>)[command.event]
    if (!rule || !IMPLEMENTED_EVENTS.has(command.event)) {
      throw new PostingError(
        'RULE_NOT_ENABLED',
        `${String(command.event)} has no IMPLEMENTED posting rule (docs/posting-rules/README.md §1).`,
        { event: String(command.event) },
      )
    }
    if (command.referenceType !== rule.sourceType) {
      throw new PostingError(
        'PAYLOAD_INVALID',
        `${command.event} is raised by a ${rule.sourceType}, not "${String(command.referenceType)}".`,
        { field: 'referenceType' },
      )
    }
    if (!isUuid(command.referenceId)) {
      throw new PostingError('PAYLOAD_INVALID', 'referenceId must be a uuid.', {
        field: 'referenceId',
      })
    }
    if (!isIsoCalendarDate(command.occurredAt)) {
      throw new PostingError('PAYLOAD_INVALID', 'occurredAt must be a calendar date, YYYY-MM-DD.', {
        field: 'occurredAt',
      })
    }
    assertIdempotencyKey(command.idempotencyKey)
    const build = rule.prepare(command.payload)

    return runPostingPipeline({
      tx,
      clock,
      tenantId,
      actorUserId,
      event: command.event,
      referenceType: command.referenceType,
      referenceId: command.referenceId,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      // README §4: canonical (event, referenceType, referenceId, occurredAt, actor, payload).
      fingerprint: computeRequestFingerprint({
        event: command.event,
        referenceType: command.referenceType,
        referenceId: command.referenceId,
        occurredAt: command.occurredAt,
        actorUserId,
        payload: command.payload,
      }),
      reversalOf: null,
      reversalReason: null,
      build: () => build(tx, tenantId),
    })
  }

  return { post }
}

export const postingEngine: PostingEngine = createPostingEngine()
