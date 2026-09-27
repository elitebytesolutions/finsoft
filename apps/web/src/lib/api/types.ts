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
  | 'forbidden'
  | 'session_expired'
  | 'network_error'
  | 'unknown'

/**
 * Typed error thrown by every function in `client.ts`. Screens branch on `.code`, never on a
 * parsed message string — the message is for display, the code is for control flow.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status?: number
  /** Seconds until a retry may succeed, from the `Retry-After` header on a 429. */
  readonly retryAfterSeconds?: number

  constructor(
    code: ApiErrorCode,
    message: string,
    options?: { status?: number; retryAfterSeconds?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ApiError'
    this.code = code
    this.status = options?.status
    this.retryAfterSeconds = options?.retryAfterSeconds
  }
}
