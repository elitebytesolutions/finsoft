/*
 * The seam for M1-D's audit lane.
 *
 * Rule 9 requires an append-only audit record for every financial mutation
 * "in the same transaction as the change". Login/logout/refresh are not
 * financial mutations, but session lifecycle events are the kind of thing an
 * incident review needs an authoritative record of — and that table does not
 * exist yet (docs/WAVE_1_REGISTER.md W1-005, blocked on ADR-0020's
 * signatures). Rather than create an audit table out of turn, or silently
 * satisfy the requirement with a log line (packages/observability's own
 * events.ts is explicit that a business event is not the audit trail — it
 * can be lost to a full disk or a sampling rule, and none of that is a bug),
 * this interface names the seam and ships a no-op default.
 *
 * M1-D wires a real implementation once migration 009 lands. Until then,
 * calling this records nothing durable — which is the honest state of the
 * system, not a claim of compliance this package cannot back up.
 *
 * ITEM 7, security/database re-review 2026-09-27: every `.record()` call
 * site in this package (login.ts, refresh.ts, logout.ts) runs AFTER the
 * mutation's own transaction has already committed, never inside it — rule
 * 9 ("in the same transaction as the change") is NOT satisfied by the
 * current call sites, and cannot be, without restructuring the boundary
 * this task built: `packages/auth` never holds a `TenantTx` (it does not
 * import Kysely at all — see eslint's `packagesAuthQuerySyntax`), so it has
 * no transaction to write an audit row inside even if the table existed.
 * When M1-D wires a real sink, the call sites here will need to move INTO
 * `packages/database/src/auth/{login,refresh,logout}.ts`'s own
 * transactions — passed in as a callback the way `decide` already is,
 * writing the audit row before the transaction returns — rather than being
 * called from this package after the fact. Left as a note rather than
 * restructured now, because there is no audit table to write to yet and
 * speculative plumbing for one is more likely to be wrong than helpful.
 */

export interface AuthAuditEvent {
  readonly tenantId: string
  readonly actorUserId: string | null
  readonly action:
    'LOGIN_SUCCEEDED' | 'LOGIN_FAILED' | 'REFRESH_ROTATED' | 'REFRESH_REUSE_DETECTED' | 'LOGOUT'
  readonly entityType: 'session' | 'refresh_token_family'
  readonly entityId: string | null
  readonly detail?: Record<string, unknown>
}

export interface AuthAuditSink {
  record(event: AuthAuditEvent): Promise<void>
}

export const noopAuthAuditSink: AuthAuditSink = {
  async record(): Promise<void> {
    // Intentionally empty. See this file's header.
  },
}
