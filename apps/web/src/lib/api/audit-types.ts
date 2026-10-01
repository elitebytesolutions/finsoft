/*
 * Wire types for `GET /api/audit` (apps/api/src/audit/audit.controller.ts). Not yet in
 * `packages/shared-types` — audit isn't one of that package's modules — so, per the
 * precedent `types.ts` sets for the auth surface (see its own header comment), the shape
 * is declared here from the controller's own response mapping rather than left untyped.
 * Promote to shared-types if a second consumer needs it.
 */

export interface AuditEvent {
  readonly id: string
  /** Monotonic within a tenant — the cursor a caller's `?cursor=` echoes back. */
  readonly seq: number
  /** ISO-8601 UTC instant. */
  readonly occurredAt: string
  /** Null for a job/system action (migration 009: "a job has no client address... NOT NULL
   * would force a fabricated value") and for the chain-anchor row at seq 0. */
  readonly actorUserId: string | null
  /** UPPER_SNAKE_CASE, e.g. `CUSTOMER_CREATED` (ADR-0020 §4 / migration 009). */
  readonly action: string
  readonly entityType: string
  /** Null when the event has no single associated record (e.g. a login). */
  readonly entityId: string | null
  readonly beforeJson: unknown
  readonly afterJson: unknown
  readonly ip: string | null
  readonly requestId: string | null
  readonly hash: string
}

export interface AuditPage {
  readonly items: readonly AuditEvent[]
  readonly nextCursor: string | null
}

export interface AuditQuery {
  /** ISO-8601 date-times — the controller's own `from`/`to` range on `occurred_at`. */
  from?: string
  to?: string
  action?: string
  entityType?: string
  entityId?: string
  actor?: string
  cursor?: string
  limit?: number
}
