import { Money } from '@finsoft/validation'
import type {
  Customer as CustomerDto,
  CustomerLedger,
  CustomerLedgerLine,
  CustomerListItem,
  CustomerListPage,
} from '@finsoft/shared-types'
import type { Customer } from '../domain/customer.ts'
import type { GetCustomerLedgerResult } from '../application/get-customer-ledger.ts'
import type { CustomerListItemResult } from '../application/list-customers.ts'
import { encodeCustomerCursor } from './cursor.ts'
import type { CustomerListCursor } from '../application/ports.ts'

/*
 * Response mappers: domain -> packages/shared-types. This is the ONE place
 * a `Customer` (domain) becomes a `Customer` (wire shape) — apps/web (M4)
 * never sees the domain type, only the shared-types one (ADR-0028 statement 2).
 */

export function toCustomerDto(
  customer: Customer,
  balance: string,
  balanceAsOf: string,
): CustomerDto {
  return {
    id: customer.id,
    code: customer.code,
    name: customer.fields.name,
    phone: customer.fields.phone,
    email: customer.fields.email,
    address: customer.fields.address,
    city: customer.fields.city,
    ntn: customer.fields.ntn,
    creditDays: customer.fields.creditDays,
    status: customer.status,
    balance,
    balanceAsOf,
    version: customer.version,
    createdAt: customer.createdAt,
    createdBy: customer.createdBy,
    updatedAt: customer.updatedAt,
    updatedBy: customer.updatedBy,
  }
}

export function toCustomerListItemDto(result: CustomerListItemResult): CustomerListItem {
  return {
    id: result.customer.id,
    code: result.customer.code,
    name: result.customer.fields.name,
    phone: result.customer.fields.phone,
    city: result.customer.fields.city,
    status: result.customer.status,
    balance: result.balance,
    balanceAsOf: result.balanceAsOf,
  }
}

export function toCustomerListPageDto(
  items: readonly CustomerListItemResult[],
  nextCursor: CustomerListCursor | null,
): CustomerListPage {
  return {
    items: items.map(toCustomerListItemDto),
    nextCursor: encodeCustomerCursor(nextCursor),
  }
}

/**
 * `reversedBy`/`reverses` need the PAIRED entry's number, and
 * packages/reporting's ledger read only carries the paired entry's id
 * (`AccountLedgerLine.reversalOf`/`reversedBy`) — resolving the number
 * needs the pair to be in view. Since a reversal is dated on or after its
 * original (reversal.md), the pair is usually within the SAME requested
 * range and this in-memory lookup resolves it without a second query. When
 * the pair falls outside `[from, to]` the field is `null` rather than
 * guessed — a known, documented gap (OBSERVED: K4/K5 do not yet expose the
 * kernel's own entry-number-by-id lookup for this to close generally).
 */
function toLedgerLineDto(
  line: GetCustomerLedgerResult['ledger']['lines'][number],
  numberById: ReadonlyMap<string, string>,
): CustomerLedgerLine {
  const reversedByNumber = line.reversedBy ? numberById.get(line.reversedBy) : undefined
  const reversalOfNumber = line.reversalOf ? numberById.get(line.reversalOf) : undefined
  return {
    occurredAt: line.occurredAt,
    entryId: line.entryId,
    entryNumber: line.entryNumber,
    sourceType: line.sourceType as CustomerLedgerLine['sourceType'],
    sourceId: line.sourceId,
    // K4 (referenceNumber on the entry) is an M3-P kernel addition; until
    // that lands the entry number is the closest available "source
    // document number" — this field is null rather than guessed.
    sourceNumber: null,
    narration: line.narration,
    debit: line.debit,
    credit: line.credit,
    runningBalance: line.runningBalance,
    reversedBy:
      line.reversedBy && reversedByNumber
        ? { entryId: line.reversedBy, entryNumber: reversedByNumber }
        : null,
    reverses:
      line.reversalOf && reversalOfNumber
        ? { entryId: line.reversalOf, entryNumber: reversalOfNumber, reason: null }
        : null,
  }
}

export function toCustomerLedgerDto(result: GetCustomerLedgerResult): CustomerLedger {
  const numberById = new Map(result.ledger.lines.map((l) => [l.entryId, l.entryNumber]))
  return {
    customer: {
      id: result.customer.id,
      code: result.customer.code,
      name: result.customer.fields.name,
    },
    from: result.from,
    to: result.to,
    openingBalance: result.ledger.openingBalance,
    lines: result.ledger.lines.map((line) => toLedgerLineDto(line, numberById)),
    totals: computeTotals(result.ledger.lines),
    closingBalance: result.ledger.closingBalance,
  }
}

function computeTotals(lines: readonly GetCustomerLedgerResult['ledger']['lines'][number][]): {
  readonly debit: string
  readonly credit: string
} {
  // Presentation summation, matching packages/reporting/src/trial-balance.ts's
  // own totals loop: @finsoft/validation.Money, never native number
  // arithmetic on a monetary value (rule: "money crosses every boundary as
  // a decimal string / decimal library, never a float").
  const debit = Money.sum(lines.map((l) => Money.from(l.debit)))
  const credit = Money.sum(lines.map((l) => Money.from(l.credit)))
  return { debit: Money.serialize(debit, 4), credit: Money.serialize(credit, 4) }
}
