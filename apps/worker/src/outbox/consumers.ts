import type { ClaimedOutboxRow } from '@finsoft/database'

/*
 * The consumer registry, and the contract every consumer signs.
 *
 * ADR-0019: the outbox guarantees AT-LEAST-ONCE. Exactly-once across a
 * process boundary does not exist — a dispatcher can perform the side effect
 * and then die before marking the row DONE, and on recovery it will perform
 * it again. That is not a defect to engineer away; it is the guarantee, and
 * every consumer is written on top of it.
 */

/**
 * What a consumer is handed. Deliberately narrow: no lease token, no
 * `attempts`, no row status.
 *
 * A consumer that could see the lease could try to manage it, and a consumer
 * that could see `attempts` would be tempted to change its behaviour on the
 * last one — which is how "we only send the real email on the final retry"
 * gets written. The dispatcher owns the lifecycle; the consumer performs an
 * effect and either returns or throws.
 */
export interface EffectContext {
  readonly tenantId: string
  readonly topic: string
  readonly payload: Record<string, unknown>
  /**
   * THE DEDUPLICATION KEY. `(tenantId, topic, effectKey)`.
   *
   * NOT the outbox row id. ADR-0019 correction 3: a replay is a NEW row with
   * a fresh id, so a `sent_notifications` table keyed on the row id would let
   * every replay through and re-send. The effect key is carried unchanged
   * onto a replay, enforced by `outbox_enforce_replay()`, so a replay hits
   * the consumer's dedup record and does nothing — which is the correct
   * default. Re-performing an effect is a deliberate act: clear the
   * consumer-side record.
   */
  readonly effectKey: string
  readonly correlationId: string
}

/**
 * A consumer performs one external effect, idempotently.
 *
 * Returning means the effect is done and the row may be marked DONE.
 * Throwing means it is not, and the row returns to PENDING with backoff or
 * reaches FAILED at the cap.
 *
 * **Returning without having performed the effect, because the dedup record
 * already existed, is the correct response to a redelivery or a replay** —
 * not an error, and not a reason to leave the row PENDING.
 */
export type Consumer = (context: EffectContext) => Promise<void>

export interface RegisteredConsumer {
  readonly topic: string
  readonly consumer: Consumer
  /**
   * The longest this consumer may take, including its own retries.
   *
   * Load-bearing, not documentation. `assertLeaseExceedsConsumers` refuses to
   * start the dispatcher unless the lease interval comfortably exceeds every
   * value here — see the note there for what happens otherwise.
   */
  readonly timeoutSeconds: number
}

export class ConsumerRegistry {
  readonly #byTopic = new Map<string, RegisteredConsumer>()

  register(entry: RegisteredConsumer): void {
    if (this.#byTopic.has(entry.topic)) {
      throw new Error(
        `A consumer for topic ${entry.topic} is already registered. Two consumers for one ` +
          'topic would each perform the effect, which is a double send however idempotent ' +
          'each one is on its own.',
      )
    }
    this.#byTopic.set(entry.topic, entry)
  }

  get(topic: string): RegisteredConsumer | undefined {
    return this.#byTopic.get(topic)
  }

  get entries(): readonly RegisteredConsumer[] {
    return [...this.#byTopic.values()]
  }

  get longestTimeoutSeconds(): number {
    return this.entries.reduce((max, e) => Math.max(max, e.timeoutSeconds), 0)
  }
}

/**
 * Thrown when a claimed row has no registered consumer.
 *
 * Deliberately a failure rather than a silent skip. A topic nobody consumes
 * is an effect the system promised inside a posting transaction and cannot
 * deliver — it must retry, reach the cap, and surface as a FAILED row with an
 * owner. Skipping it would leave the row PENDING forever, which reads as
 * "nothing to do" and is the quietest possible way to lose an invoice.
 */
export class NoConsumerError extends Error {
  readonly topic: string

  constructor(topic: string) {
    super(
      `No consumer registered for outbox topic ${topic}. The effect was promised inside a ` +
        'posting transaction and cannot be delivered. This row will retry to the cap and ' +
        'then require an owner.',
    )
    this.topic = topic
    this.name = 'NoConsumerError'
  }
}

/**
 * The ordering invariant from `004`'s `COMMENT ON outbox.claimed_at`,
 * asserted at startup.
 *
 * Without it a merely SLOW consumer loses its row to the reaper every time,
 * burns the reclaim budget, and lands on FAILED carrying "lease expired 5
 * times without an ack; no consumer error recorded" — a poison-message
 * verdict on a consumer that works perfectly. That is exactly the diagnostic
 * confusion the separate `reclaims` counter exists to prevent, so letting the
 * configuration create it would be self-defeating.
 *
 * The margin is a factor rather than a constant because the risk scales with
 * the timeout: a consumer allowed 300s needs more slack than one allowed 5s,
 * since the same proportional overrun is a larger absolute one.
 */
export const LEASE_MARGIN_FACTOR = 2

export function assertLeaseExceedsConsumers(
  leaseSeconds: number,
  registry: ConsumerRegistry,
): void {
  const longest = registry.longestTimeoutSeconds
  if (longest === 0) return

  const required = longest * LEASE_MARGIN_FACTOR
  if (leaseSeconds >= required) return

  const offenders = registry.entries
    .filter((e) => leaseSeconds < e.timeoutSeconds * LEASE_MARGIN_FACTOR)
    .map((e) => `${e.topic} (${e.timeoutSeconds}s)`)
    .join(', ')

  throw new Error(
    `OUTBOX_LEASE_SECONDS is ${leaseSeconds}, which is not at least ${LEASE_MARGIN_FACTOR}x the ` +
      `longest consumer timeout (${longest}s). Offending consumers: ${offenders}. ` +
      'A consumer slower than its lease loses the row to the reaper every time, burns the ' +
      'reclaim budget, and lands on FAILED with "lease expired ... no consumer error ' +
      'recorded" — a poison-message verdict on a consumer that works. Raise the lease or ' +
      'lower the timeout; the worker does not start until one of them moves.',
  )
}

/** The context a consumer sees, derived from a claimed row. */
export function contextFor(row: ClaimedOutboxRow): EffectContext {
  return {
    tenantId: row.tenantId,
    topic: row.topic,
    payload: row.payload,
    effectKey: row.effectKey,
    correlationId: row.correlationId,
  }
}
