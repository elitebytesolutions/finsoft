/*
 * Accounting HTTP API response shapes. docs/design/M2/api-contract.md.
 *
 * Money crosses the wire as a decimal string everywhere (ADR-0011) — never
 * a JSON number. These are the WIRE shapes apps/api actually returns; the
 * M2-S screens lane imports the same definitions rather than a second,
 * hand-copied set that can drift from what the API sends.
 */

export interface JournalLineDto {
  readonly lineNumber: number
  readonly accountId: string
  readonly debit: string
  readonly credit: string
  readonly partyId: string | null
  readonly memo: string | null
}

export interface JournalEntryDto {
  readonly id: string
  readonly entryNumber: string
  readonly postingRule: string
  readonly event: string
  readonly occurredAt: string
  readonly status: 'POSTED' | 'REVERSED'
  readonly narration: string
  readonly reference: string | null
  readonly sourceType: string
  readonly sourceId: string
  readonly reversalOf: string | null
  readonly reversedBy: string | null
  readonly reversalReason: string | null
}

export interface JournalEntryWithLinesDto extends JournalEntryDto {
  readonly lines: readonly JournalLineDto[]
}

export interface PostJournalVoucherResponseDto extends JournalEntryWithLinesDto {
  readonly outcome: 'POSTED' | 'REPLAYED'
}

export interface ReverseJournalEntryResponseDto extends JournalEntryWithLinesDto {
  readonly outcome: 'POSTED' | 'REPLAYED'
  readonly disclosure: {
    readonly originalPeriod: string
    readonly originalPeriodStatus: string
  } | null
}

export interface JournalListResponseDto {
  readonly items: readonly JournalEntryDto[]
  readonly nextCursor: string | null
}

export interface AccountLedgerLineDto {
  readonly lineId: string
  readonly entryId: string
  readonly entryNumber: string
  readonly entryStatus: 'POSTED' | 'REVERSED'
  readonly occurredAt: string
  readonly narration: string
  readonly sourceType: string
  readonly sourceId: string
  readonly reversalOf: string | null
  readonly reversedBy: string | null
  readonly debit: string
  readonly credit: string
  /** Signed, debit-positive, running total through this line inclusive. */
  readonly runningBalance: string
}

export interface AccountLedgerResponseDto {
  readonly accountId: string
  readonly code: string
  readonly name: string
  readonly type: string
  readonly openingBalance: string
  readonly closingBalance: string
  readonly lines: readonly AccountLedgerLineDto[]
  readonly nextCursor: string | null
}

export interface TrialBalanceLineDto {
  readonly accountId: string
  readonly code: string
  readonly name: string
  readonly type: string
  readonly debit: string
  readonly credit: string
}

export interface TrialBalanceResponseDto {
  readonly asOf: string
  readonly lines: readonly TrialBalanceLineDto[]
  readonly totalDebit: string
  readonly totalCredit: string
}

/** GET /api/accounts. coa-standard.md. Read-only in M2 — see the contract doc §5. */
export interface AccountDto {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly type: string
  readonly normalBalance: 'DEBIT' | 'CREDIT'
  readonly kind: 'HEADER' | 'POSTABLE'
  readonly controlKind: 'NONE' | 'AR' | 'AP' | 'INVENTORY'
  readonly role: string | null
  readonly restricted: boolean
  /** Null for a HEADER account. The tree's edges. */
  readonly parentId: string | null
  readonly isActive: boolean
}

export interface AccountsResponseDto {
  readonly accounts: readonly AccountDto[]
}

/** GET /api/periods, POST /api/periods/:id/{close,reopen}. periods.md. */
export interface FiscalPeriodDto {
  readonly id: string
  readonly fiscalYear: number
  readonly periodIndex: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly label: string
  readonly status: 'OPEN' | 'CLOSED' | 'LOCKED'
}

export interface PeriodsResponseDto {
  readonly periods: readonly FiscalPeriodDto[]
}
