/*
 * Maps `GET /api/ledgers/:accountId` (`AccountLedgerResponseDto`) into the `LedgerRow[]` shape
 * the restored `account-ledger.tsx` (from 8c5c283, via `ledger-data.ts`'s `buildLedger`) expects
 * — but WITHOUT that mock's arithmetic. The mock summed raw journal debit/credit numbers in the
 * browser to derive a running balance; the real ledger line already carries its own
 * `runningBalance`, computed server-side (ledger-and-trial-balance.md §2). This file only
 * reshapes and formats what the server sent — `formatRunningBalance` (money/running-balance.ts)
 * does the one presentation-only decimal→display step, same as every other M2 screen.
 */
import { moneyFromString } from '@finsoft/ui'
import { formatRunningBalance } from '@/lib/money/running-balance'
import type { LedgerLine, LedgerResponse } from '@/lib/api/accounting-types'

export type LedgerSide = 'Dr' | 'Cr'

export interface LedgerRow {
  date: string
  ref: string
  desc: string
  toBy: string
  /** Formatted, zero-as-dash — never a number to sum. */
  dr: string
  cr: string
  /** Formatted absolute running balance. */
  runningAmount: string
  runningSide: LedgerSide
  reversed: boolean
}

/*
 * The mock's "To/By {other account}" sub-line (ledger-data.ts) named the OTHER side of the
 * double entry — this account's ledger line does not carry that (`AccountLedgerLineDto` is
 * scoped to one account; the counter-account lives on a different line of the same entry,
 * which would mean an extra fetch per row to reconstruct — not worth it for a sub-caption).
 * This returns a real status/relationship fact when there is one, and an empty string
 * (rendered, not fabricated) otherwise — never the narration repeated as filler.
 */
function toByOf(line: LedgerLine): string {
  if (line.entryStatus === 'REVERSED') return 'Reversed'
  if (line.reversalOf) return 'Reverses an earlier entry'
  return ''
}

export function adaptLedgerLine(line: LedgerLine): LedgerRow {
  const running = formatRunningBalance(line.runningBalance)
  return {
    date: line.occurredAt,
    ref: line.entryNumber,
    desc: line.narration,
    toBy: toByOf(line),
    dr: moneyFromString(line.debit, { zeroAsDash: true }),
    cr: moneyFromString(line.credit, { zeroAsDash: true }),
    runningAmount: running.amount,
    runningSide: running.side,
    reversed: line.entryStatus === 'REVERSED',
  }
}

export interface AdaptedLedger {
  rows: LedgerRow[]
  opening: { amount: string; side: LedgerSide }
  closing: { amount: string; side: LedgerSide }
  count: number
}

export function adaptLedgerPages(pages: readonly LedgerResponse[]): AdaptedLedger {
  const first = pages[0]
  const last = pages[pages.length - 1]
  const allLines = pages.flatMap((p) => p.lines)
  return {
    rows: allLines.map(adaptLedgerLine),
    opening: formatRunningBalance(first.openingBalance),
    closing: formatRunningBalance(last.closingBalance),
    count: allLines.length,
  }
}
