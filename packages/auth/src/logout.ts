import { revokeSession } from '@finsoft/database/auth'
import { TenantContext } from '@finsoft/database'
import { noopAuthAuditSink, type AuthAuditSink } from './audit-sink.ts'
import { invalidateSessionCache } from './session-cache.ts'

export interface LogoutInput {
  readonly tenantId: string
  readonly userId: string
  readonly sessionId: string
}

/** POST /api/auth/logout. Revokes the session; migration 005's cascade trigger revokes its families. */
export async function logout(
  input: LogoutInput,
  auditSink: AuthAuditSink = noopAuthAuditSink,
): Promise<void> {
  await TenantContext.run({ tenantId: input.tenantId, userId: input.userId }, () =>
    revokeSession(input.sessionId, input.userId, 'USER_LOGOUT'),
  )
  await invalidateSessionCache(input.tenantId, input.sessionId)
  await auditSink.record({
    tenantId: input.tenantId,
    actorUserId: input.userId,
    action: 'LOGOUT',
    entityType: 'session',
    entityId: input.sessionId,
  })
}
