import { resolveAccountsByRole, type NewJournalLine, type TenantTx } from '@finsoft/database'
import { PostingError } from '../errors.ts'
import { assertPartiesRegistered } from '../parties.ts'
import { requireResolvedRole } from './roles.ts'
import {
  isUuid,
  parsePositiveMoney,
  requireArray,
  requireKnownKeys,
  requireRecord,
} from './shared.ts'

/*
 * CUSTOMER_PAYMENT_RECEIVED@1. docs/posting-rules/customer-receipt.md.
 *
 * STATUS: rule logic built in M2; NOT ENABLED — see service-sale.ts. Its
 * golden (P05) needs M3's receipt and invoice tables.
 *
 * §3: "Rows 3-7 are the module's subledger rules; the kernel sees only the
 * customer and the amount." Allocations are carried in the payload (and so in
 * the idempotency fingerprint) but are not a GL fact (§4): exactly two lines,
 * whatever the number of allocations.
 */

export const CUSTOMER_RECEIPT_RULE_ID = 'CUSTOMER_PAYMENT_RECEIVED@1'
export const RECEIPT_SERIES = 'JE'
export const RECEIPT_SOURCE_TYPE = 'customer_receipt'

export interface CustomerReceiptPayload {
  readonly customerId: string
  readonly method: 'CASH' | 'BANK'
  readonly amount: string
}

const PAYLOAD_KEYS = ['customerId', 'method', 'amount', 'allocations'] as const

/** §3 rows 1-2: shape — no database access. */
export function validateCustomerReceiptPayload(payload: unknown): CustomerReceiptPayload {
  const record = requireRecord(payload, 'payload')
  requireKnownKeys(record, PAYLOAD_KEYS, 'payload')

  if (record.method !== 'CASH' && record.method !== 'BANK') {
    throw new PostingError(
      'PAYLOAD_INVALID',
      `method must be CASH or BANK, got "${String(record.method)}".`,
      {
        field: 'payload.method',
      },
    )
  }
  if (!isUuid(record.customerId)) {
    throw new PostingError('PAYLOAD_INVALID', 'payload.customerId must be a uuid.', {
      field: 'payload.customerId',
    })
  }
  const amount = parsePositiveMoney(record.amount, 'payload.amount')
  // Shape only; the module owns allocation rules (§3 rows 3-7).
  requireArray(record.allocations, 'payload.allocations').forEach((entry, index) =>
    requireRecord(entry, `payload.allocations[${index}]`),
  )

  return { customerId: record.customerId, method: record.method, amount: amount.toString() }
}

/** §3 row 10, §4: role resolution, the party pre-check, and the two-line entry. */
export async function buildCustomerReceiptEntry(
  tx: TenantTx,
  tenantId: string,
  payload: CustomerReceiptPayload,
): Promise<{ lines: readonly NewJournalLine[]; narration: string; reference: string | null }> {
  const settlementRole = payload.method === 'CASH' ? 'CASH_DEFAULT' : 'BANK_DEFAULT'
  const accounts = await resolveAccountsByRole(tx, tenantId, ['AR_CONTROL', settlementRole])
  const arControl = requireResolvedRole(accounts, 'AR_CONTROL', {
    type: 'ASSET',
    controlKind: 'AR',
  })
  const settlement = requireResolvedRole(accounts, settlementRole, {
    type: 'ASSET',
    controlKind: 'NONE',
  })

  await assertPartiesRegistered(tx, tenantId, [
    { partyId: payload.customerId, partyType: 'CUSTOMER' },
  ])

  const lines: NewJournalLine[] = [
    {
      lineNumber: 1,
      accountId: settlement.id,
      accountControl: settlement.controlKind,
      debit: payload.amount,
      credit: '0.0000',
      partyType: null,
      partyId: null,
      memo: null,
    },
    {
      lineNumber: 2,
      accountId: arControl.id,
      accountControl: arControl.controlKind,
      debit: '0.0000',
      credit: payload.amount,
      partyType: 'CUSTOMER',
      partyId: payload.customerId,
      memo: null,
    },
  ]

  return {
    lines,
    narration: `Customer receipt: ${payload.method} ${payload.amount}`,
    reference: null,
  }
}
