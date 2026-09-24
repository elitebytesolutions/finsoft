/*
 * Worker configuration.
 *
 * Read once, at startup, and validated there. A worker that starts with a
 * missing REDIS_URL and discovers it on the first job has already told the
 * orchestrator it is healthy.
 */

export interface WorkerConfig {
  readonly redisUrl: string
  readonly concurrency: number
  readonly shutdownTimeoutMs: number
  readonly healthPort: number
  readonly outbox: OutboxConfig
}

export interface OutboxConfig {
  /**
   * How long a claim is good for, and what the reaper measures against.
   *
   * Configuration rather than a constant because `004`'s COMMENT ON
   * `claimed_at` requires it: the lease must exceed the longest consumer
   * timeout with margin, and that ordering is only checkable if the value can
   * move. `assertLeaseExceedsConsumers` refuses to start the worker
   * otherwise — a consumer slower than its lease loses the row to the reaper
   * every time and lands on FAILED with a poison-message verdict it did not
   * earn.
   */
  readonly leaseSeconds: number
  /** Per-tenant batch cap. Without it one backlogged tenant owns the cycle. */
  readonly batchSize: number
  readonly idlePollMs: number
}

/*
 * How long a SIGTERM waits for in-flight jobs before the process exits anyway.
 *
 * Kubernetes and Docker send SIGKILL after their own grace period (30s by
 * default), so this must be comfortably under it: a worker still "gracefully
 * shutting down" when SIGKILL lands is not shutting down gracefully, it is
 * being killed mid-job. At-least-once delivery (ADR-0019) means a killed job
 * is redelivered rather than lost — but a redelivered job is only safe because
 * handlers are idempotent, and leaning on that routinely is how the idempotency
 * bugs get found in production instead of in a test.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000

const DEFAULT_CONCURRENCY = 5
const DEFAULT_HEALTH_PORT = 3002

/* The contract value in `004`'s COMMENT ON outbox.claimed_at. */
const DEFAULT_OUTBOX_LEASE_SECONDS = 300
const DEFAULT_OUTBOX_BATCH_SIZE = 50
const DEFAULT_OUTBOX_IDLE_POLL_MS = 2_000

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required. The worker does not start without it.`)
  }
  return value
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

export function loadConfig(): WorkerConfig {
  return {
    redisUrl: requireEnv('REDIS_URL'),
    concurrency: numberFromEnv('WORKER_CONCURRENCY', DEFAULT_CONCURRENCY),
    shutdownTimeoutMs: numberFromEnv('WORKER_SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS),
    healthPort: numberFromEnv('WORKER_HEALTH_PORT', DEFAULT_HEALTH_PORT),
    outbox: {
      leaseSeconds: numberFromEnv('OUTBOX_LEASE_SECONDS', DEFAULT_OUTBOX_LEASE_SECONDS),
      batchSize: numberFromEnv('OUTBOX_BATCH_SIZE', DEFAULT_OUTBOX_BATCH_SIZE),
      idlePollMs: numberFromEnv('OUTBOX_IDLE_POLL_MS', DEFAULT_OUTBOX_IDLE_POLL_MS),
    },
  }
}
