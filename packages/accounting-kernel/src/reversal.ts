import {
  assertIssuedTenantTx,
  computeRequestFingerprint,
  findAccountsByIds,
  findEntryById,
  findEntryBySource,
  findLinesByEntryId,
  findPeriodById,
  findTenantTimezone,
  lockEntryForReversal,
  type AuditEventInput,
  type JournalLineRow,
  type NewJournalLine,
  type TenantTx,
} from '@finsoft/database'
import { systemClock, type Clock } from './clock.ts'
import { todayInTimezone } from './dates.ts'
import { KernelInvariantError, PostingError } from './errors.ts'
import {
  assertIdempotencyKey,
  lookUpPriorRequest,
  requirePostingActor,
  runPostingPipeline,
  type PostResult,
} from './posting-engine.ts'
import { markJournalEntryReversed } from './queries/journal-writes.ts'
import { JOURNAL_VOUCHER_SOURCE_TYPE } from './rules/journal-voucher.ts'
import { isUuid } from './rules/shared.ts'

/*
 * REVERSAL@1. docs/posting-rules/reversal.md, ADR-0006.
 *
 * Not a FinancialEvent (§1): a kernel operation that runs the SAME pipeline
 * as every posting — idempotency, period gate, numbering, balance, insert,
 * audit — via runPostingPipeline, the function every postingEngine.post
 * uses. R records posting_rule REVERSAL@1 and the SAME event as E, so a
 * report grouping by event nets the pair.
 *
 * R copies E's STORED lines with debit and credit swapped: same account,
 * same account_control, same party, same amount (§2). No rule is re-run and
 * nothing is re-rounded (ADR-0014), so a rule change after E cannot make R
 * differ from E. Invariant 6 holds per account and per party by construction.
 */

export const REVERSAL_RULE_ID = 'REVERSAL@1'
export const REVERSAL_SERIES = 'RV'
export const REVERSAL_SOURCE_TYPE = 'reversal'
const REASON_MAX = 500
const NARRATION_MAX = 500

export interface ReverseCommand {
  readonly entryId: string
  readonly reason: string
  readonly idempotencyKey: string
}

/**
 * K2 (docs/design/M3/README.md §4, docs/design/M3/modules.md §4.3/§4.4).
 * Called by the owning module — "reverse invoice", "reverse receipt" — in
 * place of `entryId`, which the module does not carry on its own document
 * row (reversal.md §5: the journal entry is found through the kernel's
 * `UNIQUE (tenant_id, source_type, source_id)`, never stored a second time).
 *
 * `actor` is part of the call shape modules.md §4.3/§4.4 fixes, matching the
 * `Actor` shape every module command already carries end-to-end from its
 * controller (modules cannot read `TenantContext` themselves, ADR-0028 S1).
 * It is NOT read here: exactly like every other kernel entry point, the
 * kernel's own actor is `requirePostingActor(tx)` — the ambient principal of
 * the transaction the caller opened (ADR-0028 statement 6: "the actor comes
 * from TenantContext ... and never from an argument"). The field exists so a
 * module's `ReverseInvoice`/`ReverseReceipt` can pass the same `actor` value
 * it threads to its own `recordAudit` call, without the kernel depending on
 * it matching.
 */
export interface ReverseForSourceCommand {
  readonly referenceType: string
  readonly referenceId: string
  readonly reason: string
  readonly idempotencyKey: string
  readonly actor: { readonly userId: string }
}

export interface ReverseResult extends PostResult {
  /**
   * §4 "Disclosure": set when E's period was CLOSED or LOCKED, so R is dated
   * today in the current open period rather than on E's date.
   */
  readonly disclosure: {
    readonly originalPeriod: string
    readonly originalPeriodStatus: string
  } | null
}

function reverseLine(line: JournalLineRow): NewJournalLine {
  return {
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    accountControl: line.accountControl,
    debit: line.credit,
    credit: line.debit,
    partyType: line.partyType,
    partyId: line.partyId,
    memo: line.memo,
  }
}

