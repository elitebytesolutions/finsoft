import type { Clock } from './clock.ts'

/*
 * Tenant-timezone date arithmetic. periods.md §5: "today" is computed on the
 * SERVER, in the tenant's timezone, from the injected clock — never the
 * client's clock, and never `new Date()` read directly by kernel code.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A real calendar date in YYYY-MM-DD. `2026-02-30` is refused here, as a
 * typed payload rejection, rather than reaching PostgreSQL's date cast — a
 * cast error there would abort the caller's transaction instead of producing
 * a PostingError.
 */
export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

/**
 * `clock.now()` rendered as YYYY-MM-DD in `timezone`. `en-CA` is used purely
 * as a formatting device: its short date format is already YYYY-MM-DD.
 */
export function todayInTimezone(clock: Clock, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(clock.now())
}
