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
  return randomUUID() as SessionCorrelationId
}

/**
 * Asserts that a stored value is a correlation id.
 *
 * The only sanctioned way to get a `SessionCorrelationId` from persistence.
 * It is a UUID by construction, so anything else is a sign that a session id
 * has been routed here by mistake — which throws rather than logs.
 */
export function asSessionCorrelationId(value: string): SessionCorrelationId {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID.test(value)) {
    throw new Error(
      'sessionCorrelationId must be a UUID minted by newSessionCorrelationId(). ' +
        'A raw session id must never be used here.',
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
}

const storage = new AsyncLocalStorage<CorrelationContext>()

export function newRequestId(): string {
  return randomUUID()
}

/** Runs `fn` with `context` attached to every log line inside it. */
export function withCorrelation<T>(context: CorrelationContext, fn: () => T): T {
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
  return storage.run({ ...current, ...fields }, fn)
}