/**
 * R's narration: the disclosure and the reason. The full reason is always
 * stored in reversal_reason (<= 500). The narration column is also <= 500, so
 * when prefix + reason would exceed it the narration's COPY of the reason is
 * shortened with a visible marker pointing at the stored reason — the
 * disclosure prefix itself is never cut.
 */
function reversalNarration(prefix: string, reason: string): string {
  const full = `${prefix}: ${reason}`
  if (full.length <= NARRATION_MAX) return full
  const marker = ' … [full reason in reversal_reason]'
  return `${prefix}: ${reason.slice(0, NARRATION_MAX - prefix.length - 2 - marker.length)}${marker}`
}

export interface ReversalEngine {
  reverse(command: ReverseCommand, tx: TenantTx): Promise<ReverseResult>
  /** K2 — see ReverseForSourceCommand. */
  reverseForSource(command: ReverseForSourceCommand, tx: TenantTx): Promise<ReverseResult>
}

/** Not exported from the package index — see createPostingEngine. */
export function createReversalEngine(clock: Clock = systemClock): ReversalEngine {
  /**
   * The shared body of `reverse` and `reverseForSource`: both resolve to a
   * journal entry id and a reason/key, then run the identical pipeline. The
   * only behavioural difference is `checkJournalVoucherSource`:
   *
   *  - `reverse` (direct, entryId-based): true. reversal.md §3 row 4 / §5 —
   *    a document-sourced entry reached through the journal API is refused
   *    with REVERSAL_VIA_SOURCE_REQUIRED; only a manual JV reverses directly.
   *  - `reverseForSource` (K2, module-based): false. This IS the sanctioned
   *    via-source path: the caller already identified the entry by its own
   *    document (`referenceType`/`referenceId`), so the entry is, BY
   *    CONSTRUCTION, not a journal voucher (a JV's source_type is always
   *    'journal_voucher', never a module's own referenceType).
   */
  async function performReversal(
    tx: TenantTx,
    entryId: string,
    reason: string,
    idempotencyKey: string,
    checkJournalVoucherSource: boolean,
  ): Promise<ReverseResult> {
    const { tenantId, actorUserId } = requirePostingActor(tx)

    /*
     * The request's identity. A reversal request carries no business date —
     * R's date is DERIVED (§4) and, once E's period has closed, depends on
     * which day the request arrives. So occurredAt is not part of the request
     * fingerprint: a retry on a later day with the same key, entry and reason
     * is the same request and must replay, not collide.
     */
    const fingerprint = computeRequestFingerprint({
      event: REVERSAL_RULE_ID,
      referenceType: REVERSAL_SOURCE_TYPE,
      referenceId: entryId,
      occurredAt: '',
      actorUserId,
      payload: { reason },
    })

    // --- 2. Idempotency FIRST (§7): a replay returns R even though E is by now
    // REVERSED, which the precondition below would otherwise reject. ------------
    const prior = await lookUpPriorRequest({
      tx,
      tenantId,
      idempotencyKey,
      fingerprint,
      referenceType: REVERSAL_SOURCE_TYPE,
      referenceId: entryId,
    }).catch((error: unknown) => {
      // A second reversal of E under a NEW key finds R through the source
      // uniqueness ('reversal', E.id). reversal.md §7 names that case
      // ALREADY_REVERSED, not SOURCE_ALREADY_POSTED. Pure translation of a
      // typed rejection — no statement has failed, the transaction is intact.
      if (error instanceof PostingError && error.code === 'SOURCE_ALREADY_POSTED') {
        throw new PostingError(
          'ALREADY_REVERSED',
          `Entry is already REVERSED by ${String(error.details.existingEntry)}.`,
          {
            entryId,
            reversedBy: error.details.existingEntry,
          },
        )
      }
      throw error
    })
    if (prior) return { ...prior, disclosure: null }

    // --- Preconditions (§3), on E held FOR UPDATE (LOCK_REGISTRY 5a) so two
    // concurrent reversals of E serialise; the loser then reads REVERSED. -------
    const original = await lockEntryForReversal(tx, tenantId, entryId)
    if (!original) {
      throw new PostingError('ENTRY_NOT_FOUND', `Entry ${entryId} was not found.`, {
        entryId,
      })
    }
    if (original.reversalOf !== null) {
      throw new PostingError(
        'REVERSAL_OF_REVERSAL',
        `${original.entryNumber} is itself a reversal and cannot be reversed; post a new, corrected entry (§6).`,
        { entry: original.entryNumber },
      )
    }
    if (original.status === 'REVERSED') {
      const reversal = original.reversedBy
        ? await findEntryById(tx, tenantId, original.reversedBy)
        : null
      throw new PostingError(
        'ALREADY_REVERSED',
        `${original.entryNumber} is already REVERSED by ${reversal?.entryNumber ?? String(original.reversedBy)}.`,
        { entry: original.entryNumber, reversedBy: reversal?.entryNumber ?? null },
      )
    }
    // §5: only a manual JV is reversed directly from the journal. A document-
    // sourced entry is reversed through its module, which also undoes the
    // subledger; a GL-only reversal would break Invariant 9 by itself. K2
    // (reverseForSource) sets checkJournalVoucherSource = false: it IS that
    // module path, and the entry was found by the module's own source, so it
    // cannot be a journal voucher (see the jsdoc above performReversal).
    if (checkJournalVoucherSource && original.sourceType !== JOURNAL_VOUCHER_SOURCE_TYPE) {
      throw new PostingError(
        'REVERSAL_VIA_SOURCE_REQUIRED',
        `${original.entryNumber} comes from a ${original.sourceType}; reverse it through that document (§5).`,
        { entry: original.entryNumber, sourceType: original.sourceType },
      )
    }

    // --- §4: R's date. Looks only at E's period status NOW. ----------------------
    const originalPeriod = await findPeriodById(tx, tenantId, original.fiscalPeriodId)
    if (!originalPeriod) {
      throw new KernelInvariantError(`Entry ${original.id}'s fiscal period does not resolve.`)
    }
    let occurredAt: string
    let disclosure: ReverseResult['disclosure']
    if (originalPeriod.status === 'OPEN') {
      // "As if E never happened", for every date range (§4).
      occurredAt = original.occurredAt
      disclosure = null
    } else {
      // Today in the tenant timezone, from the injected clock. Today's own
      // period must be OPEN — the pipeline's gate rejects otherwise; R is
      // never redirected to some other open period.
      occurredAt = todayInTimezone(clock, await findTenantTimezone(tx, tenantId))
      disclosure = {
        originalPeriod: originalPeriod.label,
        originalPeriodStatus: originalPeriod.status,
      }
    }

    const narration = reversalNarration(
      disclosure
        ? `Reversal of ${original.entryNumber} (${disclosure.originalPeriod}, ${disclosure.originalPeriodStatus})`
        : `Reversal of ${original.entryNumber}`,
      reason,
    )

    const result = await runPostingPipeline({
      tx,
      clock,
      tenantId,
      actorUserId,
      event: original.event,
      referenceType: REVERSAL_SOURCE_TYPE,
      referenceId: original.id,
      occurredAt,
      idempotencyKey,
      fingerprint,
      reversalOf: original.id,
      reversalReason: reason,
      build: async () => {
        const originalLines = await findLinesByEntryId(tx, tenantId, original.id)
        // A line on an account deactivated since E posted would be refused by
        // migration 012's line gate as a raw 23514; name it instead.
        const accounts = await findAccountsByIds(tx, tenantId, [
          ...new Set(originalLines.map((l) => l.accountId)),
        ])
        for (const line of originalLines) {
          const account = accounts.get(line.accountId)
          if (!account || !account.isActive) {
            throw new PostingError(
              'ACCOUNT_INACTIVE',
              `${original.entryNumber} line ${line.lineNumber} is on account ${account?.code ?? line.accountId}, ` +
                'which is no longer active; it cannot receive the reversing line.',
              { entry: original.entryNumber, accountId: line.accountId },
            )
          }
        }
        return {
          postingRule: REVERSAL_RULE_ID,
          series: REVERSAL_SERIES,
          narration,
          reference: null,
          // Exactly E's lines, in E's order, sides swapped (§2).
          lines: originalLines.map(reverseLine),
        }
      },
      afterInsert: async (reversalEntry): Promise<readonly AuditEventInput[]> => {
        // §8: E POSTED -> REVERSED — the only update a posted entry ever
        // receives. Before the audit append, so nothing locks after position 6.
        await markJournalEntryReversed(
          tx,
          tenantId,
          original.id,
          reversalEntry.id,
          original.version,
          actorUserId,
        )
        return [
          {
            actorUserId,
            action: 'JOURNAL_ENTRY_REVERSED',
            entityType: 'journal_entries',
            entityId: original.id,
            beforeJson: { entryNumber: original.entryNumber, status: 'POSTED' },
            afterJson: {
              entryNumber: original.entryNumber,
              status: 'REVERSED',
              reversedBy: reversalEntry.id,
              reversedByEntryNumber: reversalEntry.entryNumber,
              reason,
            },
          },
        ]
      },
    })

    return { ...result, disclosure: result.outcome === 'POSTED' ? disclosure : null }
  }

  async function reverse(command: ReverseCommand, tx: TenantTx): Promise<ReverseResult> {
    assertIssuedTenantTx(tx)
    requirePostingActor(tx) // fails closed (FORBIDDEN) before any other work if unauthenticated.

    // --- 1. Shape. ---------------------------------------------------------------
    const reason = typeof command.reason === 'string' ? command.reason.trim() : ''
    if (reason.length === 0 || reason.length > REASON_MAX) {
      throw new PostingError(
        'REVERSAL_REASON_REQUIRED',
        `A reason is required: non-empty after trimming, at most ${REASON_MAX} characters.`,
      )
    }
    assertIdempotencyKey(command.idempotencyKey)
    // Unknown, malformed and another tenant's id are the same answer (§3 row 1).
    if (!isUuid(command.entryId)) {
      throw new PostingError('ENTRY_NOT_FOUND', `Entry ${String(command.entryId)} was not found.`, {
        entryId: String(command.entryId),
      })
    }

    return performReversal(tx, command.entryId, reason, command.idempotencyKey, true)
  }

  /**
   * K2. Resolves the entry by its document's own `(referenceType,
   * referenceId)` — the module has no `entryId` of its own to hand in
   * (reversal.md §5) — then runs the identical pipeline as `reverse`, with
   * `checkJournalVoucherSource = false` (see performReversal's jsdoc).
   */
  async function reverseForSource(
    command: ReverseForSourceCommand,
    tx: TenantTx,
  ): Promise<ReverseResult> {
    assertIssuedTenantTx(tx)
    const { tenantId } = requirePostingActor(tx)

    const reason = typeof command.reason === 'string' ? command.reason.trim() : ''
    if (reason.length === 0 || reason.length > REASON_MAX) {
      throw new PostingError(
        'REVERSAL_REASON_REQUIRED',
        `A reason is required: non-empty after trimming, at most ${REASON_MAX} characters.`,
      )
    }
    assertIdempotencyKey(command.idempotencyKey)
    if (typeof command.referenceType !== 'string' || command.referenceType.length === 0) {
      throw new PostingError('PAYLOAD_INVALID', 'referenceType is required.', {
        field: 'referenceType',
      })
    }
    // Unknown, malformed and another tenant's id are the same answer (§3 row 1).
    if (!isUuid(command.referenceId)) {
      throw new PostingError(
        'ENTRY_NOT_FOUND',
        `${command.referenceType} ${String(command.referenceId)} has no posted entry.`,
        { referenceType: command.referenceType, referenceId: String(command.referenceId) },
      )
    }

    const entry = await findEntryBySource(tx, tenantId, command.referenceType, command.referenceId)
    if (!entry) {
      throw new PostingError(
        'ENTRY_NOT_FOUND',
        `${command.referenceType} ${command.referenceId} has no posted entry.`,
        { referenceType: command.referenceType, referenceId: command.referenceId },
      )
    }

    return performReversal(tx, entry.id, reason, command.idempotencyKey, false)
  }

  return { reverse, reverseForSource }
}

export const reversalEngine: ReversalEngine = createReversalEngine()
