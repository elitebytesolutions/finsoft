import { BadRequestException } from '@nestjs/common'
import type { Request } from 'express'

/*
 * Idempotency-Key header. ADR-0027, docs/posting-rules/README.md §4:
 * required on every posting endpoint. Presence is checked here, at the
 * boundary, so a caller who simply forgot the header gets a clear message
 * rather than the kernel's generic PAYLOAD_INVALID; the kernel's own
 * assertIdempotencyKey (packages/accounting-kernel) still re-checks the
 * FORMAT (1-128 chars, [A-Za-z0-9._:-]) and is the authoritative rejection
 * for a malformed key — this function does not duplicate that regex.
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
