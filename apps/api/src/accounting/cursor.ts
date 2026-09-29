import { BadRequestException } from '@nestjs/common'

/*
 * Opaque keyset-cursor codec for the accounting list endpoints. The wire
 * format is a caller's concern only in that it must round-trip
 * (`nextCursor` in, `?cursor=` back out unchanged) — apps/api owns the
 * encoding; packages/database's cursor types are plain objects.
 */

export function encodeCursor<T extends object>(cursor: T | null): string | null {
  if (cursor === null) return null
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/**
 * Decodes a cursor previously produced by `encodeCursor`. A forged or
 * corrupted cursor is a client error, never a 500 and never silently
 * ignored (docs/design/M2/api-contract.md §1, "Pagination").
 */
export function decodeCursor<T extends Record<string, unknown>>(
  raw: string | undefined,
  isShape: (value: unknown) => value is T,
): T | null {
  if (raw === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new BadRequestException({
      statusCode: 400,
      error: 'invalid_cursor',
      message: 'The cursor is malformed.',
    })
  }
  if (!isShape(parsed)) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'invalid_cursor',
      message: 'The cursor is malformed.',
    })
  }
  return parsed
}

export function isJournalEntryCursorShape(
  value: unknown,
): value is { occurredAt: string; createdAt: string; id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['occurredAt'] === 'string' &&
    typeof (value as Record<string, unknown>)['createdAt'] === 'string' &&
    typeof (value as Record<string, unknown>)['id'] === 'string'
  )
}

/**
 * The ledger cursor carries `closingBalance` alongside packages/reporting's
 * own `LedgerCursor` shape (occurredAt/createdAt/entryNumber/lineNumber):
 * `accountLedger`'s own contract requires the previous page's closing
 * balance to resume correctly (running balance cannot be recomputed from
 * `from` alone past page 1) — see ledgers.controller.ts.
 */
export function isLedgerCursorShape(value: unknown): value is {
  occurredAt: string
  createdAt: string
  entryNumber: string
  lineNumber: number
  closingBalance: string
} {
  const v = value as Record<string, unknown> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v['occurredAt'] === 'string' &&
    typeof v['createdAt'] === 'string' &&
    typeof v['entryNumber'] === 'string' &&
    typeof v['lineNumber'] === 'number' &&
    typeof v['closingBalance'] === 'string'
  )
}
