import { sql } from 'kysely'
import { withGlobal, withTenant, type TenantTx } from './transaction.ts'

/*
 * The outbox repository. ADR-0019, and the schema in
 * database/migrations/004_create_outbox.sql.
 *
 * ── Why this lives in packages/database ────────────────────────────────
 *
 * It has to live somewhere query construction is allowed: ADR-0013's second
 * import boundary confines that to packages/database, the kernels,
 * packages/reporting and modules/*-/infrastructure. `apps/worker` is not on
 * that list, and rightly — the dispatcher orchestrates, it does not build
 * SQL.
 *
 * Of the allowed places this is the only one that fits. The outbox is not a
 * feature module's table: every module writes to it, and it is the mechanism
 * by which the transaction boundary itself extends to side effects. This
 * package already owns that boundary — `withTenant`, `withGlobal`, the pool
 * — and `transaction.ts` already names the dispatcher's tenant enumeration
 * among the sanctioned `withGlobal` uses. The placement is deliberate and
 * flagged for the Architecture Guardian rather than assumed.
 *
 * What it does NOT know, and must not learn: what a side effect is, what a
 * consumer is, that Redis exists, or how to schedule. Those belong to
 * apps/worker. This file moves rows between states and reports what it did.
 *
 * ── The contract every statement here keeps ────────────────────────────
 *
 * EVERY ack, failure and reclaim carries `WHERE id = $1 AND lease_id = $2`
 * and asserts it touched exactly one row. A dispatcher that fires an update
 * and ignores how many rows it touched cannot detect that it lost its lease,
 * which is the entire content of the fence. Losing a lease is not an error
 * to swallow: it means another dispatcher is working this row now.
 */

/* ------------------------------------------------------------------ *
 * The caps, mirrored from the schema
 *
 * These are NOT the source of truth — `outbox_attempts_capped` and
 * `outbox_reclaims_capped` are, and the database rejects a violation
 * whatever this file believes. They are here so the dispatcher can choose
 * the retry branch from the terminal branch BEFORE issuing a statement the
 * constraint would reject.
 *
 * `outbox-caps.spec.ts` asserts these agree with the catalog, so a migration
 * that changes a cap without changing this file fails a test rather than
 * producing rows the dispatcher cannot move.
 * ------------------------------------------------------------------ */

/** Consumer failures. The 10th sends the row to FAILED. */
export const ATTEMPT_CAP = 10

/** Dispatcher deaths — leases expired without an ack. The 5th sends it to FAILED. */
export const RECLAIM_CAP = 5

/*
 * Predicates written in terms of the RESULTING value, because that is what
 * the constraints are written in terms of.
 *
 * `attempts < ATTEMPT_CAP` is off by one and the database catches it: a row
 * at 9 passes, increments to 10, and lands on PENDING, which
 * `outbox_exhausted_is_failed` rejects outright. Both the implementation and
 * its review wrote the naive form; a test caught it.
 */
export const attemptsExhausted = (attempts: number): boolean => attempts + 1 >= ATTEMPT_CAP
export const reclaimsExhausted = (reclaims: number): boolean => reclaims + 1 >= RECLAIM_CAP

/** A row the dispatcher has claimed, with the lease token it must present. */
export interface ClaimedOutboxRow {
  readonly id: string
  readonly tenantId: string
  readonly topic: string
  readonly payload: Record<string, unknown>
  /** The identity of the EFFECT, not of this row. The consumer deduplicates on it. */
  readonly effectKey: string
  readonly correlationId: string
  readonly attempts: number
  readonly reclaims: number
  /** Present this on every subsequent write, or the write touches nothing. */
  readonly leaseId: string
}

/**
 * Thrown when a write touched no row because the lease had been reclaimed.
 *
 * Distinct from an ordinary failure on purpose: nothing is wrong with the
 * row, and nothing should be retried. Another dispatcher owns it, and the
 * correct response is to stop working on it and say so.
 */
export class LeaseLostError extends Error {
  /*
   * A field and an assignment, NOT a parameter property. Node strips types
   * rather than transforming them, so `constructor(readonly outboxId: string)`
   * does not load at runtime — `erasableSyntaxOnly` catches it at typecheck,
   * which is the only reason this is a compile error rather than a 3am one.
   */
  readonly outboxId: string

  constructor(outboxId: string, operation: string) {
    super(
      `outbox ${outboxId}: ${operation} touched no row. The lease was reclaimed while this ` +
        'dispatcher held it, so another dispatcher is working this row now. Stop; do not retry.',
    )
    this.outboxId = outboxId
    this.name = 'LeaseLostError'
  }
}

interface IdRow {
  id: string
}

