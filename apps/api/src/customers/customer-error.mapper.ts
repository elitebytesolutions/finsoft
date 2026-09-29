import { HttpException } from '@nestjs/common'
import {
  customerErrorSlug,
  statusForCustomerErrorCode,
  type CustomerError,
} from '@finsoft/customers'
import { ControlAccountMisconfiguredError, ControlAccountUnmappedError } from '@finsoft/reporting'

/*
 * CustomerError -> HTTP. docs/design/M3/api-contract.md §3 is the reviewable
 * surface; the module's own api/errors.ts (statusForCustomerErrorCode /
 * customerErrorSlug) is the single source for the status table — this file
 * is only the adapter that turns the module's typed error into the NestJS
 * response shape, mirroring apps/api/src/accounting/posting-error.mapper.ts's
 * own precedent. `CustomerDirectoryError` (published.ts) is not handled
 * here: it is thrown only by CustomerDirectory.requireActiveForPosting,
 * which modules/receivables (M3-P) calls — none of this module's own routes
 * reach it.
 */
export function mapCustomerError(error: CustomerError): HttpException {
  const status = statusForCustomerErrorCode(error.code)
  return new HttpException(
    {
      statusCode: status,
      error: customerErrorSlug(error.code),
      message: error.message,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    },
    status,
  )
}

/**
 * `@finsoft/reporting`'s K5 read (`controlAccountLedger`, called from
 * `getCustomerLedger` via the module's repository) can fail with a tenant
 * CONFIGURATION fault rather than a caller error — no active account holds
 * AR_CONTROL, or it is misconfigured. api-contract.md §3: `422`, mapped the
 * same way the kernel's own `ACCOUNT_ROLE_UNMAPPED`/`ACCOUNT_ROLE_MISCONFIGURED`
 * are on every posting route. Reachable only from C7 (GET .../ledger) —
 * every other route in this controller never resolves an account role.
 */
export function mapControlAccountError(
  error: ControlAccountUnmappedError | ControlAccountMisconfiguredError,
): HttpException {
  return new HttpException(
    {
      statusCode: 422,
      error: error.code.toLowerCase(),
      message: error.message,
      details: { role: error.role },
    },
    422,
  )
}

export function isControlAccountError(
  error: unknown,
): error is ControlAccountUnmappedError | ControlAccountMisconfiguredError {
  return (
    error instanceof ControlAccountUnmappedError ||
    error instanceof ControlAccountMisconfiguredError
  )
}
