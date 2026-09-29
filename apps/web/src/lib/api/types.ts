/* Wire types for the auth surface, per the fixed HTTP contract (M1-W brief):
 *
 *   POST /api/auth/login    {tenantCode, email, password}
 *                           -> 200 {accessToken, expiresIn, user, tenant} + Set-Cookie finsoft_rt
 *                           -> 401 {error:'invalid_credentials', message}
 *                           -> 429 (Retry-After header)
 *   POST /api/auth/refresh  (cookie + X-Requested-With) -> 200 same shape, rotated cookie; 401
 *   POST /api/auth/logout   (same header) -> 204
 *   GET  /api/auth/me       (Bearer) -> {user, tenant, sessionId, permissionVersion}
 *
 * These types belong here rather than in packages/shared-types because the auth lane
 * (m1-auth) owns that contract and packages/shared-types is currently empty (`export {}`).
 * Promote this file's shapes there once the contract is published from one place — see
 * OBSERVED in the M1-W report. */

export interface SessionUser {
  id: string
  fullName: string
  email: string
}

export interface SessionTenant {
  id: string
  code: string
  name: string
}

export interface LoginRequest {
  tenantCode: string
  email: string
  password: string
}

export interface LoginResponse {
  accessToken: string
  expiresIn: number
  user: SessionUser
  tenant: SessionTenant
}

export interface MeResponse {
  user: SessionUser
  tenant: SessionTenant
  sessionId: string
  permissionVersion: number
}

/** Machine-checkable error kinds the UI actually branches on. Anything else is `unknown`. */
export type ApiErrorCode =
  | 'invalid_credentials'
  | 'rate_limited'
  | 'validation_failed'
  | 'forbidden'
  | 'session_expired'
  | 'network_error'
  | 'unknown'

/** One `packages/validation`-shaped field failure, from a 400 `validation_failed` body. */
export interface ApiFieldError {
  path: string
  message: string
}

/**
 * Typed error thrown by every function in `client.ts`. Screens branch on `.code`, never on a
 * parsed message string — the message is for display, the code is for control flow.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status?: number
  /** Seconds until a retry may succeed, from the `Retry-After` header on a 429. */
  readonly retryAfterSeconds?: number
  /** Per-field failures from a 400 `validation_failed` body, when the server sent any. */
  readonly details?: ApiFieldError[]
  /**
   * The raw machine-readable `error` string from a non-2xx JSON body that isn't one of the
   * fixed auth shapes above — e.g. the accounting API's `PostingErrorCode`, lower-cased
   * (`"jv_unbalanced"`, `"period_closed"`, `"entry_not_found"` — docs/design/M2/api-contract.md
   * §7). `.code` stays the narrow, auth-only union above so every existing `switch`/`if` on it
   * keeps exhaustiveness; this is a separate, additive field a caller that knows a wider error
   * vocabulary (e.g. the accounting client) can read instead. `undefined` unless the server sent
   * one.
   */
  readonly serverCode?: string
  /**
   * The `details` object from that same body, verbatim (e.g. `{totalDebit, totalCredit}` for
   * `jv_unbalanced`) — JSON-safe by the API contract's own rule that a posting error's details
   * are always string-keyed. `undefined` unless the server sent one.
   */
  readonly serverDetails?: Record<string, unknown>

  constructor(
    code: ApiErrorCode,
    message: string,
    options?: {
      status?: number
      retryAfterSeconds?: number
      details?: ApiFieldError[]
      cause?: unknown
      serverCode?: string
      serverDetails?: Record<string, unknown>
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ApiError'
    this.code = code
    this.status = options?.status
    this.retryAfterSeconds = options?.retryAfterSeconds
    this.details = options?.details
    this.serverCode = options?.serverCode
    this.serverDetails = options?.serverDetails
  }
}
