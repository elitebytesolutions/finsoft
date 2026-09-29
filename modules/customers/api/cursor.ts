import { CustomerError } from '../domain/errors.ts'
import type { CustomerListCursor } from '../application/ports.ts'

/*
 * Opaque keyset-cursor codec, framework-free (no NestJS here — ADR-0028
 * statement 4). A malformed cursor is `VALIDATION_FAILED`, mapped to 400 by
 * the shared error table, never a 500 and never silently ignored.
 */

export function encodeCustomerCursor(cursor: CustomerListCursor | null): string | null {
  if (cursor === null) return null
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeCustomerCursor(raw: string | undefined): CustomerListCursor | null {
  if (raw === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new CustomerError('VALIDATION_FAILED', 'The cursor is malformed.', { path: 'cursor' })
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['code'] !== 'string'
  ) {
    throw new CustomerError('VALIDATION_FAILED', 'The cursor is malformed.', { path: 'cursor' })
  }
  return parsed as CustomerListCursor
}