/** Run a fenced write and refuse to continue if it did not touch exactly one row. */
async function fencedWrite(
  tx: TenantTx,
  outboxId: string,
  operation: string,
  statement: ReturnType<typeof sql<IdRow>>,
): Promise<void> {
  const { rows } = await statement.execute(tx)

  if (rows.length === 0) throw new LeaseLostError(outboxId, operation)

  /*
   * Two rows from a statement keyed on a primary key means the schema is not
   * what this file believes. Louder than a silent success.
   */
  if (rows.length > 1) {
    throw new Error(
      `outbox ${outboxId}: ${operation} touched ${rows.length} rows through a primary-key ` +
        'predicate. The schema is not what this code assumes.',
    )
  }
}

/**
 * Every tenant, of any status.
 *
 * NOT `WHERE status = 'ACTIVE'`. A SUSPENDED or CLOSED tenant can hold
 * pending rows — a final invoice email, an FBR push owed for a period
 * already posted — and a row belonging to a tenant nobody enumerates is
 * never claimed, never reaped, and never measured, because no measurement is
 * taken for it. That is a liveness hole, and the convenient query is the one
 * that creates it: `tenants`' only index is partial on `status = 'ACTIVE'`.
 *
 * `withGlobal` is the sanctioned surface here — see transaction.ts, which
 * lists this exact use. `outbox` is not nameable inside it, by type, so this
 * cannot become a cross-tenant read of the outbox itself.
 */
export function listTenantIdsForDispatch(): Promise<string[]> {
  return withGlobal(async (tx) => {
    const { rows } = await sql<{ id: string }>`SELECT id FROM tenants ORDER BY id`.execute(tx)
    return rows.map((r) => r.id)
  })
}

/**
 * Claim up to `limit` due rows for the tenant in context, and COMMIT.
 *
 * Committing before the side effect is the whole design: holding a
 * transaction open across an HTTP call is what ADR-0019 exists to prevent,
 * and `idle_in_transaction_session_timeout` would kill it anyway.
 *
 * `FOR UPDATE SKIP LOCKED` in the CTE lets several dispatchers drain one
 * tenant without contending. `ORDER BY available_at, id` matches
 * `outbox_pending_idx` exactly, so the index supplies the ordering and no
 * sort is needed — and `id` is the tiebreak without which rows sharing
 * `available_at = now()` order arbitrarily, which permits a starved row.
 *
 * `limit` is the per-tenant batch cap. Without it one tenant with a backlog
 * monopolises a poll cycle.
 */
export function claimBatch(limit: number): Promise<ClaimedOutboxRow[]> {
  return withTenant(async (tx) => {
    const { rows } = await sql<{
      id: string
      tenant_id: string
      topic: string
      payload: Record<string, unknown>
      effect_key: string
      correlation_id: string
      attempts: number
      reclaims: number
      lease_id: string
    }>`
      WITH candidate AS (
        SELECT id
          FROM outbox
         WHERE status = 'PENDING'
           AND available_at <= now()
         ORDER BY available_at, id
           FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE outbox o
         SET status     = 'IN_FLIGHT',
             claimed_at = now(),
             lease_id   = gen_random_uuid(),
             updated_at = now(),
             version    = version + 1
        FROM candidate c
       WHERE o.id = c.id
      RETURNING o.id, o.tenant_id, o.topic, o.payload, o.effect_key,
                o.correlation_id, o.attempts, o.reclaims, o.lease_id
    `.execute(tx)

    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      topic: r.topic,
      payload: r.payload,
      effectKey: r.effect_key,
      correlationId: r.correlation_id,
      attempts: r.attempts,
      reclaims: r.reclaims,
      leaseId: r.lease_id,
    }))
  })
}

/** Mark a dispatched row DONE. Fenced. */
export function ackDispatched(id: string, leaseId: string): Promise<void> {
  return withTenant((tx) =>
    fencedWrite(
      tx,
      id,
      'ack',
      sql<IdRow>`
        UPDATE outbox
           SET status        = 'DONE',
               claimed_at    = NULL,
               lease_id      = NULL,
               dispatched_at = now(),
               updated_at    = now(),
               version       = version + 1
         WHERE id = ${id} AND lease_id = ${leaseId}
        RETURNING id
      `,
    ),
  )
}

/**
 * Exponential backoff with jitter.
 *
 * Jitter matters more than the curve: without it every row that failed
 * during one outage becomes due in the same second, and the recovering
 * external system is hit by the whole backlog at once — which is how a
 * recovery becomes a second outage.
 */
export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(2 ** attempt, 3600)
  return Math.round(base * (0.5 + random() * 0.5))
}

export interface FailureRecord {
  readonly id: string
  readonly leaseId: string
  readonly attempts: number
  /** ALREADY SANITISED. See the note below — this file does not redact. */
  readonly sanitisedError: string
  readonly backoff?: number
}

