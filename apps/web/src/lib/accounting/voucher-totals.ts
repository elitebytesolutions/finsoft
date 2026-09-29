'use client'
/*
 * Dr/Cr totals for the New Voucher form — voucher-new/README.md §6: "Total
 * debit equals total credit exactly, computed with @finsoft/validation's
 * Money (never JS number arithmetic)."
 *
 * This is speed-of-feedback only (CLAUDE.md, "Forms": "Client validation is
 * for speed of feedback. The server's rejection is the truth"). It decides
 * nothing about whether a voucher MAY post — the server re-validates the
 * balance independently and rejects with `JV_UNBALANCED`, carrying its own
 * totals and difference, if it disagrees (journal-voucher.md §3 rule 12).
 * This module only tells the form whether the Post button should be enabled
 * and what to show in the totals bar while the user is typing.
 *
 * Money.from throws AmountError on a string that isn't plain decimal
 * notation (journal-voucher.md's AMOUNT_NOT_STRING / AMOUNT_SCALE /
 * AMOUNT_OUT_OF_RANGE family) — a half-typed cell ("", "-", "12.") is not a
 * form error, it's a user still typing, so blank/invalid input is treated as
 * a zero contribution to the running total rather than thrown. The server
 * still sees, and rejects, whatever was actually submitted; this module
 * never widens what is accepted at submit time, only what is tolerated while
 * live-totalling.
 */
import { Money, type Amount } from '@finsoft/validation'

/** One line's amount fields, exactly as the form holds them — strings, or
 * absent while the user hasn't typed anything into that side yet. */
export interface VoucherLineAmounts {
  debit?: string
  credit?: string
}

export interface VoucherTotals {
  /** Fixed-scale (4dp) decimal strings — feed straight to `MoneyCell`. */
  totalDebit: string
  totalCredit: string
  /** Always non-negative — `|totalDebit − totalCredit|`. */
  difference: string
  /**
   * True only when the two totals are exactly equal AND at least one side is
   * non-zero. Two all-zero columns are not "balanced" in any useful sense —
   * an empty voucher should not enable Post.
   */
  balanced: boolean
}

const SCALE = 4

/** Blank, undefined or unparseable → zero contribution to the running total.
 * A cell the user hasn't finished typing is not yet a value to sum. */
function parseLineAmount(raw: string | undefined): Amount<'Money'> {
  const trimmed = raw?.trim()
  if (!trimmed) return Money.zero()
  try {
    return Money.from(trimmed)
  } catch {
    return Money.zero()
  }
}

export function computeVoucherTotals(lines: readonly VoucherLineAmounts[]): VoucherTotals {
  const debits = lines.map((l) => parseLineAmount(l.debit))
  const credits = lines.map((l) => parseLineAmount(l.credit))

  const totalDebit = Money.sum(debits)
  const totalCredit = Money.sum(credits)
  const difference = Money.abs(Money.subtract(totalDebit, totalCredit))

  const balanced = Money.equals(totalDebit, totalCredit) && !Money.isZero(totalDebit)

  return {
    totalDebit: Money.serialize(totalDebit, SCALE),
    totalCredit: Money.serialize(totalCredit, SCALE),
    difference: Money.serialize(difference, SCALE),
    balanced,
  }
}
