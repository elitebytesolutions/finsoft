import { revokeSession } from '@finsoft/database/auth'
import { TenantContext } from '@finsoft/database'
import { invalidateSessionCache } from './session-cache.ts'

export interface LogoutInput {
  readonly tenantId: string
  readonly userId: string
  readonly sessionId: string
  /** From the verified request context (trusted-proxy `clientIp`). M1-X (audit wiring). */
  readonly ip?: string | null
}

/**
 * POST /api/auth/logout. Revokes the session; migration 005's cascade
 * trigger revokes its families.
 *
 * M1-X (audit wiring): USER_SIGNED_OUT is written by `revokeSession` itself,
 * inside its own transaction — not by this function after the fact. This is
 * the one auth audit event that does not go through `AuthAuditSink`; see
 * `revokeSession`'s own header for why.
 */
export async function logout(input: LogoutInput): Promise<void> {
  await TenantContext.run({ tenantId: input.tenantId, userId: input.userId }, () =>
    revokeSession(input.sessionId, input.userId, 'USER_LOGOUT', input.ip ?? null),
  )
  await invalidateSessionCache(input.tenantId, input.sessionId)
}
