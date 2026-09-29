import { sql, type RawBuilder } from 'kysely'

/*
 * Reading a PostgreSQL `date` column as an ISO `YYYY-MM-DD` string, without
 * a driver type-parser override.
 *
 * ADR-0013 forbids `setTypeParser` repository-wide, for every type, so node-
 * postgres's default `date` parsing stands: it builds `new Date(year,
 * month - 1, day)` at LOCAL midnight of the process timezone. Reading that
 * value back with the LOCAL getters therefore returns exactly the calendar
 * date the database stored, in any process timezone. Never use the UTC
 * getters or `toISOString()` here — east of UTC, local midnight is the
 * previous UTC day — and never `String(value).slice(0, 10)`, which yields
 * "Wed Jul 01".
 *
 * A string input (a value already formatted in SQL) is accepted if it
 * starts with an ISO date. Anything else fails loudly.
 */
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/

export function calendarDate(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('calendarDate: invalid Date')
    const y = String(value.getFullYear()).padStart(4, '0')
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof value === 'string') {
    const match = ISO_DATE.exec(value)
    if (match?.[1] !== undefined) return match[1]
  }
  throw new Error(`calendarDate: not a date value: ${String(value)}`)
}

const STRICT_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * An ISO `YYYY-MM-DD` string as a `date` query parameter: bound as text and
 * cast in SQL, so no JS `Date` (and no process timezone) is ever involved.
 * Typed `Date` only because the generated schema types a `date` column's
 * read side as `Date`, which is what node-postgres returns.
 */
export function sqlDate(iso: string): RawBuilder<Date> {
  if (!STRICT_ISO_DATE.test(iso)) throw new Error(`sqlDate: not an ISO date: ${iso}`)
  return sql<Date>`${iso}::date`
}
