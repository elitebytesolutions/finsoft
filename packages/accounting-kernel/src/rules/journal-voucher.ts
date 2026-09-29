import { Money } from '@finsoft/validation'
import {
  findAccountsByIds,
  type AccountRow,
  type NewJournalLine,
  type TenantTx,
} from '@finsoft/database'
import { PostingError } from '../errors.ts'
import {
  isUuid,
  parseNonNegativeMoney,
  requireArray,
  requireKnownKeys,
  requireNarration,
  requireOptionalString,
  requireRecord,
} from './shared.ts'

/*
 * JOURNAL_VOUCHER_POSTED@1. docs/posting-rules/journal-voucher.md.
 *
 * The ONE rule whose payload carries account ids directly rather than roles
 * (README §2.1) — it IS manual entry, fenced by coa-standard.md §3 instead.
 * No computation, therefore no rounding boundary (§5): the user's amounts are
 * the amounts, and an unbalanced voucher is rejected, never completed.
 */

export const JOURNAL_VOUCHER_RULE_ID = 'JOURNAL_VOUCHER_POSTED@1'
export const JOURNAL_VOUCHER_SERIES = 'JV'
export const JOURNAL_VOUCHER_SOURCE_TYPE = 'journal_voucher'

export interface JournalVoucherPayload {
  readonly narration: string
  readonly reference: string | null
  readonly lines: readonly {
    readonly accountId: string
    /** Exactly one of debit/credit is non-null, at 4 dp, > 0. */
    readonly debit: string | null
    readonly credit: string | null
    readonly memo: string | null
  }[]
}

const MIN_LINES = 2
const MAX_LINES = 200
const PAYLOAD_KEYS = ['narration', 'reference', 'lines'] as const
const LINE_KEYS = ['accountId', 'debit', 'credit', 'memo'] as const

/** §3 rows 1-6: payload shape only — no database access. Runs BEFORE idempotency. */
export function validateJournalVoucherPayload(payload: unknown): JournalVoucherPayload {
  const record = requireRecord(payload, 'payload')
  requireKnownKeys(record, PAYLOAD_KEYS, 'payload')
  const narration = requireNarration(record.narration, 500)
  const reference = requireOptionalString(record.reference, 'reference', 100)
  const rawLines = requireArray(record.lines, 'payload.lines')

  if (rawLines.length < MIN_LINES) {
    throw new PostingError('JV_TOO_FEW_LINES', `A voucher needs at least ${MIN_LINES} lines.`, {
      lineCount: String(rawLines.length),
    })
  }
  if (rawLines.length > MAX_LINES) {
    throw new PostingError('JV_TOO_MANY_LINES', `A voucher may have at most ${MAX_LINES} lines.`, {
      lineCount: String(rawLines.length),
    })
  }

  const lines = rawLines.map((raw, index) => {
    const field = `payload.lines[${index}]`
    const line = requireRecord(raw, field)
    requireKnownKeys(line, LINE_KEYS, field)
    if (typeof line.accountId !== 'string' || line.accountId.length === 0) {
      throw new PostingError('PAYLOAD_INVALID', `${field}.accountId is required.`, { field })
    }
    // §2: "the other key is absent, not 0.0000" — presence, not value, is the side.
    const hasDebit = line.debit !== undefined
    const hasCredit = line.credit !== undefined
    if (hasDebit && hasCredit) {
      throw new PostingError(
        'JV_LINE_BOTH_SIDES',
        `Line ${index + 1} carries both debit and credit.`,
        {
          line: String(index + 1),
        },
      )
    }
    if (!hasDebit && !hasCredit) {
      throw new PostingError(
        'JV_LINE_NO_SIDE',
        `Line ${index + 1} carries neither debit nor credit.`,
        {
          line: String(index + 1),
        },
      )
    }

    const side = hasDebit ? 'debit' : 'credit'
    const amount = parseNonNegativeMoney(line[side], `${field}.${side}`)
    if (Money.isZero(amount)) {
      throw new PostingError(
        'JV_ZERO_LINE',
        `Line ${index + 1}'s ${side} must be greater than zero.`,
        {
          line: String(index + 1),
        },
      )
    }
    // toString() emits exactly 4 dp; it cannot round (parse refused > 4 dp).
    const fixed = amount.toString()

    return {
      accountId: line.accountId,
      debit: hasDebit ? fixed : null,
      credit: hasCredit ? fixed : null,
      memo: requireOptionalString(line.memo, `${field}.memo`, 500),
    }
  })

  return { narration, reference, lines }
}

