import {
  ackDispatched,
  claimBatch,
  listTenantIdsForDispatch,
  oldestPendingAgeSeconds,
  reclaimExpired,
  recordFailure,
  LeaseLostError,
  TenantContext,
  type ClaimedOutboxRow,
} from '@finsoft/database'
import { childLogger, redactError, withCorrelation, type Logger } from '@finsoft/observability'

import {
  ConsumerRegistry,
  NoConsumerError,
  assertLeaseExceedsConsumers,
  contextFor,
} from './consumers.ts'

/*
 * The outbox dispatcher. ADR-0019.
 *
 * This is the worker's reason to exist: rows written inside the posting
 * transaction, dispatched after it commits.
 *
 * ── What is here, and what deliberately is not ─────────────────────────
 *
 * Here: which tenant to serve next, when to claim, what to do with a
 * consumer's success or failure, and when to reap.
 *
 * NOT here: SQL. ADR-0013's second import boundary confines query
 * construction to packages/database, the kernels, packages/reporting and
 * module infrastructure layers — apps/** is not on that list. Every
 * statement lives in `packages/database/src/outbox.ts`, and this file calls
 * it. That separation is why the fence can be asserted in one place instead
 * of at every call site.
 *
 * ── The shape of one cycle ─────────────────────────────────────────────
 *
 *   for each tenant, in round-robin order, of ANY status:
 *     reap expired leases
 *     claim a bounded batch          ← COMMITS before any effect runs
 *     for each row:
 *       run the consumer
 *       ack, or record the failure   ← both fenced on the lease
 *
 * Every tenant, of any status, is not an oversight to tidy later: a
 * SUSPENDED tenant can hold a final invoice email or an FBR push owed for a
 * period already posted, and a row belonging to a tenant nobody enumerates
 * is never claimed, never reaped and never measured.
 */

export interface DispatcherConfig {
  /** How long a claim is good for. Also what the reaper measures against. */
  readonly leaseSeconds: number
  /** Per-tenant batch cap. Without it one backlogged tenant owns the cycle. */
  readonly batchSize: number
  /** How long to wait between cycles when there was nothing to do. */
  readonly idlePollMs: number
  /**
   * Retry schedule, in seconds, given the attempt number about to be
   * recorded. Defaults to the repository's exponential-with-jitter curve.
   *
   * Configuration rather than a constant because the right curve differs by
   * deployment — and because a test of the attempt CAP would otherwise have
   * to wait out 2+4+8+...+1024 seconds of real backoff to reach it. The
   * alternative, pulling `available_at` back by hand between cycles, is a
   * PENDING -> PENDING update that the transition trigger correctly refuses.
   */
  readonly backoff?: (attempt: number) => number
}

export interface CycleResult {
  readonly tenantsVisited: number
  readonly claimed: number
  readonly dispatched: number
  readonly failed: number
  readonly reclaimed: number
  readonly exhausted: number
  readonly leasesLost: number
  /** Max over per-tenant measurements — a global minimum is unreachable under RLS. */
  readonly oldestPendingSeconds: number | null
}

const EMPTY: CycleResult = {
  tenantsVisited: 0,
  claimed: 0,
  dispatched: 0,
  failed: 0,
  reclaimed: 0,
  exhausted: 0,
  leasesLost: 0,
  oldestPendingSeconds: null,
}

export class OutboxDispatcher {
  readonly #config: DispatcherConfig
  readonly #registry: ConsumerRegistry
  readonly #log: Logger

  /*
   * Where the round-robin resumes. Without it, a cycle that always starts at
   * the first tenant serves the alphabetically-first tenant's backlog
   * repeatedly and starves the last one — the batch cap bounds the work per
   * tenant, it does not decide who gets served.
   */
  #resumeAfterTenantId: string | undefined

  constructor(config: DispatcherConfig, registry: ConsumerRegistry, log?: Logger) {
    assertLeaseExceedsConsumers(config.leaseSeconds, registry)
    this.#config = config
    this.#registry = registry
    this.#log = log ?? childLogger({ component: 'outbox-dispatcher' })
  }

  /**
   * One full pass over every tenant.
   *
   * Returns rather than logs its counts, so a test can assert on them and the
   * caller decides what is worth a line.
   */
  async runCycle(): Promise<CycleResult> {
    const tenantIds = await listTenantIdsForDispatch()
    if (tenantIds.length === 0) return EMPTY

    const ordered = this.#roundRobin(tenantIds)
    let result: CycleResult = { ...EMPTY }

    for (const tenantId of ordered) {
      const forTenant = await this.#runForTenant(tenantId)
      result = merge(result, forTenant)
      this.#resumeAfterTenantId = tenantId
    }

    return { ...result, tenantsVisited: ordered.length }
  }

  /** Rotate the list so the next cycle starts after the last tenant served. */
  #roundRobin(tenantIds: readonly string[]): readonly string[] {
    const resumeAfter = this.#resumeAfterTenantId
    if (resumeAfter === undefined) return tenantIds

    const index = tenantIds.indexOf(resumeAfter)
    if (index === -1) return tenantIds