/**
 * Record a CONSUMER failure: retry with backoff, or FAILED at the cap.
 *
 * `sanitisedError` must already have been through `redactError` in
 * packages/observability. This file does not redact, deliberately — a
 * redaction that happens here would be one the caller could skip by writing
 * its own statement, and the column is readable by `readonly_support` and
 * sits in every backup. Rule 20 failures here outlive the incident.
 */
export function recordFailure(failure: FailureRecord): Promise<void> {
  const { id, leaseId, attempts, sanitisedError } = failure
  const exhausted = attemptsExhausted(attempts)
  const delay = failure.backoff ?? backoffSeconds(attempts + 1)

  return withTenant((tx) =>
    fencedWrite(
      tx,
      id,
      exhausted ? 'failure (at cap)' : 'failure (retrying)',
      exhausted
        ? sql<IdRow>`
            UPDATE outbox
               SET status     = 'FAILED',
                   claimed_at = NULL,
                   lease_id   = NULL,
                   attempts   = attempts + 1,
                   last_error = ${sanitisedError},
                   updated_at = now(),
                   version    = version + 1
             WHERE id = ${id} AND lease_id = ${leaseId}
            RETURNING id
          `
        : sql<IdRow>`
            UPDATE outbox
               SET status       = 'PENDING',
                   claimed_at   = NULL,
                   lease_id     = NULL,
                   attempts     = attempts + 1,
                   available_at = now() + make_interval(secs => ${delay}),
                   last_error   = ${sanitisedError},
                   updated_at   = now(),
                   version      = version + 1
             WHERE id = ${id} AND lease_id = ${leaseId}
            RETURNING id
          `,
    ),
  )
}

export interface ReclaimResult {
  /** Returned to PENDING for another dispatcher to pick up. */
  readonly reclaimed: number
  /** Out of reclaim budget: terminal, with a synthetic error. */
  readonly exhausted: number
}

/**
 * The reaper. Returns expired leases to PENDING, or to FAILED at the cap.
 *
 * Fenced by the lease INTERVAL rather than by a token, because the reaper is
 * the thing that invalidates a lease rather than one that holds it. A
 * reclaim issues no new token: the row goes back to PENDING and the next
 * claim mints one.
 *
 * `leaseSeconds` is a parameter and not a constant. A crash test that cannot
 * shorten the lease cannot run in under five minutes, and the ordering
 * invariant in `004`'s COMMENT ON `claimed_at` — the lease must exceed the
 * longest consumer timeout, with margin — is only checkable if the value is
 * configuration rather than a literal.
 *
 * The synthetic `last_error` on the exhaustion path is required by
 * `outbox_failed_has_error` and is worth having regardless: the reaper has
 * no consumer error to record, and a row that died of dispatcher restarts
 * must be distinguishable on sight from one that failed on its merits.
 */
export function reclaimExpired(leaseSeconds: number): Promise<ReclaimResult> {
  return withTenant(async (tx) => {
    const reclaimed = await sql<IdRow>`
      UPDATE outbox
         SET status       = 'PENDING',
             claimed_at   = NULL,
             lease_id     = NULL,
             reclaims     = reclaims + 1,
             available_at = now(),
             updated_at   = now(),
             version      = version + 1
       WHERE status = 'IN_FLIGHT'
         AND claimed_at < now() - make_interval(secs => ${leaseSeconds})
         AND reclaims + 1 < ${RECLAIM_CAP}
      RETURNING id
    `.execute(tx)

    const exhausted = await sql<IdRow>`
      UPDATE outbox
         SET status     = 'FAILED',
             claimed_at = NULL,
             lease_id   = NULL,
             reclaims   = reclaims + 1,
             last_error = 'lease expired ' || (reclaims + 1) ||
                          ' times without an ack; no consumer error recorded',
             updated_at = now(),
             version    = version + 1
       WHERE status = 'IN_FLIGHT'
         AND claimed_at < now() - make_interval(secs => ${leaseSeconds})
         AND reclaims + 1 >= ${RECLAIM_CAP}
      RETURNING id
    `.execute(tx)

    return { reclaimed: reclaimed.rows.length, exhausted: exhausted.rows.length }
  })
}

/**
 * The oldest PENDING row's age, in seconds, for the tenant in context.
 *
 * Per tenant, because RLS confines every query to one tenant and a global
 * minimum is therefore not reachable in one query — ADR-0019 correction 2.
 * The ARCHITECTURE §10 alert is a MAXIMUM over these measurements, taken
 * across every tenant of any status.
 */
export function oldestPendingAgeSeconds(): Promise<number | null> {
  return withTenant(async (tx) => {
    const { rows } = await sql<{ age: number | null }>`
      SELECT EXTRACT(EPOCH FROM (now() - min(available_at)))::float8 AS age
        FROM outbox
       WHERE status = 'PENDING'
    `.execute(tx)
    return rows[0]?.age ?? null
  })
}
