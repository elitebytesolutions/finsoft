import { spendRefreshToken } from '@finsoft/database/auth'
import { noopAuthAuditSink, type AuthAuditSink } from './audit-sink.ts'
import { atAuthBoundary } from './db-error.ts'
import { signAccessToken } from './jwt.ts'
import { hashRefreshToken, mintRefreshToken } from './refresh-token.ts'
import { invalidateSessionCache } from './session-cache.ts'
import { checkLayers, refreshLayers } from './throttle.ts'

/*
 * POST /api/auth/refresh. ADR-0022 (no grace window), ADR-0023 §2, §5, §6.
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
  /** Computed by PostgreSQL, never by this process's own clock. See B5. */
  readonly refreshTokenExpiresAt: Date
  readonly user: { readonly id: string; readonly fullName: string; readonly email: string }
  readonly tenant: { readonly id: string; readonly code: string; readonly name: string }
}

export interface RefreshFailedResult {
  readonly outcome: 'failed'
  /** For the caller's own logging/alerting decision — never surfaced to the client (§4 item 4 shape). */
  readonly reason: 'unknown' | 'expired' | 'reused' | 'inactive'
  /**
   * Present only when `reason === 'reused'`. Ids only — never a hash, a raw
   * token, or any other credential-shaped value — so the caller (apps/api)
   * can log a REFRESH_REUSE_DETECTED business event and M1-D's audit sink
   * only has to wire itself to something that already carries what it needs.
   */
  readonly reuse?: {
    readonly tenantId: string
    readonly familyId: string
    readonly sessionId: string
  }
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

  // newTokenExpiresAt is NOT passed: the database computes it (B5) so it can
  // never disagree with the clock migration 005's rt_lifetime_ceiling CHECK
  // measures issued_at against. ADR-0023 §6: any driver error is caught and
  // rethrown carrying only a SQLSTATE code.
  const outcome = await atAuthBoundary(() =>
    spendRefreshToken({
      presentedTokenHash,
      newTokenHash: minted.hash,
      deviceId: input.deviceId,
    }),
  )

  if (outcome.outcome === 'reused') {
    // B2: the family AND the session were already revoked, in the same
    // transaction, by packages/database/src/auth/refresh.ts. The Redis
    // session-active cache still has to be told directly — it is a cache,
    // not a view of the database, and its TTL (15s) is the only thing that
    // would otherwise catch this.
    await invalidateSessionCache(outcome.tenantId, outcome.sessionId)
    return {
      outcome: 'failed',
      reason: 'reused',
      reuse: {
        tenantId: outcome.tenantId,
        familyId: outcome.familyId,
        sessionId: outcome.sessionId,
      },
    }
  }

  if (
    outcome.outcome === 'expired' ||
    outcome.outcome === 'unknown' ||
    outcome.outcome === 'inactive'
  ) {
    // ADR-0023 §6: 'unknown' (a resolver miss) cannot be audited, only
    // logged — there is no tenant to attach a row to. 'expired' and
    // 'inactive' are ordinary, unremarkable refresh failures.
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
    refreshTokenExpiresAt: outcome.refreshTokenExpiresAt,
    user: outcome.user,
    tenant: outcome.tenant,
  }
}
