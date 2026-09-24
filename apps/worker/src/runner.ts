/*
 * The job runner.
 *
 * Wraps every handler so three things are true without a handler author
 * having to remember them:
 *
 *   1. the correlation id from the producing request is re-established, so a
 *      trace is followable across the queue hop (INFRASTRUCTURE §8);
 *   2. start, success and failure are logged with sanitised diagnostics;
 *   3. a failure is re-thrown, so BullMQ retries it.
 *
 * (3) is not a formality. A handler that swallows its error returns success,
 * the job is removed, and the side effect never happens — with a log line
 * saying it did. Errors go up.
 *
 * ── No period bypass ──────────────────────────────────────────────────────
 *
 * ADR-0012 and NON_NEGOTIABLES rule 3: a closed fiscal period rejects a
 * posting from a job exactly as it does from the API. There is no
 * `systemActor`, no `forcePost`, no `bypassPeriod` — and no such parameter is
 * threaded through this runner for a handler to reach. The worker is a
 * different entry point to the same rules, not a privileged one.
 *
 * `eslint.config.mjs` already fails the build on those three identifiers
 * anywhere in the repository (ADR-0012), so this is enforced rather than
 * merely intended.
 */

import { getLogger, withCorrelation } from '@finsoft/observability'

import type { Job, JobEnvelope } from './queue.ts'

export type JobHandler<T extends JobEnvelope> = (job: Job<T>) => Promise<void>

/**
 * Wraps a handler with correlation and logging.
 *
 * The returned function is what BullMQ calls. It takes the correlation id
 * from the job payload rather than minting one, because the point is to
 * continue the trace that produced the job, not to start a new one.
 */
export function withJobContext<T extends JobEnvelope>(
  jobName: string,
  handler: JobHandler<T>,
): (job: Job<T>) => Promise<void> {
  return async (job: Job<T>): Promise<void> => {
    const { correlationId, tenantId } = job.data

    /*
     * A job with no correlation id is a bug in whatever enqueued it, and it
     * is refused rather than given a fresh id. Minting one here would produce
     * a trace that looks complete and joins to nothing — the failure would
     * then surface as "we cannot find the request that caused this", months
     * later, during an incident.
     */
    if (!correlationId) {
      throw new Error(
        `Job ${jobName}#${job.id} has no correlationId. Every job carries the ` +
          'correlation id of the request that produced it (INFRASTRUCTURE §8).',
      )
    }

    /*
     * Built conditionally rather than passing `tenantId: undefined`.
     * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
     * undefined", and a global maintenance job genuinely has no tenant —
     * which is not the same as having an unknown one.
     */
    const context = { requestId: correlationId, jobName, ...(tenantId ? { tenantId } : {}) }

    await withCorrelation(context, async () => {
      const log = getLogger()
      const startedAt = Date.now()

      log.info({ jobId: job.id, attempt: job.attemptsMade + 1 }, 'job started')

      try {
        await handler(job)
        log.info({ jobId: job.id, durationMs: Date.now() - startedAt }, 'job completed')
      } catch (error) {
        /*
         * `err` is redacted by the logger's single choke point (ADR-0016), so
         * a driver error's connection topology does not reach the log.
         */
        log.error(
          {
            jobId: job.id,
            attempt: job.attemptsMade + 1,
            durationMs: Date.now() - startedAt,
            err: error,
          },
          'job failed',
        )
        throw error
      }
    })
  }
}
