import type { AuthContext } from '@finsoft/shared-types'
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

export { TokenVerificationError }

export async function verifyBearerToken(token: string): Promise<AuthContext> {
  const claims = await verifyAccessToken(token)

  const active = await isSessionActiveCached(claims.tenantId, claims.userId, claims.sessionId)
  if (!active) {
    throw new SessionInactiveError()
  }

  return {
    userId: claims.userId,
    tenantId: claims.tenantId,
    sessionId: claims.sessionId,
    permissionVersion: claims.permissionVersion,
    mfa: claims.mfa,
  }
}
