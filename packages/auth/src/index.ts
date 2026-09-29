/*
 * @finsoft/auth — session, JWT issuing and verification, refresh-token
 * rotation with reuse detection (ADR-0009), argon2id password hashing and
 * verification (ADR-0023 §4), and Redis-backed throttling (ADR-0023 §5).
 *
 * No query construction here (dependency-cruiser's `kysely-is-allowlisted`,
 * enforced additionally by an eslint rule scoped to this package —
 * eslint.config.mjs's `packagesAuthQuerySyntax`): every persistence
 * operation is a named export of `@finsoft/database/auth`, called with a
 * pure decision callback where one is needed.
 */

export {
  login,
  ACCESS_TOKEN_TTL_SECONDS,
  failedLoginAuditWorkCountForTests,
  resetFailedLoginAuditWorkCountForTests,
  failedLoginAuditSuppressionEventCountForTests,
  resetFailedLoginAuditSuppressionEventCountForTests,
} from './login.ts'
export type {
  LoginInput,
  LoginResult,
  LoginSuccessResult,
  LoginFailedResult,
  LoginThrottledResult,
} from './login.ts'

export { refresh } from './refresh.ts'
export type {
  RefreshInput,
  RefreshResult,
  RefreshSuccessResult,
  RefreshFailedResult,
  RefreshThrottledResult,
} from './refresh.ts'

export { logout } from './logout.ts'
export type { LogoutInput } from './logout.ts'

export {
  getJwks,
  verifyAccessToken,
  TokenVerificationError,
  resetKeySetForTests,
  preloadJwtKeys,
} from './jwt.ts'
export type { AccessTokenClaims, VerifiedAccessToken, SignedAccessToken } from './jwt.ts'

export {
  verifyBearerToken,
  AccountInactiveError,
  PermissionVersionStaleError,
  SessionInactiveError,
} from './guard.ts'

export {
  hashPassword,
  verifyCredential,
  verificationCountForTests,
  resetVerificationCountForTests,
  HashingQueueFullError,
} from './password.ts'

export { hashRefreshToken, mintRefreshToken, REFRESH_TOKEN_TTL_MS } from './refresh-token.ts'
export type { MintedRefreshToken } from './refresh-token.ts'

export { ThrottleUnavailableError, checkLayers, closeThrottleClient } from './throttle.ts'
export type { ThrottleDecision, ThrottleLayer } from './throttle.ts'

export { closeSessionCacheClient, invalidateSessionCache } from './session-cache.ts'

export {
  closeAccountStateCacheClient,
  getAccountStateCached,
  invalidateAccountStateCache,
} from './account-state-cache.ts'

export { authAuditSink, noopAuthAuditSink } from './audit-sink.ts'
export type { AuthAuditEvent, AuthAuditSink } from './audit-sink.ts'

export { atAuthBoundary, SanitisedDatabaseError } from './db-error.ts'
