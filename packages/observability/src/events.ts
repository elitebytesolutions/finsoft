/*
 * Business events.
 *
 * IMPLEMENTATION.md's Definition of Done requires "structured logging added for
 * business events". This file establishes the convention. It deliberately does
 * NOT emit any: `SALE_POSTED` is logged by the sales module when a sale
 * actually posts, in Wave 5. An event emitted from a package that cannot post
 * anything would be a line that says something happened when nothing did.
 *
 * ── These are not the audit trail ─────────────────────────────────────────
 *
 * This is the distinction that matters, and getting it wrong is how a system
 * ends up unable to answer a regulator.
 *
 *   audit_log (rule 9)              business event log (here)
 *   ─────────────────────           ──────────────────────────
 *   PostgreSQL, append-only         stdout → aggregator
 *   in the posting transaction      after the transaction commits
 *   hash-chained, tamper-evident    unordered, best-effort
 *   before/after row images         a summary line
 *   retention set by statute        retention set by disk and cost
 *   THE financial record            an operational convenience
 *
 * A log line can be lost to a full disk, a dropped connection, a crashed
 * sidecar or a sampling rule, and none of those is a bug in the log pipeline —
 * they are its normal operating envelope. The audit record cannot be lost,
 * because it commits in the same transaction as the money.
 *
 * So: never satisfy an audit requirement by logging. If a fact must survive,
 * it goes in `audit_log` inside the transaction. This file is for the on-call
 * engineer at 3am, not for the auditor in March.
 */

import { getLogger } from './logger.ts'
import { redact } from './redact.ts'

/*
 * Naming convention: ENTITY_PAST_TENSE, SCREAMING_SNAKE_CASE.
 *
 * Past tense because an event records something that HAS happened. `SALE_POST`
 * or `POST_SALE` reads like a command, and a command name invites emission
 * before the thing is done — which is the failure this whole file is arranged
 * to prevent.
 */
const EVENT_NAME_PATTERN = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/

/**
 * The event catalogue, extended by each module as it lands.
 *
 * Intentionally sparse. Adding a name here is free; emitting it before the
 * operation exists is not, so a name appears only with the code that raises it.
 * ADR-0005's financial events are the source for the posting-related names.
 */
export const BUSINESS_EVENTS = {
  /* Wave 1 — authentication and tenancy exist before any posting does. */
  USER_SIGNED_IN: 'USER_SIGNED_IN',
  USER_SIGNED_OUT: 'USER_SIGNED_OUT',
  USER_SIGN_IN_FAILED: 'USER_SIGN_IN_FAILED',
  TENANT_CREATED: 'TENANT_CREATED',
  /*
   * M1-X, Council re-review item 4 (Sec F5). Raised every time a failed
   * login's audit write is suppressed by failedLoginAuditLayer's per-tenant
   * cap (packages/auth/src/throttle.ts) — the login itself still 401s
   * identically either way; only the audit_log write is skipped. Emitted so
   * a sustained attack against a tenant's login is visible to an on-call
   * engineer even in the window where the audit chain itself has
   * deliberately stopped recording every attempt.
   */
  FAILED_LOGIN_AUDIT_SUPPRESSED: 'FAILED_LOGIN_AUDIT_SUPPRESSED',
} as const

export type BusinessEventName =
  (typeof BUSINESS_EVENTS)[keyof typeof BUSINESS_EVENTS] | (string & {})

export interface BusinessEvent {
  /** ENTITY_PAST_TENSE. Validated — a malformed name throws. */
  readonly event: BusinessEventName
  /**
   * The entity the event is about. Ids only, never row contents: a log line is
   * not a replica of the record, and `before_json`/`after_json` belong in
   * `audit_log` where they are hash-chained.
   */
  readonly entityType?: string
  readonly entityId?: string
  /** Anything else worth having at 3am. Redacted like every other log object. */
  readonly detail?: Record<string, unknown>
}

/**
 * Logs a business event that has **already committed**.
 *
 * The contract is in the name and it is not decorative. Call this after the
 * transaction commits, never inside it:
 *
 *   ✗  await db.transaction(async (tx) => {
 *        await postingEngine.post({ event: 'SALE_POSTED', … }, tx)
 *        logCommittedBusinessEvent({ event: 'SALE_POSTED', … })   // may roll back
 *      })
 *
 *   ✓  const sale = await db.transaction(async (tx) => { … })
 *      logCommittedBusinessEvent({ event: 'SALE_POSTED', entityId: sale.id })
 *
 * Logging inside the transaction produces a line claiming a sale posted when
 * the transaction may still roll back — and a rollback cannot retract a line
 * that has already been flushed to stdout. The result is an operational log
 * that disagrees with the ledger, which is worse than no log at all, because
 * someone will trust it during an incident.
 *
 * Tenant, user, request and session correlation are attached automatically by
 * the logger's mixin (context.ts) and must not be passed here.
 */
export function logCommittedBusinessEvent(event: BusinessEvent): void {
  if (!EVENT_NAME_PATTERN.test(event.event)) {
    throw new Error(
      `Business event name "${event.event}" must be ENTITY_PAST_TENSE in ` +
        'SCREAMING_SNAKE_CASE, for example SALE_POSTED.',
    )
  }

  getLogger().info(
    {
      kind: 'business_event',
      event: event.event,
      entityType: event.entityType,
      entityId: event.entityId,
      ...(event.detail ? { detail: redact(event.detail) } : {}),
    },
    event.event,
  )
}
