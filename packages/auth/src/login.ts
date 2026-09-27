import { withLoginAttempt } from '@finsoft/database/auth'
import { noopAuthAuditSink, type AuthAuditSink } from './audit-sink.ts'
import { atAuthBoundary } from './db-error.ts'
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from './jwt.ts'
import { verifyCredential } from './password.ts'
import { mintRefreshToken } from './refresh-token.ts'
import { checkLayers, loginLayers } from './throttle.ts'

/*
 * POST /api/auth/login. ADR-0023 §1, §4.
 *
 * The tenant code, email and password have already been validated and
 * normalised (uppercase code, lowercase-trimmed email) by the zod schema at
 * the api boundary — this function trusts its input in that one sense, but
 * still normalises defensively so a future caller cannot reintroduce a
 * `Victim@x.com` / `victim@x.com` budget split by skipping the DTO.
 */

export interface LoginInput {
  readonly tenantCode: string
  readonly email: string
  readonly password: string
  readonly ip: string
  readonly ipPrefix: string
  readonly deviceId: string | null
  readonly userAgent: string | null
}

export interface LoginSuccessResult {
  readonly outcome: 'success'
  readonly accessToken: string
  readonly expiresIn: number
  readonly refreshToken: string
  /** Computed by PostgreSQL, never by this process's own clock. See B5. */
  readonly refreshTokenExpiresAt: Date
  readonly user: { readonly id: string; readonly fullName: string; readonly email: string }
  readonly tenant: { readonly id: string; readonly code: string; readonly name: string }
  /** ADR-0023 §5 layer 4 (global): non-blocking, reported here for the caller to log/alert on. */
  readonly alertedLayers: readonly string[]
}

export interface LoginFailedResult {
  readonly outcome: 'failed'
  readonly alertedLayers: readonly string[]
}

export interface LoginThrottledResult {
  readonly outcome: 'throttled'
  readonly retryAfterSeconds: number
  readonly alertedLayers: readonly string[]
}

export type LoginResult = LoginSuccessResult | LoginFailedResult | LoginThrottledResult

export async function login(
  input: LoginInput,
  auditSink: AuthAuditSink = noopAuthAuditSink,
): Promise<LoginResult> {
  const normalisedEmail = input.email.trim().toLowerCase()
  const normalisedTenantCode = input.tenantCode.trim().toUpperCase()

  // Evaluated BEFORE the resolver ever runs (ADR-0023 §5): a Redis outage
  // means the pre-tenant lookup is never reached. ThrottleUnavailableError
  // propagates to the caller, which maps it to 503 — this function never
  // treats "the limiter is down" as "not throttled".
  const throttle = await checkLayers(
    loginLayers({ normalisedEmail, normalisedTenantCode, ipPrefix: input.ipPrefix }),
  )
  if (throttle.throttled) {
    return {
      outcome: 'throttled',
      retryAfterSeconds: throttle.retryAfterSeconds,
      alertedLayers: throttle.alertedLayers,
    }
  }

  const minted = mintRefreshToken()

  // ADR-0023 §6: any driver error from here on is caught and rethrown
  // carrying only a SQLSTATE code — never detail, hint, table or constraint.
  const attempt = await atAuthBoundary(() =>
    withLoginAttempt(normalisedTenantCode, normalisedEmail, async (candidate) => {
      // Exactly one verification, on every path inside the envelope, BEFORE
      // any status is evaluated (ADR-0023 §4 items 1 and 3). `?? null` covers
      // both "no user" and "user exists but has no password_hash yet".
      const verified = await verifyCredential(candidate.user?.passwordHash ?? null, input.password)

      const eligible =
        candidate.user !== null &&
        candidate.user.status === 'ACTIVE' &&
        candidate.tenant.status === 'ACTIVE' &&
        verified

      if (!eligible) return { authenticate: false }

      return {
        authenticate: true,
        deviceId: input.deviceId,
        ip: input.ip,
        userAgent: input.userAgent,
        refreshTokenHash: minted.hash,
      }
    }),
  )

  if (attempt === null) {
    // Unknown tenant code: the transaction never ran `decide`, so the one
    // mandatory verification happens here instead, against the decoy —
    // never zero verifications on any path (ADR-0023 §4 item 1).
    await verifyCredential(null, input.password)
    return { outcome: 'failed', alertedLayers: throttle.alertedLayers }
  }

  if (!attempt.authenticated) {
    return { outcome: 'failed', alertedLayers: throttle.alertedLayers }
  }

  const access = await signAccessToken({
    userId: attempt.user.id,
    tenantId: attempt.tenant.id,
    sessionId: attempt.sessionId,
    permissionVersion: attempt.permissionVersion,
    mfa: false,
  })

  await auditSink.record({
    tenantId: attempt.tenant.id,
    actorUserId: attempt.user.id,
    action: 'LOGIN_SUCCEEDED',
    entityType: 'session',
    entityId: attempt.sessionId,
  })

  return {
    outcome: 'success',
    accessToken: access.token,
    expiresIn: access.expiresIn,
    refreshToken: minted.raw,
    refreshTokenExpiresAt: attempt.refreshTokenExpiresAt,
    user: attempt.user,
    tenant: attempt.tenant,
    alertedLayers: throttle.alertedLayers,
  }
}

export { ACCESS_TOKEN_TTL_SECONDS }
