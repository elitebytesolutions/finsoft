import { decoyAuditRoundTrip, withLoginAttempt, type LoginTestHooks } from '@finsoft/database/auth'
import { logCommittedBusinessEvent } from '@finsoft/observability'
import { noopAuthAuditSink, type AuthAuditSink } from './audit-sink.ts'
import { atAuthBoundary } from './db-error.ts'
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from './jwt.ts'
import { HashingQueueFullError, verifyCredential } from './password.ts'
import { mintRefreshToken } from './refresh-token.ts'
import {
  checkLayers,
  failedLoginAuditLayer,
  loginLayers,
  refundLayers,
  shouldMarkFailedLoginAuditSuppression,
} from './throttle.ts'

/*
 * M1-X, Council Sec 5: a counter mirroring password.ts's
 * verificationCountForTests — proof, by counting rather than by timing
 * (flaky), that some audit-shaped DB round trip happens on EVERY login
 * attempt that reaches the point of deciding success or failure: the real
 * one on a known tenant, the decoy on an unknown one. See decoyAuditRoundTrip's
 * own doc comment for what this does and does not equalise.
 */
let failedLoginAuditWorkCount = 0

/** TEST ONLY. */
export function failedLoginAuditWorkCountForTests(): number {
  return failedLoginAuditWorkCount
}

/** TEST ONLY. */
export function resetFailedLoginAuditWorkCountForTests(): void {
  failedLoginAuditWorkCount = 0
}

/*
 * M1-X, Council re-review item 4 (Sec F5): counts every FAILED_LOGIN_AUDIT_SUPPRESSED
 * business event actually logged — one per suppressed attempt, regardless of
 * whether that attempt also won the one-marker-per-window race. Proves "never
 * drop silently" by counting, the same discipline failedLoginAuditWorkCount
 * above already uses.
 */
let failedLoginAuditSuppressionEventCount = 0

/** TEST ONLY. */
export function failedLoginAuditSuppressionEventCountForTests(): number {
  return failedLoginAuditSuppressionEventCount
}

