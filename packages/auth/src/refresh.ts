import { spendRefreshToken } from '@finsoft/database/auth'
import { noopAuthAuditSink, type AuthAuditSink } from './audit-sink.ts'
import { signAccessToken } from './jwt.ts'
import { hashRefreshToken, mintRefreshToken } from './refresh-token.ts'
import { checkLayers, refreshLayers } from './throttle.ts'

/*
 * POST /api/auth/refresh. ADR-0022 (no grace window), ADR-0023 §2, §5.
 */

export interface RefreshInput {
  readonly presentedRefreshToken: string
  readonly ipPrefix: string
  readonly deviceId: string | null
}

export interface RefreshSuccessResult {
  readonly outcome: 'success'
  readonly accessToken: string
  readonly expiresIn: number
  readonly refreshToken: string
  readonly refreshTokenExpiresAt: Date
  readonly user: { readonly id: string; readonly fullName: string; readonly email: string }
  readonly tenant: { readonly id: string; readonly code: string; readonly name: string }
}

export interface RefreshFailedResult {
  readonly outcome: 'failed'
  /** For the caller's own logging/alerting decision — never surfaced to the client (§4 item 4 shape). */
  readonly reason: 'unknown' | 'expired' | 'reused'
}

export interface RefreshThrottledResult {
  readonly outcome: 'throttled'
  readonly retryAfterSeconds: number
}

export type RefreshResult = RefreshSuccessResult | RefreshFailedResult | RefreshThrottledResult

export async function refresh(
  input: RefreshInput,
  auditSink: AuthAuditSink = noopAuthAuditSink,
): Promise<RefreshResult> {
  const presentedTokenHash = hashRefreshToken(input.presentedRefreshToken)

  // Evaluated BEFORE the resolver runs: a Redis outage means
  // auth_lookup.resolve_refresh is never called (ADR-0023 §5, the third
  // D-W1-004 condition). No tenant is known yet, so this keys on the IP
  // prefix and the token's own hash — never on a resolved tenant.
  const throttle = await checkLayers(
    refreshLayers({ ipPrefix: input.ipPrefix, presentedTokenHash }),
  )
  if (throttle.throttled) {
    return { outcome: 'throttled', retryAfterSeconds: throttle.retryAfterSeconds }
  }

  const minted = mintRefreshToken()

  const outcome = await spendRefreshToken({
    presentedTokenHash,
    newTokenHash: minted.hash,
    newTokenExpiresAt: minted.expiresAt,
    deviceId: input.deviceId,
  })

  if (
    outcome.outcome === 'reused' ||
    outcome.outcome === 'expired' ||
    outcome.outcome === 'unknown'
  ) {
    // `outcome.outcome === 'reused'` is where a family was actually revoked
    // (packages/database/src/auth/refresh.ts does that write). Auditing the
    // event itself — with the affected tenant/family ids — is left to M1-D:
    // `RefreshOutcome`'s 'reused' arm carries no tenant here (ADR-0023 §6:
    // "a resolver miss cannot be audited, only logged" covers 'unknown';
    // 'reused' and 'expired' are a narrower gap this lane leaves open rather
    // than threading tenant/family ids through a no-op sink).
    return { outcome: 'failed', reason: outcome.outcome }
  }

  const access = await signAccessToken({
    userId: outcome.user.id,
    tenantId: outcome.tenant.id,
    sessionId: outcome.sessionId,
    permissionVersion: outcome.permissionVersion,
    mfa: false,
  })

  await auditSink.record({
    tenantId: outcome.tenant.id,
    actorUserId: outcome.user.id,
    action: 'REFRESH_ROTATED',
    entityType: 'session',
    entityId: outcome.sessionId,
  })

  return {
    outcome: 'success',
    accessToken: access.token,
    expiresIn: access.expiresIn,
    refreshToken: minted.raw,
    refreshTokenExpiresAt: minted.expiresAt,
    user: outcome.user,
    tenant: outcome.tenant,
  }
}
