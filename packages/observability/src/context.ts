/*
 * Correlation context.
 *
 * INFRASTRUCTURE §8 requires traces correlated across api and worker by
 * `request_id`. Threading that through every function signature does not
 * survive contact with a real codebase — someone forgets, and the one log line
 * that mattered is the orphan. `AsyncLocalStorage` carries it instead: it is
 * set once at the edge and every log line inside that async tree picks it up.
 *
 * ── On session identifiers ────────────────────────────────────────────────
 *
 * A correlation context needs to distinguish one signed-in session from
 * another, and the obvious field to use is the session id. It must not be.
 * The raw session id is a BEARER CREDENTIAL — whoever holds it can resume the
 * session — so logging it hands anyone with log access the ability to
 * impersonate a user, and logs are aggregated, replicated, backed up and read
 * by support.
 *
 * So the two requirements collide only if they are read carelessly. The
 * resolution is a separate, explicitly approved, NON-SECRET identifier:
 *
 *     sessionCorrelationId   minted per session, stored beside it,
 *                            useless for authentication, safe to log
 *
 * It answers "were these two requests the same session?" — which is what the
 * correlation requirement actually needs — and answers nothing else. It is the
 * only session-shaped value this package will emit, and redact.ts allow-lists
 * it by name while denying every other session field.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/*
 * Branded so a raw session id cannot be passed where a correlation id is
 * expected. A plain `string` field would have been assignable from
 * `session.id`, and the rule would then rest on everyone remembering it.
 */
declare const sessionCorrelationBrand: unique symbol
export type SessionCorrelationId = string & { readonly [sessionCorrelationBrand]: true }

/**
 * Mints a correlation id for a new session.
 *
 * Called once, where the session is created, and stored alongside it. It is
 * random and carries no information about the session it belongs to — deriving
 * it from the session id (a hash, a prefix) would make it a weakened copy of a
 * credential rather than an independent label.
 */
export function newSessionCorrelationId(): SessionCorrelationId {
  return `scid_${randomUUID().replaceAll('-', '')}` as SessionCorrelationId
}

/** The one format this module mints and the only one it will accept. */
const SESSION_CORRELATION_ID = /^scid_[0-9a-f]{32}$/

/**
 * Asserts that a stored value is a correlation id.
 *
 * The only sanctioned way to get a `SessionCorrelationId` from persistence.
 *
 * THE `scid_` PREFIX IS WHAT MAKES THIS GUARD MEAN ANYTHING, and closing
 * ADR-0016 debt D8 is what it is for. An earlier version validated UUID
 * *shape* — but a raw session id is also a UUID, so the guard could not tell
 * a correlation id from the credential it exists to replace, and would have
 * accepted the session id routed here by mistake. That is the one error it
 * was written to catch. A prefix this module never mints for anything else is
 * a value it can refuse.
 *
 * Migration 005 already ships the storage half:
 * `sessions.session_correlation_id` carries
 * `DEFAULT ('scid_' || replace(gen_random_uuid()::text, '-', ''))`, a
 * `sessions_scid_shape` CHECK, and no INSERT grant on the column — so
 * `finsoft_app` cannot name it and the DEFAULT is the only path to a value.
 * This function is the read half of that same change.
 */
export function asSessionCorrelationId(value: string): SessionCorrelationId {
  if (!SESSION_CORRELATION_ID.test(value)) {
    throw new Error(
      'sessionCorrelationId must match scid_<32 hex> and be minted by ' +
        'newSessionCorrelationId(). A raw session id must never be used here — ' +
        'a bare UUID is exactly what this guard exists to refuse.',
    )
  }
  return value as SessionCorrelationId
}