/** coa-standard.md §3 — the manual-JV fence, §3 rows 8-10. */
function assertManualJvEligible(account: AccountRow): void {
  if (account.kind !== 'POSTABLE') {
    throw new PostingError(
      'ACCOUNT_NOT_POSTABLE',
      `Account ${account.code} is a header, not postable.`,
      {
        accountId: account.id,
        account: account.code,
      },
    )
  }
  if (!account.isActive) {
    throw new PostingError('ACCOUNT_INACTIVE', `Account ${account.code} is inactive.`, {
      accountId: account.id,
      account: account.code,
    })
  }
  // ADR-0026: control_kind is NOT NULL, 'NONE' for a non-control account.
  if (account.controlKind !== 'NONE') {
    throw new PostingError(
      'ACCOUNT_CONTROL_MANUAL_FORBIDDEN',
      `Account ${account.code} is a ${account.controlKind} control account; control accounts move only through their documents.`,
      { accountId: account.id, account: account.code, controlKind: account.controlKind },
    )
  }
  if (account.restricted) {
    throw new PostingError(
      'ACCOUNT_RESTRICTED',
      `Account ${account.code} is restricted and cannot be posted to by a manual journal voucher.`,
      { accountId: account.id, account: account.code },
    )
  }
}

/**
 * §3 rows 7-12 and §4: accounts, then balance. Needs the database, so the
 * pipeline runs it only after idempotency and the period gate have passed.
 */
export async function buildJournalVoucherEntry(
  tx: TenantTx,
  tenantId: string,
  payload: JournalVoucherPayload,
): Promise<{ lines: readonly NewJournalLine[]; narration: string; reference: string | null }> {
  // A non-uuid id cannot exist; filtering it here keeps it away from the
  // uuid column, where a cast error would abort the caller's transaction.
  const accountIds = [...new Set(payload.lines.map((line) => line.accountId).filter(isUuid))]
  const accounts = await findAccountsByIds(tx, tenantId, accountIds)

  const debitAccounts = new Set<string>()
  const creditAccounts = new Set<string>()

  const lines: NewJournalLine[] = payload.lines.map((line, index) => {
    const account = accounts.get(line.accountId)
    if (!account) {
      // Same error whether unknown or another tenant's: RLS hides the row,
      // and existence elsewhere is never revealed (§3 row 7).
      throw new PostingError('ACCOUNT_NOT_FOUND', `Account ${line.accountId} was not found.`, {
        accountId: line.accountId,
      })
    }
    assertManualJvEligible(account)

    if (line.debit !== null) debitAccounts.add(account.id)
    if (line.credit !== null) creditAccounts.add(account.id)

    return {
      lineNumber: index + 1,
      accountId: account.id,
      // ADR-0026 statement 3: copied from the resolved account — for a JV
      // always 'NONE', since control accounts were refused above.
      accountControl: account.controlKind,
      debit: line.debit ?? '0.0000',
      credit: line.credit ?? '0.0000',
      // README §4.1: no party on a non-control line.
      partyType: null,
      partyId: null,
      memo: line.memo,
    }
  })

  const both = [...debitAccounts].filter((id) => creditAccounts.has(id))
  if (both.length > 0) {
    const account = accounts.get(both[0]!)!
    throw new PostingError(
      'JV_SAME_ACCOUNT_BOTH_SIDES',
      `Account ${account.code} appears on both the debit and the credit side.`,
      { accountId: account.id, account: account.code },
    )
  }

  // §3 row 12 / §5: exact, at storage scale, Money.sum + Money.equals, no tolerance.
  const totalDebit = Money.sum(lines.map((line) => Money.from(line.debit)))
  const totalCredit = Money.sum(lines.map((line) => Money.from(line.credit)))
  if (!Money.equals(totalDebit, totalCredit)) {
    const debit = Money.serialize(totalDebit, 4)
    const credit = Money.serialize(totalCredit, 4)
    const difference = Money.serialize(Money.abs(Money.subtract(totalDebit, totalCredit)), 4)
    throw new PostingError(
      'JV_UNBALANCED',
      `Voucher does not balance: debit ${debit}, credit ${credit}, difference ${difference}.`,
      { debit, credit, difference },
    )
  }

  return { lines, narration: payload.narration, reference: payload.reference }
}
