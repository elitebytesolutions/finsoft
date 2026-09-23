/*
 * The heartbeat job.
 *
 * Wave 0's exit criterion is "an empty-but-real vertical". This is the
 * worker's contribution to it: a job that is genuinely enqueued, genuinely
 * consumed, and genuinely logged with the correlation id of whatever produced
 * it — proving the loop end to end without pretending to do business work.
 *
 * It deliberately does NOT touch the database. Wave 0 has three tables and no
 * posting, so a job that wrote something would be inventing a business fact to
 * have something to do. When the outbox dispatcher lands (ADR-0019) it
 * replaces this as the worker's reason to exist; the heartbeat stays as the
 * thing that proves the machinery works when no real job is flowing.
 */

import { getLogger } from '@finsoft/observability'

import type { Job, JobEnvelope } from '../queue.ts'

export const HEARTBEAT_JOB = 'heartbeat'

export interface HeartbeatPayload extends JobEnvelope {
  readonly enqueuedAt: string
}

export async function handleHeartbeat(job: Job<HeartbeatPayload>): Promise<void> {
  const enqueuedAt = Date.parse(job.data.enqueuedAt)

  getLogger().debug(
    {
      /*
       * Queue latency, which is the one number that says whether the worker
       * is keeping up. It is measured here rather than inferred from log
       * timestamps, because those are written at both ends by different
       * processes whose clocks need not agree.
       */
      queueLatencyMs: Number.isFinite(enqueuedAt) ? Date.now() - enqueuedAt : undefined,
    },
    'heartbeat',
  )

  return Promise.resolve()
}
