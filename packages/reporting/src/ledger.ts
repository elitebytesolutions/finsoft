import {
  accountLedgerBalanceThrough,
  accountLedgerLines,
  accountOpeningBalance,
  LEDGER_PAGE_MAX,
  type LedgerCursor,
  type LedgerLineRow,
  type TenantTx,
} from '@finsoft/database'
import { Money, type Money as MoneyAmount } from '@finsoft/validation'

/*
 * The account ledger: opening balance, running balance per line, closing
 * balance. docs/posting-rules/ledger-and-trial-balance.md §2.
 *
 * The query bodies (which rows, in which order) live in
 * packages/database/src/accounting/ledger.ts. This file's job is the
 * arithmetic: turning raw {debit, credit} pairs into a single signed
 * running balance, using @finsoft/validation so nothing here does native
 * `number` arithmetic on money.
 *
 * "Running balance signed debit-positive" (ledger-and-trial-balance.md §2):
 * a net debit position is positive regardless of the account's own normal
 * balance side — an overdrawn bank account's ledger runs negative, exactly
 * as its trial balance row falls into the Credit column.
 */

export interface AccountLedgerLine {
  readonly lineId: string
  readonly entryId: string
  readonly entryNumber: string
  readonly entryStatus: 'POSTED' | 'REVERSED'
  readonly occurredAt: string
  readonly narration: string
  readonly sourceType: string
  readonly sourceId: string
  /** Set when this entry is itself a reversal of another. */
  readonly reversalOf: string | null
  /** Set when this entry has since been reversed by another. */
  readonly reversedBy: string | null
  readonly debit: string
  readonly credit: string
  /** Signed, debit-positive, running total through this line inclusive. */
  readonly runningBalance: string
}

export interface AccountLedgerOptions {
  /** Inclusive. */
  readonly from: string
  /** Inclusive. */
  readonly to: string
  readonly partyId?: string | null
  readonly limit?: number
  /** Pass back `AccountLedgerResult.next` unchanged to fetch the next page. */
  readonly after?: LedgerCursor | null
}

export interface AccountLedgerResult {
  readonly accountId: string
  readonly openingBalance: string
  readonly closingBalance: string
  readonly lines: readonly AccountLedgerLine[]
  readonly next: LedgerCursor | null
}

function toLine(row: LedgerLineRow, runningBalance: string): AccountLedgerLine {
  return {
    lineId: row.lineId,
    entryId: row.entryId,
    entryNumber: row.entryNumber,
    entryStatus: row.entryStatus,
    occurredAt: row.occurredAt,
    narration: row.narration,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    reversalOf: row.reversalOf,
    reversedBy: row.reversedBy,
    debit: row.debit,
    credit: row.credit,
    runningBalance,
  }
}

export async function accountLedger(
  tx: TenantTx,
  tenantId: string,
  accountId: string,
  options: AccountLedgerOptions,
): Promise<AccountLedgerResult> {
  const partyId = options.partyId ?? null
  const limit = options.limit ?? LEDGER_PAGE_MAX
  const after = options.after ?? null

  /*
   * M2-B Council ruling, 2026-09-29: the carry-forward balance for a resumed
   * page is RECOMPUTED here from the cursor's POSITION, never trusted from
   * the caller. Mathematically this is the opening balance (everything
   * strictly before `from`) plus everything from `from` through the cursor
   * row inclusive — accountLedgerBalanceThrough's own `from` bound makes
   * that addition explicit and auditable, even though (because a cursor
   * position is always >= from) it is also exactly the running balance
   * accountLedger itself would have accumulated by that row on a single,
   * unpaged pass.
   */
  let running: MoneyAmount
  if (after === null) {
    const opening = await accountOpeningBalance(tx, tenantId, accountId, options.from, partyId)
    running = Money.subtract(Money.from(opening.debit), Money.from(opening.credit))
  } else {
    const through = await accountLedgerBalanceThrough(
      tx,
      tenantId,
      accountId,
      options.from,
      after,
      partyId,
    )
    running = Money.subtract(Money.from(through.debit), Money.from(through.credit))
  }
  const openingBalance = Money.serialize(running, 4)

  const page = await accountLedgerLines(
    tx,
    tenantId,
    accountId,
    options.from,
    options.to,
    partyId,
    { limit, after },
  )

  const lines: AccountLedgerLine[] = []
  for (const row of page.rows) {
    const movement = Money.subtract(Money.from(row.debit), Money.from(row.credit))
    running = Money.add(running, movement)
    lines.push(toLine(row, Money.serialize(running, 4)))
  }

  return {
    accountId,
    openingBalance,
    closingBalance: Money.serialize(running, 4),
    lines,
    next: page.next,
  }
}