    return [...tenantIds.slice(index + 1), ...tenantIds.slice(0, index + 1)]
  }

  async #runForTenant(tenantId: string): Promise<CycleResult> {
    /*
     * The tenant comes from `tenants`, never from a queue message. ADR-0019
     * correction 4 and rule 8: an `{ outboxId }` message would invite a
     * fetch-by-id, the fetch needs a tenant context, and the only tenant
     * available at that moment is one inferred from an untrusted payload.
     * Redis carries a bare wake signal, so there is nothing to infer from.
     */
    return TenantContext.run({ tenantId, userId: null }, async () => {
      const { reclaimed, exhausted } = await reclaimExpired(this.#config.leaseSeconds)

      if (exhausted > 0) {
        this.#log.error(
          { tenantId, exhausted },
          'outbox rows reached the reclaim cap and are FAILED with no consumer error — ' +
            'a dispatcher died repeatedly, or the lease is shorter than a consumer takes',
        )
      }

      const batch = await claimBatch(this.#config.batchSize)

      let dispatched = 0
      let failed = 0
      let leasesLost = 0

      for (const row of batch) {
        const outcome = await this.#dispatchOne(row)
        if (outcome === 'dispatched') dispatched += 1
        else if (outcome === 'failed') failed += 1
        else leasesLost += 1
      }

      return {
        ...EMPTY,
        claimed: batch.length,
        dispatched,
        failed,
        reclaimed,
        exhausted,
        leasesLost,
        oldestPendingSeconds: await oldestPendingAgeSeconds(),
      }
    })
  }

  async #dispatchOne(row: ClaimedOutboxRow): Promise<'dispatched' | 'failed' | 'lease-lost'> {
    /*
     * The correlation id survives the queue hop, which is the whole reason
     * the column is mandatory: debugging spans two processes and an
     * uncorrelated dispatcher line is unjoinable to the request that caused
     * it.
     */
    return withCorrelation({ requestId: row.correlationId }, async () => {
      const registered = this.#registry.get(row.topic)

      try {
        if (!registered) throw new NoConsumerError(row.topic)

        await registered.consumer(contextFor(row))

        /*
         * The effect is done. From here the only question is whether we can
         * still record that — and if the lease was reclaimed meanwhile, we
         * cannot, and must not pretend otherwise.
         */
        await ackDispatched(row.id, row.leaseId)
        return 'dispatched'
      } catch (error) {
        if (error instanceof LeaseLostError) {
          /*
           * NOT an error path for this row. Another dispatcher owns it and is
           * working it now. Warned rather than errored, and counted, because
           * a rising rate means the lease is too short for the consumers —
           * which is a configuration problem, not a row problem.
           */
          this.#log.warn(
            { outboxId: row.id, topic: row.topic },
            'lease lost before the result could be recorded; another dispatcher owns this row',
          )
          return 'lease-lost'
        }

        return this.#recordFailure(row, error)
      }
    })
  }

  async #recordFailure(row: ClaimedOutboxRow, error: unknown): Promise<'failed' | 'lease-lost'> {
    /*
     * Sanitised BEFORE it is written. `last_error` is readable by
     * readonly_support and sits in every backup, so an unsanitised write here
     * is a rule 20 breach that outlives the incident that caused it — a
     * driver error carries host, port, database and role, and a 401 body
     * carries a bearer token.
     */
    const sanitised = redactError(error)
    const message = `${sanitised.name}: ${sanitised.message}`.slice(0, 2000)

    try {
      /*
       * The key is OMITTED rather than set to undefined, because
       * `exactOptionalPropertyTypes` distinguishes the two — and rightly:
       * "no backoff configured, use the default" and "a backoff of
       * undefined" are different statements, and only one of them is one
       * the repository can act on.
       */
      const configured = this.#config.backoff?.(row.attempts + 1)

      await recordFailure({
        id: row.id,
        leaseId: row.leaseId,
        attempts: row.attempts,
        sanitisedError: message,
        ...(configured === undefined ? {} : { backoff: configured }),
      })

      this.#log.warn(
        { outboxId: row.id, topic: row.topic, attempts: row.attempts + 1, err: sanitised },
        'outbox dispatch failed',
      )
      return 'failed'
    } catch (recordError) {
      if (recordError instanceof LeaseLostError) {
        this.#log.warn(
          { outboxId: row.id, topic: row.topic },
          'lease lost while recording a failure; another dispatcher owns this row',
        )
        return 'lease-lost'
      }
      throw recordError
    }
  }
}

function merge(a: CycleResult, b: CycleResult): CycleResult {
  return {
    tenantsVisited: a.tenantsVisited + b.tenantsVisited,
    claimed: a.claimed + b.claimed,
    dispatched: a.dispatched + b.dispatched,
    failed: a.failed + b.failed,
    reclaimed: a.reclaimed + b.reclaimed,
    exhausted: a.exhausted + b.exhausted,
    leasesLost: a.leasesLost + b.leasesLost,
    oldestPendingSeconds: maxAge(a.oldestPendingSeconds, b.oldestPendingSeconds),
  }
}

/*
 * A MAXIMUM over per-tenant measurements. ADR-0019 correction 2: RLS confines
 * every dispatch query to one tenant, so "the oldest PENDING row" is not
 * reachable in a single query and the ARCHITECTURE §10 alert is this
 * aggregate instead.
 */
function maxAge(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}
