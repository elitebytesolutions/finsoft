import { partyControlBalance, type TenantTx } from '@finsoft/database'
import { Money } from '@finsoft/validation'

/*
 * Subledger balance for a single party against a control account.
 * docs/posting-rules/customer-receipt.md §8, ADR-0026 statement 6.
 *
 * `partyControlBalance` (packages/database) sums every journal_lines row
 * carrying this party's id on a line of the given control kind — the GL
 * half of Invariant 9's reconciliation. This module only nets the raw
 * {debit, credit} pair into a single signed figure. There is no separate
 * subledger table to reconcile against in M2: the "subledger" for a
 * customer, until M3's sales_invoice/customer_receipt modules exist, IS
 * this GL query, filtered by party.
 */

export interface SubledgerBalance {
  readonly partyId: string
  readonly controlKind: 'AR' | 'AP'
  readonly asOf: string
  /** Signed, debit-positive: a customer with a positive balance owes this amount. */
  readonly balance: string
}

async function partySubledgerBalance(
  tx: TenantTx,
  tenantId: string,
  controlKind: 'AR' | 'AP',
  partyId: string,
  asOf: string,
): Promise<SubledgerBalance> {
  const { debit, credit } = await partyControlBalance(tx, tenantId, controlKind, partyId, asOf)
  const balance = Money.subtract(Money.from(debit), Money.from(credit))
  return { partyId, controlKind, asOf, balance: Money.serialize(balance, 4) }
}

/** AR balance for one customer (party_type CUSTOMER), as of `asOf`. */
export function customerSubledgerBalance(
  tx: TenantTx,
  tenantId: string,
  customerId: string,
  asOf: string,
): Promise<SubledgerBalance> {
  return partySubledgerBalance(tx, tenantId, 'AR', customerId, asOf)
}

/** AP balance for one vendor (party_type VENDOR), as of `asOf`. Wave 6. */
export function vendorSubledgerBalance(
  tx: TenantTx,
  tenantId: string,
  vendorId: string,
  asOf: string,
): Promise<SubledgerBalance> {
  return partySubledgerBalance(tx, tenantId, 'AP', vendorId, asOf)
}
