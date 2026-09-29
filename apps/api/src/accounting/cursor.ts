import { BadRequestException } from '@nestjs/common'
import { UUID_PATTERN } from './dto/shared'

/*
 * Opaque keyset-cursor codec for the accounting list endpoints.
 *
 * M2-B Council ruling, 2026-09-29 (all three seats): a cursor is base64url
 * JSON, so it is trivially readable and editable by anyone holding it — it
 * is opaque by CONVENTION (a client should treat it as a token), never by
 * secrecy. Every field is therefore validated on decode:
 *
 *  - FORMAT: a uuid is a uuid, a date is a real calendar date, a timestamp
 *    is a real ISO instant, an integer is an integer. A cursor that fails
 *    format validation is 400, never trusted, never allowed to reach a
 *    `uuid`- or `date`-typed SQL parameter as a raw string (which would
 *    surface as a 500 from a PostgreSQL type-cast error instead).
 *  - For the ledger cursor only: the CONTEXT it was issued for (accountId,
 *    from, to, partyId) must match the request presenting it. A cursor
 *    issued for account X presented on account Y, or under a different
 *    date range, is 400 — never silently reinterpreted against the new
 *    context, which could otherwise return a running balance that carries
 *    forward from the wrong account or the wrong range.
 *  - No financial number ever travels in a cursor. The ledger cursor used
 *    to carry `closingBalance`; packages/reporting now recomputes the
 *    carry-forward balance from the cursor's POSITION alone
 *    (accountLedgerBalanceThrough) — see that package for why.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
// Matches accountLedgerLines' / listJournalEntries' own to_char format:
// YYYY-MM-DDTHH:MI:SS.UUUUUU Z (microsecond precision, UTC).
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const ENTRY_NUMBER = /^[A-Z]+-\d{4}-\d{6}$/

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value)
}
function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value)
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function invalidCursor(): never {
  throw new BadRequestException({
    statusCode: 400,
    error: 'invalid_cursor',
    message: 'The cursor is malformed, forged, or was issued for a different request.',
  })
}

export function encodeCursor<T extends object>(cursor: T | null): string | null {
  if (cursor === null) return null
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    invalidCursor()
  }
}

/* ------------------------------------------------------------------ *
 * Register cursor — GET /api/journals
 * ------------------------------------------------------------------ */

export interface RegisterCursor {
  readonly occurredAt: string
  readonly createdAt: string
  readonly id: string
}

export function decodeRegisterCursor(raw: string | undefined): RegisterCursor | null {
  if (raw === undefined) return null
  const value = decodeJson(raw)
  if (typeof value !== 'object' || value === null) invalidCursor()
  const v = value as Record<string, unknown>
  if (!isIsoDate(v['occurredAt'])) invalidCursor()
  if (!isIsoTimestamp(v['createdAt'])) invalidCursor()
  if (!isUuid(v['id'])) invalidCursor()
  return { occurredAt: v['occurredAt'], createdAt: v['createdAt'], id: v['id'] }
}

/* ------------------------------------------------------------------ *
 * Ledger cursor — GET /api/ledgers/:accountId
 * ------------------------------------------------------------------ */

export interface LedgerCursorPosition {
  readonly occurredAt: string
  readonly createdAt: string
  readonly entryNumber: string
  readonly lineNumber: number
}

export interface LedgerCursorContext {
  readonly accountId: string
  readonly from: string
  readonly to: string
  readonly partyId: string | null
}

export type LedgerCursorDto = LedgerCursorPosition & { readonly issuedFor: LedgerCursorContext }

function decodeLedgerCursorFormat(raw: string): LedgerCursorDto {
  const value = decodeJson(raw)
  if (typeof value !== 'object' || value === null) invalidCursor()
  const v = value as Record<string, unknown>

  if (!isIsoDate(v['occurredAt'])) invalidCursor()
  if (!isIsoTimestamp(v['createdAt'])) invalidCursor()
  if (typeof v['entryNumber'] !== 'string' || !ENTRY_NUMBER.test(v['entryNumber'])) invalidCursor()
  if (!isPositiveInteger(v['lineNumber'])) invalidCursor()

  const issuedFor = v['issuedFor']
  if (typeof issuedFor !== 'object' || issuedFor === null) invalidCursor()
  const ctx = issuedFor as Record<string, unknown>
  if (!isUuid(ctx['accountId'])) invalidCursor()
  if (!isIsoDate(ctx['from'])) invalidCursor()
  if (!isIsoDate(ctx['to'])) invalidCursor()
  if (ctx['partyId'] !== null && !isUuid(ctx['partyId'])) invalidCursor()

  return {
    occurredAt: v['occurredAt'] as string,
    createdAt: v['createdAt'] as string,
    entryNumber: v['entryNumber'] as string,
    lineNumber: v['lineNumber'] as number,
    issuedFor: {
      accountId: ctx['accountId'] as string,
      from: ctx['from'] as string,
      to: ctx['to'] as string,
      partyId: ctx['partyId'] as string | null,
    },
  }
}

/**
 * Decodes and validates a ledger cursor's FORMAT, then requires its
 * `issuedFor` to match the request presenting it exactly — the accountId in
 * the path, and the from/to/partyId in the query. Either failure is 400
 * (`invalid_cursor`); the caller cannot tell the two apart, which is
 * deliberate — neither is information a forger should get back.
 */
export function decodeLedgerCursor(
  raw: string | undefined,
  expected: LedgerCursorContext,
): LedgerCursorPosition | null {
  if (raw === undefined) return null
  const cursor = decodeLedgerCursorFormat(raw)
  const issuedFor = cursor.issuedFor
  if (
    issuedFor.accountId !== expected.accountId ||
    issuedFor.from !== expected.from ||
    issuedFor.to !== expected.to ||
    issuedFor.partyId !== expected.partyId
  ) {
    invalidCursor()
  }
  return {
    occurredAt: cursor.occurredAt,
    createdAt: cursor.createdAt,
    entryNumber: cursor.entryNumber,
    lineNumber: cursor.lineNumber,
  }
}

export function encodeLedgerCursor(
  position: LedgerCursorPosition | null,
  issuedFor: LedgerCursorContext,
): string | null {
  if (position === null) return null
  return encodeCursor<LedgerCursorDto>({ ...position, issuedFor })
}
