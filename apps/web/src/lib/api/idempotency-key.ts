'use client'
/*
 * One `Idempotency-Key` per logical submission — the header every posting
 * endpoint in M2 requires (journal-voucher.md §7, reversal.md §7: "required
 * key... a replay returns the original"). This is the one place apps/web
 * generates one, so every posting screen (New Voucher, Reverse, and whatever
 * else lands once the M2-B contract does) gets the same behaviour instead of
 * each re-deriving it: a key is minted once per form/dialog instance and
 * reused on every submit attempt of that SAME instance — including the retry
 * after a network failure or a rejected-then-corrected resubmit — so three
 * clicks (or three retries) produce one posting, never three. A genuinely new
 * submission (a fresh form, a fresh dialog) gets a fresh key.
 *
 * This does not decide whether a resubmit is "the same" attempt — the caller
 * does, by choosing when to call `reset()` versus leaving the key alone. This
 * module only owns key generation and storage.
 */
import { useCallback, useRef } from 'react'

/**
 * `crypto.randomUUID()` is available in every browser this product targets
 * and in the Vitest/jsdom test environment (`apps/web/src/test/setup.tsx`).
 * No fallback is provided deliberately — a UUID collision risk from a weaker
 * generator is not a trade this module makes quietly.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

export interface IdempotencyKeyController {
  /** The current key. Stable across re-renders until `reset()` is called. */
  readonly key: string
  /**
   * Mint a new key for a new logical submission — call this when the user
   * starts over (a fresh voucher, a fresh reversal dialog), never merely
   * because a submit failed and is being retried.
   */
  reset: () => string
}

/**
 * One key per mounted instance (a form, a confirm dialog), generated lazily
 * on first render and stable across re-renders — `useRef`, not `useState`,
 * because minting the key is not itself a state change the component needs
 * to re-render for.
 */
export function useIdempotencyKey(): IdempotencyKeyController {
  const ref = useRef<string | null>(null)
  if (ref.current === null) ref.current = newIdempotencyKey()

  const reset = useCallback(() => {
    ref.current = newIdempotencyKey()
    return ref.current
  }, [])

  return { key: ref.current, reset }
}
