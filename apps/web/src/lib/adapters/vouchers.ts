/*
 * Maps the real journal API (`GET /api/journals`, `GET /api/journals/:id`) into the shapes
 * `voucher-register.tsx` and `vouchers.tsx` (restored from 8c5c283) consume. The mock's
 * `Voucher`/`VoucherLine` (voucher-data.ts) modelled a fixed dr-account/cr-account pair per
 * line and several voucher "types" (JV/CRV/CPV/BRV/BPV/CV/SINV/PINV) with a Draft/Posted/
 * Cancelled status. None of that exists in the real M2 posting model:
 *
 *   - every manually-posted entry is a generic Journal Voucher (event
 *     JOURNAL_VOUCHER_POSTED — apps/api/src/accounting/journals.controller.ts); there is no
 *     server-side CRV/CPV/BRV/BPV/CV/SINV/PINV distinction to adapt TO, so every entry here
 *     is labelled 'JV' — see the M2-UI report's DECISIONS.
 *   - a line is one account with EITHER a debit OR a credit (JournalLineDto), not a paired
 *     dr-account/cr-account row — an entry can have any N debits and M credits, which the
 *     mock's paired shape cannot represent. `AdaptedVoucherLine` keeps the real per-line shape;
 *     the restored detail screen renders one row per line, not a synthesised pairing.
 *   - status is POSTED or REVERSED only — there is no Draft/Cancelled/Pending state to fake.
 */
import { Money } from '@finsoft/validation'
import { moneyFromString } from '@finsoft/ui'
import type {
  AccountDto,
  JournalEntryDetail,
  JournalEntryLine,
  JournalEntrySummary,
} from '@/lib/api/accounting-types'

export type AdaptedVoucherStatus = 'Posted' | 'Reversed'

export interface AdaptedVoucherSummary {
  id: string
  entryNumber: string
  date: string
  narration: string
  reference: string | null
  status: AdaptedVoucherStatus
  isReversal: boolean
}

export function adaptVoucherSummary(entry: JournalEntrySummary): AdaptedVoucherSummary {
  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    date: entry.occurredAt,
    narration: entry.narration,
    reference: entry.reference,
    status: entry.status === 'REVERSED' ? 'Reversed' : 'Posted',
    isReversal: entry.reversalOf !== null,
  }
}

export interface AdaptedVoucherLine {
  lineNumber: number
  accountName: string
  /** Formatted, zero-as-dash. */
  debit: string
  credit: string
  memo: string
}

export function nameOfAccount(accounts: readonly AccountDto[], accountId: string): string {
  const a = accounts.find((x) => x.id === accountId)
  return a ? `${a.name} (${a.code})` : accountId
}

export function adaptVoucherLines(
  lines: readonly JournalEntryLine[],
  accounts: readonly AccountDto[],
): AdaptedVoucherLine[] {
  return lines.map((l) => ({
    lineNumber: l.lineNumber,
    accountName: nameOfAccount(accounts, l.accountId),
    debit: moneyFromString(l.debit, { zeroAsDash: true }),
    credit: moneyFromString(l.credit, { zeroAsDash: true }),
    memo: l.memo ?? '—',
  }))
}

/**
 * The entry's total — the sum of its debit-side lines, which by Invariant 1 always equals
 * the sum of its credit-side lines for a POSTED entry (the server enforces this before ever
 * writing the row; this reads already-balanced amounts, it does not decide whether they
 * balance). `Money.sum`, never JS `+` on parsed floats — same rule as every other rollup in
 * this codebase (see the chart-of-accounts adapter's own note).
 */
export function adaptVoucherTotal(entry: JournalEntryDetail): string {
  const total = Money.sum(entry.lines.map((l) => Money.from(l.debit)))
  return moneyFromString(Money.serialize(total, 4))
}
