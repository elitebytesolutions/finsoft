import type { NextFunction, Request, Response } from 'express'
import { withCorrelation } from '@finsoft/observability'
import { clientIp } from '../auth/request-context'
import { resolveRequestId } from './request-id'

/*
 * Establishes the request correlation context for every request. M1-C.
 *
 * ── Why this must be Express middleware, not a Nest guard or interceptor ──
 *
 * apps/api/src/common/tenant.guard.ts's own header explains the mechanism
 * this relies on: a NestJS `CanActivate`/interceptor returns a value to
 * Nest's own dispatcher, and the handler chain that follows is NOT a causal
 * descendant of any `AsyncLocalStorage.run()` the guard entered — so a
 * context entered there does not survive past the guard. Only genuine
 * Express middleware calling `next()` *synchronously from inside*
 * `withCorrelation`'s callback keeps the store alive for the rest of the
 * pipeline, because everything Express (and, on top of it, every Nest guard,
 * interceptor and handler) does next runs as a continuation of that same
 * call. This is registered with `app.use()` in main.ts — earlier than any
 * Nest guard, interceptor or filter can run — for exactly that reason.
 *
 * ── What it establishes ────────────────────────────────────────────────
 *
 * `requestId` — the inbound `X-Request-Id` header ONLY if it is a
 * well-formed UUID (see request-id.ts for why arbitrary client text is
 * never trusted); otherwise a freshly minted one. Echoed on the response so
 * a caller that did not send one can still correlate its own logs against
 * this system's.
 *
 * `ip` — `clientIp(req)`, the exact trusted-proxy-aware extraction
 * apps/api/src/auth/request-context.ts already uses for rate limiting and
 * session rows (ADR-0023 §5). Reused rather than duplicated: the trust
 * rules for X-Forwarded-For (which hop is real, what to do when the header
 * is present but invalid at the trusted position) are exactly the kind of
 * logic that drifts out of sync when written twice.
 *
 * Both flow into `withCorrelation`, which the observability package already
 * threads through every log line via `mixin()` (packages/observability/src/
 * logger.ts) — so no call site anywhere downstream has to remember to pass
 * either one for a log to carry them. `packages/database`'s `recordAudit`
 * reads the same ambient context to default `request_id`/`ip` on an audit
 * row when its caller does not supply them explicitly (packages/database/
 * src/audit/writer.ts) — see that file for why an explicit caller value
 * always wins and a missing context is never fabricated into one.
 */

export const REQUEST_ID_HEADER = 'x-request-id'
export const REQUEST_ID_RESPONSE_HEADER = 'X-Request-Id'

declare module 'express' {
  interface Request {
    /**
     * The correlation id established for this request — identical to
     * `getCorrelation()?.requestId` for the lifetime of the request, and to
     * the `X-Request-Id` response header. Exposed on the request object as a
     * convenience for anything that has a `Request` but not an active
     * AsyncLocalStorage frame (there is none such today; kept narrow so it
     * does not become a second source of truth).
     */
    requestId?: string
  }
}

export function requestCorrelationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER])
  req.requestId = requestId
  res.setHeader(REQUEST_ID_RESPONSE_HEADER, requestId)

  const ip = clientIp(req)

  withCorrelation({ requestId, ip }, next)
}
