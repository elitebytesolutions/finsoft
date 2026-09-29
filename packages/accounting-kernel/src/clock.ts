/*
 * An injectable clock for "today". BOARD.md Council item: the posting
 * engine's future-date check (periods.md §5) and the reversal date rule
 * (reversal.md §4) both need "today" in the tenant's timezone, and the
 * golden scenarios fix that value (`fixture.today`) rather than reading the
 * real system clock — a suite that depends on which day it happens to run is
 * not reproducible.
 *
 * Resolved as a plain `{ now(): Date }` object, not a class: `postingEngine`
 * is created once with a clock (`createPostingEngine`, posting-engine.ts)
 * rather than reading a module-level singleton, so a test can construct its
 * own engine with a fixed clock without any global mutable state to reset
 * between tests.
 */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export function fixedClock(iso: string): Clock {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`fixedClock: "${iso}" is not a valid date.`)
  }
  return { now: () => date }
}
