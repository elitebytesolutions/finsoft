import { trialBalanceRawSums, type TenantTx } from '@finsoft/database'
import { Money } from '@finsoft/validation'

/*
 * Trial balance as of any date. docs/posting-rules/ledger-and-trial-balance.md
 * §3. Sums come straight from journal_lines (trialBalanceRawSums, in
 * packages/database) — there is no cached balance to read instead, in M2 or
 * ever, for this report.
 *
 * The column a balance falls into follows the SIGN of the net balance, not
 * the account's own normal_balance side: an overdrawn bank account (an
 * ASSET, normally Debit) shows in the Credit column. This is presentation
 * math, so it lives here, not in the SQL.
 */

export interface TrialBalanceLine {
  readonly accountId: string
  readonly code: string
  readonly name: string
  readonly type: string
  readonly debit: string
  readonly credit: string
}

export interface TrialBalanceResult {
  readonly asOf: string
  readonly lines: readonly TrialBalanceLine[]
  readonly totalDebit: string
  readonly totalCredit: string
}

/**
 * Which column a raw {debit, credit} sum presents in, and at what figure.
 *
 * Pure — no database, no I/O — so this is where the domain invariant
 * ("the column follows the SIGN of the net balance, not the account's own
 * normal_balance side") gets a real unit test, independent of the SQL and
 * of a Postgres connection.
 */
export function presentTrialBalanceRow(
  debit: string,
  credit: string,
): {
  readonly debit: string
  readonly credit: string
  readonly net: Money
} {
  const net = Money.subtract(Money.from(debit), Money.from(credit))
  // net > 0 or net == 0 -> Debit column (net == 0 shows 0.0000 on both
  // sides, but the row is still returned — a zero-balance account with
  // activity is not the same as an account with none).
  const presentedDebit = Money.isNegative(net) ? Money.zero() : net
  const presentedCredit = Money.isNegative(net) ? Money.abs(net) : Money.zero()
  return {
    debit: Money.serialize(presentedDebit, 4),
    credit: Money.serialize(presentedCredit, 4),
    net,
  }
}

export async function trialBalance(
  tx: TenantTx,
  tenantId: string,
  asOf: string,
): Promise<TrialBalanceResult> {
  const rows = await trialBalanceRawSums(tx, tenantId, asOf)

  let totalDebit = Money.zero()
  let totalCredit = Money.zero()

  const lines = rows.map((row): TrialBalanceLine => {
    const presented = presentTrialBalanceRow(row.debit, row.credit)
    totalDebit = Money.add(totalDebit, Money.from(presented.debit))
    totalCredit = Money.add(totalCredit, Money.from(presented.credit))

    return {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      debit: presented.debit,
      credit: presented.credit,
    }
  })

  return {
    asOf,
    lines,
    totalDebit: Money.serialize(totalDebit, 4),
    totalCredit: Money.serialize(totalCredit, 4),
  }
}
