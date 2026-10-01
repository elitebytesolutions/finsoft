import { HttpException } from '@nestjs/common'
import {
  CustomerDirectoryError,
  receivablesErrorSlug,
  statusForReceivablesErrorCode,
  ReceivablesError,
} from '@finsoft/receivables'
import { PostingError } from '@finsoft/accounting-kernel'

/*
 * ReceivablesError | PostingError | CustomerDirectoryError -> HTTP.
 * docs/design/M3/api-contract.md §3 is the reviewable surface;
 * modules/receivables/api/errors.ts's status table is its implementation.
 * This file is only the NestJS adapter, mirroring
 * apps/api/src/customers/customer-error.mapper.ts's own precedent.
 *
 * `fromPathId` disambiguates CUSTOMER_NOT_FOUND / INVOICE_NOT_FOUND, which
 * is 404 when the id came from the URL path and 422 when it came from a
 * request body (api-contract.md §3).
 */
export function mapReceivablesError(
  error: ReceivablesError | PostingError | CustomerDirectoryError,
  fromPathId = false,
): HttpException {
  const status = statusForReceivablesErrorCode(error.code, fromPathId)
  const details = 'details' in error ? error.details : {}
  return new HttpException(
    {
      statusCode: status,
      error: receivablesErrorSlug(error.code),
      message: error.message,
      ...(details && Object.keys(details).length > 0 ? { details } : {}),
    },
    status,
  )
}

export function isReceivablesRoutableError(
  error: unknown,
): error is ReceivablesError | PostingError | CustomerDirectoryError {
  return (
    error instanceof ReceivablesError ||
    error instanceof PostingError ||
    error instanceof CustomerDirectoryError
  )
}
