import { Injectable } from '@nestjs/common'
import {
  authAuditSink,
  getJwks,
  login as authLogin,
  logout as authLogout,
  refresh as authRefresh,
  hashRefreshToken,
  ThrottleUnavailableError,
  type LoginResult,
  type RefreshResult,
} from '@finsoft/auth'
import { getAuthenticatedProfile } from '@finsoft/database/auth'
import type { AuthContext } from '@finsoft/shared-types'
import type { JWK } from 'jose'

/*
 * Thin orchestration over `@finsoft/auth`. Every decision (throttle, argon2,
 * token issuance, the atomic spend) lives there or in
 * `@finsoft/database/auth`; this class exists so the controller does not
 * import both packages directly.
 *
 * `authAuditSink` (M1-X) is the real, DB-backed implementation — not the
 * no-op default. Rule 9's audit rows are written by `packages/auth` and
 * `@finsoft/database/auth` from INSIDE their own transactions; this
 * service's only job regarding it is choosing which implementation the
 * production wiring uses.
 *
 * A database error caught here is rethrown as a code only (ADR-0023 §6): no
 * `detail`, `hint`, `where` or `constraint` crosses the boundary, and the
 * caller's exception filter never sees a driver error's raw message.
 */
@Injectable()
export class AuthService {
  login(input: Parameters<typeof authLogin>[0]): Promise<LoginResult> {
    return authLogin(input, authAuditSink)
  }

  refresh(input: Parameters<typeof authRefresh>[0]): Promise<RefreshResult> {
    return authRefresh(input, authAuditSink)
  }

  logout(auth: AuthContext, ip: string | null): Promise<void> {
    return authLogout({
      tenantId: auth.tenantId,
      userId: auth.userId,
      sessionId: auth.sessionId,
      ip,
    })
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
    /*
     * M1-X, C5: no TenantContext.run here. TenantContextInterceptor already
     * established the request-wide tenant scope, from the same req.auth,
     * before this method's handler ran — re-establishing it here would be
     * redundant (apps/api never calls TenantContext.run directly; see the
     * ESLint rule in eslint.config.mjs).
     */
    const profile = await getAuthenticatedProfile(auth.userId)
    if (!profile) return null
    return { ...profile, sessionId: auth.sessionId, permissionVersion: auth.permissionVersion }
  }

  hashRefreshToken(raw: string): string {
    return hashRefreshToken(raw)
  }
}

export { ThrottleUnavailableError }
