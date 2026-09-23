/*
 * The worker process.
 *
 * Consumes BullMQ queues. Its reason to exist is the transactional outbox
 * dispatcher (ADR-0010) — rows written inside the posting transaction,
 * dispatched after it commits — which arrives with the `outbox` table. This
 * builds the process that will run it: configuration, queues, correlation
 * across the queue hop, health probes and a shutdown that does not drop work.
 *
 * Unlike apps/api this is plain Node, not NestJS. It has no HTTP surface
 * beyond two probes and no dependency injection to do, so it runs directly
 * under Node's type stripping with no build step — the same way packages/* do.
 */

import { closeDatabase, openDatabase } from '@finsoft/database'
import { initLogger, newRequestId } from '@finsoft/observability'
import type { Server } from 'node:http'

import { loadConfig, type WorkerConfig } from './config.ts'
import { startHealthServer } from './health.ts'
import { HEARTBEAT_JOB, handleHeartbeat, type HeartbeatPayload } from './jobs/heartbeat.ts'
import { OutageTracker } from './outage.ts'
import { QUEUES, createQueue, createWorker } from './queue.ts'
import { withJobContext } from './runner.ts'

async function bootstrap(): Promise<void> {
  const config: WorkerConfig = loadConfig()

  const logger = initLogger({ service: 'worker' })

  /*
   * Same reasoning as apps/api: open eagerly so the role check, the numeric
   * parser assertion and the connection itself are verified at boot rather
   * than by whichever job happens to touch the database first. A worker that
   * cannot reach PostgreSQL should not start consuming a queue.
   */
  await openDatabase()

  let shuttingDown = false

  const queue = createQueue(QUEUES.maintenance, config)

  const worker = createWorker<HeartbeatPayload>(
    QUEUES.maintenance,
    withJobContext(HEARTBEAT_JOB, handleHeartbeat),
    config,
  )

  /*
   * BullMQ surfaces connection-level problems here. Without a listener an
   * 'error' event on an EventEmitter terminates the process, so a transient
   * Redis blip would crash a worker that should have waited it out.
   *
   * De-duplicated, because it fires on every reconnect attempt. Running the
   * image against an unreachable Redis produced two identical lines a second
   * — about 172,000 a day — which describes the outage no better than one
   * line and buries everything else that happened during it.
   */
  const queueOutage = new OutageTracker('worker queue connection failed', 'worker queue recovered')
  worker.on('error', (error) => {
    queueOutage.recordFailure({ err: error })
  })
  worker.on('ready', () => queueOutage.recordSuccess())

  worker.on('failed', (job, error) => {
    /*
     * The per-job failure is already logged with full correlation by the
     * runner. This line is the queue's own view: whether the job will be
     * retried, or has exhausted its attempts and is now an operational
     * condition someone has to look at (ADR-0010).
     */
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1)
    logger.warn(
      { jobId: job?.id, attempts: job?.attemptsMade, exhausted, err: error },
      exhausted ? 'job exhausted its attempts' : 'job will be retried',
    )
  })

  const health: Server = startHealthServer({
    port: config.healthPort,
    isShuttingDown: () => shuttingDown,
    /*
     * Readiness asks the queue's own connection, rather than opening a second
     * one. A probe that checks a connection the worker is not using can
     * report ready while the worker is stuck.
     */
    isReady: async () => {
      /*
       * `getJobCounts` rather than a raw PING: BullMQ's `IRedisClient` is a
       * deliberately minimal abstraction that does not expose PING, and
       * casting past it to reach one would be asserting a shape the library
       * does not promise. This is a typed call that genuinely round-trips to
       * Redis on the connection the worker is actually using, which is what
       * the probe needs to establish. It throws if Redis is unreachable.
       */
      await queue.getJobCounts()
      return true
    },
  })

  logger.info(
    {
      concurrency: config.concurrency,
      healthPort: config.healthPort,
      queues: Object.values(QUEUES),
    },
    'worker started',
  )

  /*
   * Shutdown, in an order that matters.
   *
   *   1. fail readiness       — stop being sent new work
   *   2. worker.close()       — stop taking new jobs, wait for in-flight ones
   *   3. close queue, health, database
   *
   * BullMQ's close() waits for active jobs, which is the whole point: a job
   * interrupted mid-flight is redelivered (at-least-once, ADR-0010), and
   * redelivery is a safety net rather than a routine.
   *
   * The timeout exists because the orchestrator's own grace period ends in
   * SIGKILL. Exiting deliberately at 20s is better than being killed at 30s,
   * because the exit is logged and the kill is not.
   */
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down')

    const forced = setTimeout(() => {
      logger.error(
        { timeoutMs: config.shutdownTimeoutMs },
        'shutdown timed out with jobs still in flight; exiting anyway',
      )
      process.exit(1)
    }, config.shutdownTimeoutMs)
    forced.unref()

    void worker
      .close()
      .then(() => Promise.all([queue.close(), closeDatabase()]))
      .then(() => new Promise<void>((resolve) => health.close(() => resolve())))
      .then(() => {
        logger.info('shutdown complete')
        process.exit(0)
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed')
        process.exit(1)
      })
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => shutdown(signal))
  }

  /*
   * One heartbeat at startup, so a deployment proves the loop rather than
   * waiting for the first real job to find out it is broken. It carries a
   * correlation id like anything else — the runner refuses a job without one.
   */
  await queue.add(HEARTBEAT_JOB, {
    correlationId: newRequestId(),
    enqueuedAt: new Date().toISOString(),
  })
}

void bootstrap().catch((error: unknown) => {
  /*
   * Startup failed, so there may be no logger. This is the one place a bare
   * console call is correct: the alternative is a process that exits silently
   * and an orchestrator that reports a crash loop with no reason.
   */
  // eslint-disable-next-line no-console -- startup failure, before the logger exists
  console.error('worker failed to start:', error)
  process.exit(1)
})