export interface CorrelationContext {
  /** Correlates one inbound request across api, worker and outbox. */
  readonly requestId: string
  /** Present once the request is authenticated. Never from a header or body. */
  readonly tenantId?: string
  readonly userId?: string
  /** The approved non-secret session label. NEVER the session id itself. */
  readonly sessionCorrelationId?: SessionCorrelationId
  /** Set on the worker side: which job produced this line. */
  readonly jobName?: string
  /**
   * The caller's address, as resolved by the one trusted-proxy-aware
   * extraction (`clientIp`, apps/api/src/auth/request-context.ts) — never a
   * raw header read a second time. Set at the edge, alongside `requestId`,
   * by apps/api/src/correlation/request-correlation.middleware.ts. M1-C.
   *
   * CARRIED HERE SOLELY SO `packages/database`'s `recordAudit` CAN DEFAULT
   * AN AUDIT ROW'S `ip` COLUMN FROM IT — it is NOT a general-purpose
   * correlation field and NEVER appears in a log line: `logger.ts`'s
   * `mixin()` explicitly strips it before spreading the context into the
   * merge object (Architecture seat condition on M1-C). An IP address is
   * personal data; writing one append-only audit column per event is a
   * decision this codebase already made (ADR-0020), but broadcasting it
   * onto every log line for the life of a request is a data-protection
   * policy question ADR-0016's redaction layers were never built to answer,
   * and this field must not smuggle that decision in by accident.
   *
   * Undefined for a job or another system-originated event: there is no
   * client to attribute an address to, and nothing here may invent one —
   * `recordAudit` treats an absent `ip` (here or on its own caller's
   * explicit input) as `null`, never as a value to guess.
   *
   * Deliberately the RAW textual form, not the canonicalised one
   * `packages/database/src/audit/ip.ts`'s `normalizeIp` produces — this
   * package cannot depend on `packages/database` (`observability-imports-
   * almost-nothing`), and canonicalisation belongs at the one point a value
   * is about to be hashed into the audit chain.
   */
  readonly ip?: string
}

const storage = new AsyncLocalStorage<CorrelationContext>()

export function newRequestId(): string {
  return randomUUID()
}

/*
 * A `sessionCorrelationId` may be set ONLY alongside a `tenantId`. ADR-0021.
 *
 * `sessions.session_correlation_id` is unique per TENANT, not globally —
 * `UNIQUE (tenant_id, session_correlation_id)`. An earlier draft of migration
 * 005 made it globally unique, arguing that cross-tenant log aggregation could
 * otherwise join two unrelated traces. Both guardians refused it: the join key
 * in the aggregated store is already the PAIR, because this context carries
 * both. The global index bought the difference between a 2^-128 collision and
 * a failed login, and cost a cross-tenant existence oracle — unique index
 * enforcement is not subject to RLS.
 *
 * That argument is only true if the pairing actually holds. `tenantId` is
 * optional on this interface, so nothing but this check stops a correlation id
 * being emitted alone — at which point the aggregated store has a key that is
 * unique per tenant and no tenant to qualify it with, and the refused design
 * becomes retroactively necessary.
 */
function assertPaired(context: CorrelationContext): void {
  if (context.sessionCorrelationId !== undefined && context.tenantId === undefined) {
    throw new Error(
      'sessionCorrelationId may only be set alongside tenantId: it is unique ' +
        'PER TENANT (sessions.session_correlation_id), so the log join key is ' +
        'the pair. Emitting it alone makes the key ambiguous across tenants.',
    )
  }
}

/** Runs `fn` with `context` attached to every log line inside it. */
export function withCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  assertPaired(context)
  return storage.run(context, fn)
}

export function getCorrelation(): CorrelationContext | undefined {
  return storage.getStore()
}

/**
 * Adds fields to the ambient context for the remainder of the current scope.
 *
 * Used at the point authentication completes, where `tenantId` and `userId`
 * become known but `requestId` was already assigned at the edge. Returns a new
 * store rather than mutating: a later request must not be able to see a field
 * an earlier one added.
 */
export function extendCorrelation<T>(fields: Partial<CorrelationContext>, fn: () => T): T {
  const current = storage.getStore()
  if (!current) {
    throw new Error('extendCorrelation called outside a correlation scope')
  }
  const next = { ...current, ...fields }
  // Checked on the MERGED context, not on `fields`: authentication completes by
  // adding both at once, and a later call may add a correlation id to a context
  // that already carries a tenant.
  assertPaired(next)
  return storage.run(next, fn)
}
