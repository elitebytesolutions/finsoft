import { describe, expect, it } from 'vitest'
import { fixedClock } from './clock.ts'
import { isIsoCalendarDate, todayInTimezone } from './dates.ts'
import { KernelInvariantError, PostingError } from './errors.ts'
import { assertEntryWellFormed, assertIdempotencyKey } from './posting-engine.ts'
import { validateJournalVoucherPayload } from './rules/journal-voucher.ts'

/*
 * Pure unit tests — no database. The kernel's behaviour against PostgreSQL
 * (golden scenarios P01/P02/P03/P07/P08, the FinancialInvariantSuite, the
 * party register) is proven in tests/accounting/**.
 */

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    if (error instanceof PostingError) return error.code
    throw error
  }
  return 'NO ERROR'
}

describe('today, in the tenant timezone, from the injected clock (periods.md §5)', () => {
  it('is the calendar day in Asia/Karachi, not in UTC', () => {
    // 20:30 UTC on the 27th is 01:30 on the 28th in Karachi (UTC+5).
    expect(todayInTimezone(fixedClock('2026-09-27T20:30:00.000Z'), 'Asia/Karachi')).toBe(
      '2026-09-28',
    )
    expect(todayInTimezone(fixedClock('2026-09-27T18:59:59.000Z'), 'Asia/Karachi')).toBe(
      '2026-09-27',
    )
  })

  it('accepts only real calendar dates', () => {
    expect(isIsoCalendarDate('2026-09-27')).toBe(true)
    expect(isIsoCalendarDate('2027-02-29')).toBe(false)
    expect(isIsoCalendarDate('2026-9-27')).toBe(false)
    expect(isIsoCalendarDate(20260927)).toBe(false)
  })
})

describe('idempotency key format (README §4)', () => {
  it.each(['a', 'p08-jv-1', 'x'.repeat(128), '3f2c1a9e-0000-4000-8000-000000000000', 'a.b:c_d-e'])(
    'accepts %s',
    (key) => {
      expect(() => assertIdempotencyKey(key)).not.toThrow()
    },
  )
  it.each(['', 'x'.repeat(129), 'has space', 'semi;colon', 'slash/'])('refuses %j', (key) => {
    expect(codeOf(() => assertIdempotencyKey(key))).toBe('PAYLOAD_INVALID')
  })
})

describe('JOURNAL_VOUCHER_POSTED@1 payload shape (journal-voucher.md §3 rows 1-6)', () => {
  const line = (side: 'debit' | 'credit', amount: unknown) => ({ accountId: 'a', [side]: amount })
  const voucher = (lines: unknown[], extra: Record<string, unknown> = {}) => ({
    narration: 'n',
    lines,
    ...extra,
  })

  it.each([
    ['one line', voucher([line('debit', '1.0000')]), 'JV_TOO_FEW_LINES'],
    [
      '201 lines',
      voucher(Array.from({ length: 201 }, () => line('debit', '1.0000'))),
      'JV_TOO_MANY_LINES',
    ],
    ['a zero line', voucher([line('debit', '0.0000'), line('credit', '1.0000')]), 'JV_ZERO_LINE'],
    [
      'both sides',
      voucher([{ accountId: 'a', debit: '1.0000', credit: '1.0000' }, line('credit', '1.0000')]),
      'JV_LINE_BOTH_SIDES',
    ],
    ['no side', voucher([{ accountId: 'a' }, line('credit', '1.0000')]), 'JV_LINE_NO_SIDE'],
    [
      'a negative amount',
      voucher([line('debit', '-1.0000'), line('credit', '1.0000')]),
      'AMOUNT_NEGATIVE',
    ],
    [
      'five decimals',
      voucher([line('debit', '1.00001'), line('credit', '1.0000')]),
      'AMOUNT_SCALE',
    ],
    ['a JSON number', voucher([line('debit', 1), line('credit', '1.0000')]), 'AMOUNT_NOT_STRING'],
    ['hexadecimal', voucher([line('debit', '0x1f'), line('credit', '1.0000')]), 'PAYLOAD_INVALID'],
    [
      'past numeric(19,4)',
      voucher([line('debit', '1000000000000000'), line('credit', '1.0000')]),
      'AMOUNT_OUT_OF_RANGE',
    ],
    [
      'a blank narration',
      { narration: '   ', lines: [line('debit', '1.0000'), line('credit', '1.0000')] },
      'NARRATION_REQUIRED',
    ],
    [
      'a narration of 501 chars',
      { narration: 'x'.repeat(501), lines: [line('debit', '1.0000'), line('credit', '1.0000')] },
      'NARRATION_TOO_LONG',
    ],
    [
      'an unknown payload key',
      voucher([line('debit', '1.0000'), line('credit', '1.0000')], { taxAmount: '0.0000' }),
      'PAYLOAD_INVALID',
    ],
    [
      'an unknown line key',
      voucher([{ ...line('debit', '1.0000'), partyId: 'p' }, line('credit', '1.0000')]),
      'PAYLOAD_INVALID',
    ],
  ])('refuses %s', (_label, payload, code) => {
    expect(codeOf(() => validateJournalVoucherPayload(payload))).toBe(code)
  })

  it('normalises amounts to exactly 4 dp and keeps the absent side absent', () => {
    const valid = validateJournalVoucherPayload(
      voucher([line('debit', '1249.5'), line('credit', '1249.5000')]),
    )
    expect(valid.lines.map((l) => [l.debit, l.credit])).toEqual([
      ['1249.5000', null],
      [null, '1249.5000'],
    ])
  })
})

describe('step 7: every built entry is well-formed and balances exactly (rule 1)', () => {
  const line = (
    n: number,
    debit: string,
    credit: string,
    control: 'NONE' | 'AR' = 'NONE',
    partyId: string | null = null,
  ) => ({
    lineNumber: n,
    accountId: `acc-${n}`,
    accountControl: control,
    debit,
    credit,
    partyType: partyId === null ? null : ('CUSTOMER' as const),
    partyId,
    memo: null,
  })

  it('accepts a balanced entry, including an AR line that carries its customer', () => {
    expect(() =>
      assertEntryWellFormed([
        line(1, '10.0000', '0.0000', 'AR', 'c-1'),
        line(2, '0.0000', '10.0000'),
      ]),
    ).not.toThrow()
  })

  it.each([
    ['out by 0.0001', [line(1, '10.0000', '0.0000'), line(2, '0.0000', '9.9999')]],
    ['a single line', [line(1, '10.0000', '0.0000')]],
    ['a line with both sides', [line(1, '10.0000', '10.0000'), line(2, '0.0000', '0.0000')]],
    ['a duplicate line number', [line(1, '10.0000', '0.0000'), line(1, '0.0000', '10.0000')]],
    [
      'an AR line without a customer',
      [line(1, '10.0000', '0.0000', 'AR'), line(2, '0.0000', '10.0000')],
    ],
    [
      'a non-control line with a party',
      [line(1, '10.0000', '0.0000', 'NONE', 'c-1'), line(2, '0.0000', '10.0000')],
    ],
  ])('reports %s as a kernel defect, never completing it', (_label, lines) => {
    expect(() => assertEntryWellFormed(lines)).toThrow(KernelInvariantError)
  })
})
