import { Money, Quantity, Rounding, UnitCost } from '@finsoft/validation'
import { resolveAccountsByRole, type NewJournalLine, type TenantTx } from '@finsoft/database'
import { PostingError } from '../errors.ts'
import { assertPartiesRegistered } from '../parties.ts'
import { requireResolvedRole } from './roles.ts'
import {
  isUuid,
  parsePositiveMoney,
  parseQuantity,
  parseUnitCost,
  requireArray,
  requireKnownKeys,
  requireRecord,
} from './shared.ts'

/*
 * SALE_POSTED/service@1. docs/posting-rules/service-sale.md.
 *
 * STATUS: rule logic built in M2; NOT ENABLED. README §3: a rule is
 * IMPLEMENTED only when its golden scenarios (P04, P10) execute in the
 * financial gate, and those need M3's customer and invoice tables. Until then
 * `postingEngine.post(SALE_POSTED)` is RULE_NOT_ENABLED (posting-engine.ts,
 * IMPLEMENTED_EVENTS), and M3 enables it in the same PR its goldens go green.
 *
 * §4 row 7 (customer exists and is active) is the MODULE's check. What the
 * kernel checks instead is ADR-0026 statement 6: the customer id is a
 * registered CUSTOMER party of this tenant.
 */

export const SERVICE_SALE_RULE_ID = 'SALE_POSTED/service@1'
export const SALE_SERIES = 'JE'
export const SALE_SOURCE_TYPE = 'sales_invoice'

export interface ServiceSalePayload {
  readonly customerId: string
  readonly lineCount: number
  /** Σ lineNet at 4 dp — equal, by §4 row 6, to the submitted netAmount. */
  readonly netAmount: string
}

const MIN_LINES = 1
const MAX_LINES = 200
const PAYLOAD_KEYS = ['settlement', 'customerId', 'lines', 'netAmount'] as const
const LINE_KEYS = ['kind', 'description', 'quantity', 'unitPrice', 'lineNet'] as const

