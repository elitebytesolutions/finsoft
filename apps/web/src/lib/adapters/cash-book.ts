/*
 * Builds a `PostJournalRequest` body from the restored Cash Book entry form (8c5c283's
 * `cashbook.tsx` — the "Cash In" / "Cash Out" quick-entry panels). This is the one place the
 * restored cash-book screen touches the posting API: there is no dedicated cash-in/cash-out
 * endpoint (M2-S's own note on the real `cashbook.tsx`: "cash entries are recorded via a
 * Journal Voucher"), so a Cash In/Out entry is, correctly, a plain two-line balanced JV —
 * Dr Cash / Cr the chosen account for money in, Dr the chosen account / Cr Cash for money out.
 *
 * This only shapes the request. It does not decide whether the amount is valid, whether the
 * accounts exist, or whether the period is open — the server does, same as every other posting
 * screen (journal-voucher.md). The caller still owns idempotency key + confirm-before-post.
 */
import type { PostJournalLineInput, PostJournalRequest } from '@/lib/api/accounting-types'

export interface CashEntryInput {
  kind: 'In' | 'Out'
  cashAccountId: string
  counterAccountId: string
  /** Decimal string, exactly as typed — never parsed to a number here. */
  amount: string
  date: string
  party: string
  reference: string
  notes: string
}

export function buildCashEntryRequest(input: CashEntryInput): PostJournalRequest {
  const cashLine: PostJournalLineInput =
    input.kind === 'In'
      ? { accountId: input.cashAccountId, debit: input.amount }
      : { accountId: input.cashAccountId, credit: input.amount }
  const counterLine: PostJournalLineInput =
    input.kind === 'In'
      ? { accountId: input.counterAccountId, credit: input.amount }
      : { accountId: input.counterAccountId, debit: input.amount }

  const partyNote = input.party.trim()
    ? ` — ${input.kind === 'In' ? 'from' : 'to'} ${input.party.trim()}`
    : ''
  const notesSuffix = input.notes.trim() ? `. ${input.notes.trim()}` : ''

  return {
    occurredAt: input.date,
    narration: `Cash ${input.kind === 'In' ? 'received' : 'paid'}${partyNote}${notesSuffix}`,
    reference: input.reference.trim() || null,
    lines: [cashLine, counterLine],
  }
}
