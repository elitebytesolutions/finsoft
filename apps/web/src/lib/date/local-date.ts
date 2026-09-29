/*
 * Default dates for accounting screens, from LOCAL date parts — never `toISOString()`, which is
 * UTC. Pakistan is UTC+5 with no daylight saving; between 00:00 and 05:00 PKT, `toISOString()`
 * still reports the PREVIOUS day, so a voucher's default date (and the ledger/cash-book default
 * range) silently landed a day early — on the 1st of a month, in the previous fiscal period.
 *
 * These are DISPLAY DEFAULTS only, never the authority on "today": the server resolves the
 * fiscal period and validates the date independently (periods.md §5 — "the client's clock is
 * never used"). Getting the default right is a UX correctness issue (a user who doesn't change
 * the pre-filled date should not silently post into the wrong period), not a posting-rule one.
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD` for `d` (default: now), using the browser's LOCAL calendar date. */
export function localIso(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Today, local date. */
export function todayIso(): string {
  return localIso()
}

/** The 1st of `d`'s (default: now) local month. */
export function startOfMonthIso(d: Date = new Date()): string {
  return localIso(new Date(d.getFullYear(), d.getMonth(), 1))
}