/** §4 rows 1-6: shape and the ONE rounding boundary (§6) — no database access. */
export function validateServiceSalePayload(payload: unknown): ServiceSalePayload {
  const record = requireRecord(payload, 'payload')
  // §3: a tax or discount key is PAYLOAD_INVALID, never an implicit zero.
  requireKnownKeys(record, PAYLOAD_KEYS, 'payload')

  if (record.settlement !== 'CREDIT') {
    throw new PostingError(
      'SALE_SETTLEMENT_NOT_ENABLED',
      `settlement "${String(record.settlement)}" is not enabled in the MVP; only CREDIT.`,
      { settlement: String(record.settlement) },
    )
  }
  if (!isUuid(record.customerId)) {
    throw new PostingError('PAYLOAD_INVALID', 'payload.customerId must be a uuid.', {
      field: 'payload.customerId',
    })
  }

  const rawLines = requireArray(record.lines, 'payload.lines')
  if (rawLines.length < MIN_LINES) {
    throw new PostingError('SALE_NO_LINES', 'An invoice needs at least one line.')
  }
  if (rawLines.length > MAX_LINES) {
    throw new PostingError('SALE_TOO_MANY_LINES', `An invoice may have at most ${MAX_LINES} lines.`)
  }

  let runningTotal = Money.zero()
  rawLines.forEach((raw, index) => {
    const field = `payload.lines[${index}]`
    const line = requireRecord(raw, field)
    requireKnownKeys(line, LINE_KEYS, field)
    if (line.kind !== 'SERVICE') {
      throw new PostingError(
        'SALE_LINE_KIND_NOT_ENABLED',
        `Line kind "${String(line.kind)}" is not enabled in the MVP; only SERVICE.`,
        { line: String(index + 1), kind: String(line.kind) },
      )
    }
    if (typeof line.description !== 'string' || line.description.trim().length === 0) {
      throw new PostingError('PAYLOAD_INVALID', `${field}.description is required.`, { field })
    }

    const quantity = parseQuantity(line.quantity, `${field}.quantity`)
    const unitPrice = parseUnitCost(line.unitPrice, `${field}.unitPrice`)
    if (Quantity.isZero(quantity) || Quantity.isNegative(quantity)) {
      throw new PostingError(
        'SALE_LINE_NON_POSITIVE',
        `Line ${index + 1}'s quantity must be > 0.`,
        {
          line: String(index + 1),
        },
      )
    }
    if (UnitCost.isZero(unitPrice) || UnitCost.isNegative(unitPrice)) {
      throw new PostingError(
        'SALE_LINE_NON_POSITIVE',
        `Line ${index + 1}'s unitPrice must be > 0.`,
        {
          line: String(index + 1),
        },
      )
    }

    const submittedLineNet = parsePositiveMoney(line.lineNet, `${field}.lineNet`)
    // §6: THE rounding boundary — lineNet = round_half_up(quantity x unitPrice, 4).
    // Rows 5-6 are verification, not computation: the kernel recomputes with
    // the same function and REJECTS a difference; it never substitutes.
    const expectedLineNet = Money.round(Money.multiply(quantity, unitPrice), 4, Rounding.HALF_UP)
    if (!Money.equals(submittedLineNet, expectedLineNet)) {
      throw new PostingError(
        'SALE_AMOUNT_MISMATCH',
        `Line ${index + 1}: lineNet ${Money.serialize(submittedLineNet, 4)} does not equal ` +
          `round_half_up(quantity x unitPrice, 4) = ${Money.serialize(expectedLineNet, 4)}.`,
        {
          line: String(index + 1),
          submitted: Money.serialize(submittedLineNet, 4),
          expected: Money.serialize(expectedLineNet, 4),
        },
      )
    }
    // Σ of already-rounded values: no second rounding, no residual (§6).
    runningTotal = Money.add(runningTotal, expectedLineNet)
  })

  const netAmount = parsePositiveMoney(record.netAmount, 'payload.netAmount')
  if (!Money.equals(netAmount, runningTotal)) {
    throw new PostingError(
      'SALE_AMOUNT_MISMATCH',
      `netAmount ${Money.serialize(netAmount, 4)} does not equal Σ lineNet ${Money.serialize(runningTotal, 4)}.`,
      { submitted: Money.serialize(netAmount, 4), expected: Money.serialize(runningTotal, 4) },
    )
  }

  return {
    customerId: record.customerId,
    lineCount: rawLines.length,
    netAmount: netAmount.toString(),
  }
}

/** §4 row 9, §5: role resolution, the party pre-check, and the two-line entry. */
export async function buildServiceSaleEntry(
  tx: TenantTx,
  tenantId: string,
  payload: ServiceSalePayload,
): Promise<{ lines: readonly NewJournalLine[]; narration: string; reference: string | null }> {
  const accounts = await resolveAccountsByRole(tx, tenantId, ['AR_CONTROL', 'SERVICE_REVENUE'])
  const arControl = requireResolvedRole(accounts, 'AR_CONTROL', {
    type: 'ASSET',
    controlKind: 'AR',
  })
  const revenue = requireResolvedRole(accounts, 'SERVICE_REVENUE', {
    type: 'INCOME',
    controlKind: 'NONE',
  })

  await assertPartiesRegistered(tx, tenantId, [
    { partyId: payload.customerId, partyType: 'CUSTOMER' },
  ])

  const lines: NewJournalLine[] = [
    {
      lineNumber: 1,
      accountId: arControl.id,
      accountControl: arControl.controlKind,
      debit: payload.netAmount,
      credit: '0.0000',
      partyType: 'CUSTOMER',
      partyId: payload.customerId,
      memo: null,
    },
    {
      lineNumber: 2,
      accountId: revenue.id,
      accountControl: revenue.controlKind,
      debit: '0.0000',
      credit: payload.netAmount,
      partyType: null,
      partyId: null,
      memo: null,
    },
  ]

  return {
    lines,
    narration: `Service invoice: ${payload.lineCount} line(s), ${payload.netAmount}`,
    reference: null,
  }
}
