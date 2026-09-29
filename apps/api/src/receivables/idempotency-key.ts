import { BadRequestException } from '@nestjs/common'
import type { Request } from 'express'

/*
 * Idempotency-Key header. docs/design/M3/api-contract.md §1: required on
 * every POST that creates a document or changes its status. Mirrors
 * apps/api/src/customers/idempotency-key.ts / apps/api/src/accounting/
 * idempotency-key.ts.
 */
const HEADER = 'idempotency-key'
// README §4: 1-128 chars, [A-Za-z0-9._:-]. S-D (Security seat, Council
// review of efb7e3f): a malformed key must be a typed 400, not whatever the
// kernel's own assertIdempotencyKey (PAYLOAD_INVALID) or a raw DB error
// produces further down the call stack.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export function requireIdempotencyKey(req: Request): string {
  const value = req.header(HEADER)
  if (!value) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'idempotency_key_required',
      message: `The ${HEADER} header is required.`,
    })
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'idempotency_key_invalid',
      message: `The ${HEADER} header must be 1-128 characters of [A-Za-z0-9._:-].`,
    })
  }
  return value
}
