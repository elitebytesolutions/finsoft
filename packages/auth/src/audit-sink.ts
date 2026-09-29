import { recordAudit, TenantContext, type TenantTx } from '@finsoft/database'

/*
 * The audit sink for session lifecycle events. Rule 9: every financial
 * mutation writes an append-only audit record in the same transaction as
 * the change. Login/logout/refresh are not financial mutations, but session
 * lifecycle is the kind of thing an incident review needs an authoritative
 * record of, and now that migration 009's `audit_log` exists, there is no
 * reason to settle for a business-event log line instead
 * (`@finsoft/observability`'s own `events.ts` is explicit that a business
 * event is not the audit trail).
 *
 * M1-X (audit wiring). Earlier revisions of this file recorded events AFTER
 * their owning transaction had already committed — which this file's own
 * header used to say could not satisfy rule 9's "in the same transaction",
 * because `packages/auth` holds no `TenantTx` (it does not import Kysely at
 * all — see eslint's `packagesAuthQuerySyntax`). That is still true, and it
 * is why `record` takes the CALLER's own `tx`: `packages/database/src/auth/
 * {login,refresh}.ts` invoke it as a callback from INSIDE their own
 * transactions (login's write transaction, refresh's reuse-detection
 * transaction), the same shape `decide` already uses there. `logout`'s case
 * is simpler and does not go through this interface at all: `revokeSession`
 * (packages/database/src/auth/session.ts) calls `recordAudit` directly,
 * inside its own `withTenant` transaction, because by the time it runs,
 * `TenantContext` is already established by `packages/auth/src/logout.ts`'s
 * own `TenantContext.run` — there is no C2-style restriction on that file
 * the way there is on login.ts/refresh.ts, so no hook needs to cross the
 * boundary there at all.
 */

export interface AuthAuditEvent {
  readonly tenantId: string
  readonly actorUserId: string | null
  readonly action: 'USER_SIGNED_IN' | 'USER_SIGN_IN_FAILED' | 'REFRESH_REUSE_DETECTED'
  /**
   * 'user': M1-X, Council Sec 5 — USER_SIGN_IN_FAILED names its TARGET in
   * entityId (the candidate user, if one existed at that email; null
   * otherwise), never its actor. An unverified credential is not proof of
   * who acted, so actorUserId is always null for this action — see
   * authAuditSink's own note.
   */
  readonly entityType: 'session' | 'refresh_token_family' | 'user'
  readonly entityId: string | null
  /** From the verified request context (trusted-proxy `clientIp`), never re-derived here. */
  readonly ip: string | null
  readonly detail?: Record<string, string | null>
}

export interface AuthAuditSink {
  record(tx: TenantTx, event: AuthAuditEvent): Promise<void>
}

/**
 * TEST/OPT-OUT ONLY. Records nothing. `apps/api`'s production wiring passes
 * `authAuditSink` (below); tests that do not care about the audit trail may
 * keep using this default rather than asserting against real rows.
 */
export const noopAuthAuditSink: AuthAuditSink = {
  async record(): Promise<void> {
    // Intentionally empty. See this file's header.
  },
}

/**
 * The real sink. `recordAudit` requires `TenantContext` to be set (it reads
 * the tenant from there, not from `tx`, so that a caller cannot lie about
 * which tenant it is writing to independently of the transaction's own
 * `app.tenant_id`) — established here, narrowly, for exactly this one
 * write, since `packages/auth` is one of the places `TenantContext.run` may
 * be called (the ESLint rule in `eslint.config.mjs`, M1-X C5).
 *
 * Rule 20 (no secrets, ever): `detail`, if present, is passed straight
 * through to `recordAudit`'s `after_json`, and `assertNoSecretLikeKeys`
 * there rejects a secret-shaped key outright — this sink adds no filtering
 * of its own because none is needed; the writer's own control already
 * covers it.
 */
export const authAuditSink: AuthAuditSink = {
  async record(tx, event): Promise<void> {
    await TenantContext.run({ tenantId: event.tenantId, userId: event.actorUserId }, () =>
      recordAudit(tx, {
        actorUserId: event.actorUserId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        beforeJson: null,
        afterJson: event.detail ?? null,
        ip: event.ip,
        // No request-correlation middleware is wired into apps/api yet
        // (@finsoft/observability's withCorrelation exists but nothing sets
        // it per-request today) — recorded as OBSERVED in the delivery
        // report rather than built here, which is a separate concern.
        requestId: null,
      }),
    )
  },
}
