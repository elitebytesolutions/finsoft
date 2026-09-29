import { Injectable } from '@nestjs/common'
import {
  getJwks,
  login as authLogin,
  logout as authLogout,
  refresh as authRefresh,
  hashRefreshToken,
  noopAuthAuditSink,
  ThrottleUnavailableError,
  type LoginResult,
  type RefreshResult,
} from '@finsoft/auth'
import { getAuthenticatedProfile } from '@finsoft/database/auth'
import { TenantContext, type TenantPrincipal } from '@finsoft/database'
import type { AuthContext } from '@finsoft/shared-types'
import type { JWK } from 'jose'

/*
 * Thin orchestration over `@finsoft/auth`. Every decision (throttle, argon2,
 * token issuance, the atomic spend) lives there or in
 * `@finsoft/database/auth`; this class exists so the controller does not
 * import both packages directly and does not know about `AuthAuditSink`,
 * which is a `packages/auth` concern.
 *
 * A database error caught here is rethrown as a code only (ADR-0023 §6): no
 * `detail`, `hint`, `where` or `constraint` crosses the boundary, and the
 * caller's exception filter never sees a driver error's raw message.
 */
@Injectable()
export class AuthService {
  login(input: Parameters<typeof authLogin>[0]): Promise<LoginResult> {
    return authLogin(input, noopAuthAuditSink)
  }

  refresh(input: Parameters<typeof authRefresh>[0]): Promise<RefreshResult> {
    return authRefresh(input, noopAuthAuditSink)
  }

  logout(auth: AuthContext): Promise<void> {
    return authLogout(
      { tenantId: auth.tenantId, userId: auth.userId, sessionId: auth.sessionId },
      noopAuthAuditSink,
    )
  }

  jwks(): Promise<{ keys: readonly JWK[] }> {
    return getJwks()
  }

  async me(auth: AuthContext): Promise<{
    user: { id: string; email: string; fullName: string }
    tenant: { id: string; code: string; name: string }
    sessionId: string
    permissionVersion: number
  } | null> {
    const principal: TenantPrincipal = { tenantId: auth.tenantId, userId: auth.userId }
    const profile = await TenantContext.run(principal, () => getAuthenticatedProfile(auth.userId))
    if (!profile) return null
    return { ...profile, sessionId: auth.sessionId, permissionVersion: auth.permissionVersion }
  }

  hashRefreshToken(raw: string): string {
    return hashRefreshToken(raw)
  }
}

export { ThrottleUnavailableError }
