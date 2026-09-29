import type { AuthContext } from '@finsoft/shared-types'
import { getAccountStateCached } from './account-state-cache.ts'
import { TokenVerificationError, verifyAccessToken } from './jwt.ts'
import { isSessionActiveCached } from './session-cache.ts'

/*
 * The verification the `TenantGuard` in apps/api delegates to.
 *
 * `tenantId`, `userId`, `sessionId` and `permissionVersion` all come from the
 * VERIFIED claim only — never from a header, body, query string or path
 * parameter (rule 8, ADR-0009:84). The caller (the guard) must not read any
 * of those from the request; this function is the only source.
 */

export class SessionInactiveError extends Error {
  constructor() {
    super('Session is not active.')
    this.name = 'SessionInactiveError'
  }
}

/**
 * M1-X, L1. The user or the tenant is no longer ACTIVE. Checked on every
 * request, not only at login/refresh — a suspension must take effect before
 * the access token's own 15-minute expiry, not after it.
 */
export class AccountInactiveError extends Error {
  constructor() {
    super('The user or the tenant is not active.')
    this.name = 'AccountInactiveError'
  }
}

/**
 * M1-X, L1. `perm_ver` on the token is behind `users.version` right now — a
 * role or permission grant changed after this token was minted. ADR-0009:
 * "a privilege reduction takes effect on the next request." The caller must
 * refresh (which always mints from the current version) or, if the refresh
 * token is also gone, re-authenticate.
 */
export class PermissionVersionStaleError extends Error {
  constructor() {
    super("The access token's permission version is behind the account's current version.")
    this.name = 'PermissionVersionStaleError'
  }
}

export { TokenVerificationError }

export async function verifyBearerToken(token: string): Promise<AuthContext> {
  const claims = await verifyAccessToken(token)

  const active = await isSessionActiveCached(claims.tenantId, claims.userId, claims.sessionId)
  if (!active) {
    throw new SessionInactiveError()
  }

  const state = await getAccountStateCached(claims.tenantId, claims.userId)
  if (!state || state.userStatus !== 'ACTIVE' || state.tenantStatus !== 'ACTIVE') {
    throw new AccountInactiveError()
  }
  if (claims.permissionVersion < state.permissionVersion) {
    throw new PermissionVersionStaleError()
  }

  return {
    userId: claims.userId,
    tenantId: claims.tenantId,
    sessionId: claims.sessionId,
    permissionVersion: claims.permissionVersion,
    mfa: claims.mfa,
  }
}
