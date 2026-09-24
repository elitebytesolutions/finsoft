/*
 * Outage de-duplication.
 *
 * A repeating failure — a readiness probe every few seconds, a BullMQ
 * reconnect twice a second — must not produce one log line per attempt. A
 * ten-minute Redis outage at two lines a second is seventy-two thousand
 * identical lines, which does not describe the outage better than one line
 * does; it buries whatever else broke while it was happening, and it is a
 * real cost on an aggregator billed by volume.
 *
 * So only TRANSITIONS are logged. The first failure says what broke; the
 * recovery says how long it lasted and how many attempts failed, which is
 * every fact the repetitions carried between them.
 *
 * This was found by running the worker image against an unreachable Redis and
 * reading the output, not by reasoning about it — the readiness probe already
 * had this treatment and the queue's own error event did not.
 */

import { getLogger } from '@finsoft/observability'

export class OutageTracker {
  private failingSince: number | undefined
  private failures = 0

  /*
   * Explicit fields, not constructor parameter properties. This package
   * inherits `erasableSyntaxOnly` from tsconfig.packages.json because it runs
   * under Node's type stripping, which erases types but does not TRANSFORM —
   * and a parameter property is a transformation. One in BaseRepository
   * compiled, linted and passed two hundred tests (Vitest transpiles) while
   * being unloadable by the runtime that ships.
   */
  private readonly failureMessage: string
  private readonly recoveryMessage: string

  constructor(failureMessage: string, recoveryMessage: string) {
    this.failureMessage = failureMessage
    this.recoveryMessage = recoveryMessage
  }

  /** Logs the first failure of a run; counts the rest silently. */
  recordFailure(context: Record<string, unknown>): void {
    this.failures += 1

    if (this.failingSince === undefined) {
      this.failingSince = Date.now()
      getLogger().error(context, this.failureMessage)
    }
  }

  /** Logs recovery, with the shape of the outage. No-op if nothing failed. */
  recordSuccess(): void {
    if (this.failingSince === undefined) return

    getLogger().info(
      { outageMs: Date.now() - this.failingSince, failedAttempts: this.failures },
      this.recoveryMessage,
    )
    this.failingSince = undefined
    this.failures = 0
  }

  get isFailing(): boolean {
    return this.failingSince !== undefined
  }
}
