import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localIso, startOfMonthIso, todayIso } from '@/lib/date/local-date'

/*
 * Accounting seat review, 09bbaad: `todayIso`/`startOfMonthIso` used `toISOString()`, which is
 * UTC. Pakistan is UTC+5 with no daylight saving, so between 00:00 and 05:00 PKT the UTC
 * calendar date is still YESTERDAY — on the 1st of a month, that silently defaults a new
 * voucher (and the ledger/cash-book range) into the PREVIOUS fiscal period. These tests pin the
 * clock to 02:00 PKT on 2026-09-01 (`2026-08-31T21:00:00.000Z` — PKT is five hours ahead of
 * UTC) and assert the LOCAL date, not the UTC one.
 */

const ORIGINAL_TZ = process.env.TZ

beforeEach(() => {
  // Deterministic regardless of the machine/CI runner's own timezone.
  process.env.TZ = 'Asia/Karachi'
})

afterEach(() => {
  vi.useRealTimers()
  process.env.TZ = ORIGINAL_TZ
})

describe('local-date (02:00 PKT on the 1st of a month)', () => {
  it('todayIso returns the LOCAL calendar date, not the UTC one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T21:00:00.000Z')) // 2026-09-01 02:00 PKT
    expect(todayIso()).toBe('2026-09-01')
  })

  it('startOfMonthIso returns the 1st of the CURRENT local month, not the previous one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T21:00:00.000Z')) // 2026-09-01 02:00 PKT
    expect(startOfMonthIso()).toBe('2026-09-01')
  })

  it('startOfMonthIso still returns the 1st mid-month', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T10:00:00.000Z')) // well inside PKT September 15th
    expect(startOfMonthIso()).toBe('2026-09-01')
  })

  it('is not fooled at the other end of the day either (23:00 PKT, still the same local date)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T18:30:00.000Z')) // 2026-09-01 23:30 PKT
    expect(todayIso()).toBe('2026-09-01')
  })

  it('localIso formats an explicit Date from its own local parts', () => {
    expect(localIso(new Date(2026, 8, 1))).toBe('2026-09-01') // month is 0-indexed (8 = September)
    expect(localIso(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