/** TEST ONLY. */
export function resetFailedLoginAuditSuppressionEventCountForTests(): void {
  failedLoginAuditSuppressionEventCount = 0
}

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
  /**
   * TEST ONLY (item 1c, security re-review 2026-09-27). Forwarded verbatim
   * to `withLoginAttempt`'s `beforeWrite` hook — see its own doc comment.
   * Never set by production code (the controller never passes a third
   * argument).
   */
  testHooks?: LoginTestHooks,
): Promise<LoginResult> {
  const normalisedEmail = input.email.trim().toLowerCase()
  const normalisedTenantCode = input.tenantCode.trim().toUpperCase()

  // Evaluated BEFORE the resolver ever runs (ADR-0023 §5): a Redis outage
  // means the pre-tenant lookup is never reached. ThrottleUnavailableError
  // propagates to the caller, which maps it to 503 — this function never
  // treats "the limiter is down" as "not throttled".
  const layers = loginLayers({ normalisedEmail, normalisedTenantCode, ipPrefix: input.ipPrefix })
  const throttle = await checkLayers(layers)
  if (throttle.throttled) {
    return {
      outcome: 'throttled',
      retryAfterSeconds: throttle.retryAfterSeconds,
      alertedLayers: throttle.alertedLayers,
    }
  }

  const minted = mintRefreshToken()

  // M1-X, Council re-review item 4 (Sec F5): set inside the onOutcome hook
  // below when failedLoginAuditLayer's cap is exhausted, and read AFTER the
  // transaction has committed (logCommittedBusinessEvent's own contract:
  // never call it from inside a transaction that might still roll back).
  let auditSuppressedForTenantId: string | null = null

  try {
    // ADR-0023 §6: any driver error from here on is caught and rethrown
    // carrying only a SQLSTATE code — never detail, hint, table or constraint.
    const attempt = await atAuthBoundary(() =>
      withLoginAttempt(
        normalisedTenantCode,
        normalisedEmail,
        async (candidate) => {
          // Exactly one verification, on every path inside the envelope,
          // BEFORE any status is evaluated (ADR-0023 §4 items 1 and 3).
          // `?? null` covers both "no user" and "user exists but has no
          // password_hash yet".
          const storedHash = candidate.user?.passwordHash ?? null
          const verified = await verifyCredential(storedHash, input.password)

          const eligible =
            candidate.user !== null &&
            candidate.user.status === 'ACTIVE' &&
            candidate.tenant.status === 'ACTIVE' &&
            verified

          if (!eligible) return { authenticate: false }

          // `verified` can only be true when storedHash is non-null (see
          // verifyCredential: a null stored hash always verifies against
          // the decoy and returns false) — safe to assert here.
          return {
            authenticate: true,
            deviceId: input.deviceId,
            ip: input.ip,
            userAgent: input.userAgent,
            refreshTokenHash: minted.hash,
            verifiedPasswordHash: storedHash as string,
          }
        },
        // M1-X (audit wiring): called from INSIDE whichever transaction
        // decided the outcome — never after this function returns. rule 9.
        async (tx, outcome) => {
          if (outcome.authenticated) {
            await auditSink.record(tx, {
              tenantId: outcome.tenantId,
              actorUserId: outcome.userId,
              action: 'USER_SIGNED_IN',
              entityType: 'session',
              entityId: outcome.sessionId,
              ip: input.ip,
            })
            return
          }

          failedLoginAuditWorkCount += 1

          // M1-X, Council Sec 5: bounds the audit chain's per-tenant advisory
          // lock contention a flood of wrong passwords against a KNOWN
          // tenant can cause — never the login response itself, which 401s
          // identically either way (ADR-0023 §4 item 4). Fails OPEN (writes
          // the audit anyway) if Redis is unreachable: this is a
          // defence-in-depth cap on a side effect, not the login's own
          // fail-closed throttle, and the outer layers already succeeded
          // moments ago for this same request.
          const budgetExhausted = await checkLayers([failedLoginAuditLayer(normalisedTenantCode)])
            .then((decision) => decision.throttled)
            .catch(() => false)
          if (budgetExhausted) {
            // M1-X, Council re-review item 4: never drop silently. Every
            // suppressed attempt is reported (the business event, logged
            // after commit below) — but only the FIRST one in this tenant's
            // current cap window also gets a marker audit row, so the audit
            // chain still gets exactly one evidentiary record of the
            // suppression itself, never one per suppressed attempt (which
            // would recreate the exact contention problem this cap exists
            // to bound).
            auditSuppressedForTenantId = outcome.tenantId
            const shouldMark = await shouldMarkFailedLoginAuditSuppression(
              normalisedTenantCode,
            ).catch(() => false)
            if (shouldMark) {
              await auditSink.record(tx, {
                tenantId: outcome.tenantId,
                actorUserId: null,
                action: 'FAILED_LOGIN_AUDIT_SUPPRESSED',
                entityType: 'tenant',
                entityId: outcome.tenantId,
                ip: input.ip,
              })
            }
            return
          }

          // actorUserId is ALWAYS null here — an unverified credential is
          // not proof of who acted (Council Sec 5). The candidate user, if
          // one existed at that email, is the audited EVENT'S TARGET, named
          // in entityId, never in actorUserId.
          await auditSink.record(tx, {
            tenantId: outcome.tenantId,
            actorUserId: null,
            action: 'USER_SIGN_IN_FAILED',
            entityType: 'user',
            entityId: outcome.userId,
            ip: input.ip,
          })
        },
        testHooks,
      ),
    )

    // M1-X, Council re-review item 4: logged here, AFTER atAuthBoundary has
    // returned — i.e. after the transaction that decided this has committed
    // — never from inside the onOutcome hook above (logCommittedBusinessEvent's
    // own contract). Every suppressed attempt gets this event, independent
    // of whether it also won the one-marker-per-window race above.
    if (auditSuppressedForTenantId !== null) {
      failedLoginAuditSuppressionEventCount += 1
      logCommittedBusinessEvent({
        event: 'FAILED_LOGIN_AUDIT_SUPPRESSED',
        entityType: 'tenant',
        entityId: auditSuppressedForTenantId,
        detail: {
          tenantCode: normalisedTenantCode,
          windowSeconds: failedLoginAuditLayer(normalisedTenantCode).windowSeconds,
        },
      })
    }

    if (attempt === null) {
      // Unknown tenant code: the transaction never ran `decide`, so the one
      // mandatory verification happens here instead, against the decoy —
      // never zero verifications on any path (ADR-0023 §4 item 1). Also runs
      // decoyAuditRoundTrip — see its own doc comment (Council Sec 5): a
      // known tenant's failure does extra DB work writing USER_SIGN_IN_FAILED,
      // and doing NONE here would make that extra work a timing signal
      // distinguishing a known tenant code from an unknown one.
      await verifyCredential(null, input.password)
      failedLoginAuditWorkCount += 1
      await decoyAuditRoundTrip()
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

    // USER_SIGNED_IN was already written inside the write transaction, via
    // the onOutcome hook passed to withLoginAttempt above — not here, and
    // not after the fact (rule 9: "in the same transaction as the change").

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
  } catch (error) {
    if (error instanceof HashingQueueFullError) {
      // Item 1d: a full hashing queue is a capacity problem, not something
      // the account did. Give back the account-keyed budget this request
      // already spent before the queue was found to be full.
      await refundLayers(layers)
    }
    throw error
  }
}

export { ACCESS_TOKEN_TTL_SECONDS }
