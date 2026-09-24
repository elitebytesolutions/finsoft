import type { Logger } from '@finsoft/observability'

import type { OutboxDispatcher } from './dispatcher.ts'

/*
 * The polling loop around the dispatcher.
 *
 * Separate from `OutboxDispatcher` on purpose: the dispatcher does one pass
 * and returns what it did, which is what makes it testable without a clock.
 * Scheduling — when to run again, when to stop, what to say about it — is
 * this file's problem and nothing else's.
 *
 * PostgreSQL is the queue of record (ADR-0019), so polling is the mechanism
 * and Redis is only a way to be prompt. A lost wake signal costs latency
 * until the next poll and nothing else, which is the property that lets the
 * signal carry no identifier at all.
 */

export interface LoopOptions {
  /** Wait between cycles that found nothing. */
  readonly idlePollMs: number
  /**
   * Wait after a cycle that dispatched something.
   *
   * Shorter than the idle wait, because work tends to arrive in bursts: a
   * posting run writes many rows at once, and pausing a full idle interval
   * between them would add that latency to every invoice.
   */
  readonly busyPollMs?: number
}

/**
 * Run until stopped.
 *
 * Errors are caught and logged rather than escaping: a cycle that fails —
 * a dropped connection, a transient database error — must not take the
 * worker process down, because the rows it did not reach are still in the
 * table and the next cycle will find them. That is the difference between a
 * durable queue and an in-memory one.
 */
export function startOutboxLoop(
  dispatcher: OutboxDispatcher,
  options: LoopOptions,
  log: Logger,
): { stop: () => Promise<void> } {
  const busyPollMs = options.busyPollMs ?? Math.min(options.idlePollMs, 250)

  let running = true
  let timer: NodeJS.Timeout | undefined
  let cycle: Promise<void> = Promise.resolve()

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms)
      /*
       * Unreferenced so a sleeping loop never holds the process open. A
       * worker that has been told to stop should exit when its work is
       * finished, not when its next poll happens to be due.
       */
      timer.unref()
    })

  const run = async (): Promise<void> => {
    while (running) {
      try {
        const result = await dispatcher.runCycle()

        if (result.claimed > 0 || result.reclaimed > 0 || result.exhausted > 0) {
          log.info(
            {
              tenants: result.tenantsVisited,
              claimed: result.claimed,
              dispatched: result.dispatched,
              failed: result.failed,
              reclaimed: result.reclaimed,
              exhausted: result.exhausted,
              leasesLost: result.leasesLost,
              oldestPendingSeconds: result.oldestPendingSeconds,
            },
            'outbox cycle',
          )
        }

        await sleep(result.claimed > 0 ? busyPollMs : options.idlePollMs)
      } catch (error) {
        /*
         * Caught deliberately. The rows are in PostgreSQL; nothing has been
         * lost, and the next cycle picks up where this one stopped. Crashing
         * here would turn a transient database blip into a worker restart,
         * and a restart mid-dispatch costs a reclaim against every row that
         * was in flight.
         */
        log.error({ err: error }, 'outbox cycle failed; retrying after the idle interval')
        await sleep(options.idlePollMs)
      }
    }
  }

  cycle = run()

  return {
    async stop() {
      running = false
      if (timer) clearTimeout(timer)
      /*
       * Awaited, so shutdown does not race a cycle that is mid-dispatch. A
       * cycle interrupted between the side effect and the ack leaves a row
       * IN_FLIGHT whose lease has to expire before anyone can touch it —
       * correct, recoverable, and a wholly avoidable delay if we simply wait.
       */
      await cycle
    },
  }
}
