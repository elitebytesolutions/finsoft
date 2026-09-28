/*
 * TD-001, RESOLVED. One exported constant, used at both call sites that take
 * the terminal advisory lock (LOCK_REGISTRY.md position 6) — writer.ts's
 * recordAudit and anchor.ts's createAuditChainAnchor — so the value is
 * stated once rather than duplicated and risking drift between them.
 *
 * 2000ms: 2.5x the ARCHITECTURE §11 800ms posting P95 budget, well under the
 * 15000ms statement_timeout. Confirmed by the Database and Architecture
 * seats.
 *
 * `SET LOCAL lock_timeout` is scoped to the REST of the caller's
 * transaction, not to the single advisory-lock statement — deliberately.
 * After the advisory lock is acquired, the linkage trigger's own FOR SHARE
 * read and the self-referential FK's KEY SHARE wait both still happen
 * before commit, and this bounds those too. A wait that exceeds it surfaces
 * as PostgreSQL 55P03 from whichever statement is actually waiting when the
 * clock runs out — the advisory-lock acquisition itself, or the INSERT that
 * follows it — so both call sites map that SQLSTATE to AuditLockTimeoutError.
 */
export const AUDIT_LOCK_TIMEOUT_MS = 2000

export const AUDIT_LOCK_TIMEOUT_SQL = `${AUDIT_LOCK_TIMEOUT_MS}ms`

/** PostgreSQL's SQLSTATE for "lock timeout". */
export const LOCK_NOT_AVAILABLE_SQLSTATE = '55P03'

/**
 * The terminal advisory lock (LOCK_REGISTRY.md position 6), or a wait it
 * bounds (the linkage trigger's FOR SHARE, the self-FK's KEY SHARE), could
 * not be acquired within AUDIT_LOCK_TIMEOUT_MS. Retryable: another append
 * for the same tenant is in flight and will release it shortly. Distinct
 * from AuditChainError, which means the chain itself is in a state
 * recordAudit cannot proceed from regardless of retrying.
 */
export class AuditLockTimeoutError extends Error {
  readonly tenantId: string

  constructor(tenantId: string) {
    super(
      `audit_log: could not acquire the per-tenant chain lock for tenant ${tenantId} within ` +
        `${AUDIT_LOCK_TIMEOUT_MS}ms. Another append for this tenant is in flight; retry.`,
    )
    this.name = 'AuditLockTimeoutError'
    this.tenantId = tenantId
  }
}
