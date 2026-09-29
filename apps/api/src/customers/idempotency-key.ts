import { BadRequestException } from '@nestjs/common'
import type { Request } from 'express'

/*
 * Idempotency-Key header. docs/design/M3/api-contract.md §1: required on
 * every POST that creates a document or changes its status. Mirrors
 * apps/api/src/accounting/idempotency-key.ts: presence is checked here, at
 * the boundary; the module's own use case re-checks the replay itself.
 */
const HEADER = 'idempotency-key'

export function requireIdempotencyKey(req: Request): string {
  const value = req.header(HEADER)
  if (!value) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'idempotency_key_required',
      message: `The ${HEADER} header is required.`,
    })
  }
  return value
}
