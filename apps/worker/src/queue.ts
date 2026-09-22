/*
 * Queue wiring.
 *
 * ── What Redis is allowed to be ───────────────────────────────────────────
 *
 * ADR-0002:60 — "if Redis is flushed at any moment, the system must lose
 * nothing but speed." That is a constraint on what a job may CONTAIN, not
 * only on how Redis is configured, and it is the reason the local Redis runs
 * with `appendonly no` (compose.yaml:110): a durable local Redis would let
 * code quietly acquire a dependency on a guarantee production does not make.
 *
 * So a job payload carries **identifiers and a correlation id**. Never a
 * monetary amount, never an account, never anything that constitutes
 * financial truth. The handler re-reads the committed row from PostgreSQL,
 * which is what makes a flushed queue a delay rather than a loss — and what
 * stops a payload disagreeing with the ledger (ADR-0010).
 *
 * The outbox dispatcher that ADR-0010 specifies is NOT here. It needs the
 * `outbox` table, which needs a migration that needs posting to exist. Redis
 * will carry the *signal* to wake it promptly; PostgreSQL remains the queue of
 * record. This file builds the machinery that dispatcher will run on.
 */

import { Queue, Worker, type ConnectionOptions, type Job, type Processor } from 'bullmq'

import type { WorkerConfig } from './config.ts'

/**
 * Queue names, closed.
 *
 * `maintenance` exists so Wave 0 has a real queue to prove the loop with —
 * a worker whose only queue is hypothetical cannot be shown to work.
 * ADR-0010's topics (`INVOICE_EMAIL`, `FBR_POS_PUSH`, …) are outbox row
 * topics, not queue names, and arrive with the dispatcher.
 */
export const QUEUES = {
  maintenance: 'maintenance',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/**
 * The fields every job carries.
 *
 * `correlationId` is mandatory and is the whole point: INFRASTRUCTURE §8
 * requires a trace to be followable across api and worker, which is only
 * possible if the id survives the queue hop. A job without one produces log
 * lines nobody can join to the request that caused them.
 */
export interface JobEnvelope {
  readonly correlationId: string
  /** Present when the job acts for a tenant. Absent for global maintenance. */
  readonly tenantId?: string
}

export function connectionOptions(config: WorkerConfig): ConnectionOptions {
  return {
    url: config.redisUrl,
    /*
     * BullMQ requires this to be null: with a retry limit, a command issued
     * during a Redis outage rejects, and a blocking consumer that gets a
     * rejection stops consuming. Redis coming back would then leave a worker
     * that is alive, healthy and processing nothing.
     */
    maxRetriesPerRequest: null,
  }
}

/*
 * Retry policy.
 *
 * Exponential with jitter, matching ADR-0010's backoff for outbox rows, so
 * the two do not drift into different retry behaviours for the same class of
 * failure. A job that exhausts its attempts is kept (`removeOnFail: false`)
 * because a failed job is an operational condition to be looked at, never
 * something to discard quietly.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: false,
} as const

export function createQueue(name: QueueName, config: WorkerConfig): Queue {
  return new Queue(name, {
    connection: connectionOptions(config),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
}

export function createWorker<T extends JobEnvelope>(
  name: QueueName,
  processor: Processor<T>,
  config: WorkerConfig,
): Worker<T> {
  return new Worker<T>(name, processor, {
    connection: connectionOptions(config),
    concurrency: config.concurrency,
  })
}

export type { Job }
