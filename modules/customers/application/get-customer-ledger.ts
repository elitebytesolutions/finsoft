import {
  DEFAULT_FISCAL_YEAR_START_MONTH,
  findTenantTimezone,
  postingPrincipalOf,
  withTenant,
} from '@finsoft/database'
import type { Customer } from '../domain/customer.ts'
import { assertLedgerRange } from '../domain/customer.ts'
import { CustomerError } from '../domain/errors.ts'
import type { CustomerLedgerResult, CustomersRepository } from './ports.ts'

/*
 * GetCustomerLedger. C7, api-contract.md §4.1: the AR_CONTROL account
 * ledger (K5) filtered to one customer, capped at 366 days
 * (LEDGER_RANGE_TOO_LARGE). Read-only — no lock, no audit record.
 *
 * `from`/`to` are nullable at this boundary: the contract's default is
 * "from = first day of the current fiscal year, to = today (tenant
 * timezone)" — both server-resolved facts (rule 13), never a controller
 * default computed from the wrong clock. Resolved here, inside withTenant,
 * using the same DEFAULT_FISCAL_YEAR_START_MONTH constant every M2 call site
 * uses (packages/database/src/accounting/tenant-settings.ts's own header:
 * the MVP has exactly one fiscal year, so this is not a query, just a
 * constant plus the tenant's timezone).
 */

export interface GetCustomerLedgerQuery {
  readonly id: string
  readonly from: string | null
  readonly to: string | null
}

export interface GetCustomerLedgerResult {
  readonly customer: Customer
  readonly from: string
  readonly to: string
  readonly ledger: CustomerLedgerResult
}

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** The first day of the fiscal year that contains `today` (YYYY-MM-DD in). */
function fiscalYearStart(today: string): string {
  const [yearRaw, monthRaw] = today.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const startYear = month >= DEFAULT_FISCAL_YEAR_START_MONTH ? year : year - 1
  return `${startYear}-${String(DEFAULT_FISCAL_YEAR_START_MONTH).padStart(2, '0')}-01`
}

export function createGetCustomerLedger(repo: CustomersRepository) {
  return async function getCustomerLedger(
    query: GetCustomerLedgerQuery,
  ): Promise<GetCustomerLedgerResult> {
    return withTenant(async (tx) => {
      const customer = await repo.findById(tx, query.id)
      if (!customer) {
        throw new CustomerError('CUSTOMER_NOT_FOUND', `customer ${query.id} was not found.`, {
          customerId: query.id,
        })
      }

      const { tenantId } = postingPrincipalOf(tx)
      const timezone = await findTenantTimezone(tx, tenantId)
      const today = todayInTimezone(timezone)
      const from = query.from ?? fiscalYearStart(today)
      const to = query.to ?? today
      assertLedgerRange(from, to)

      const ledger = await repo.ledger(tx, query.id, { from, to })
      return { customer, from, to, ledger }
    })
  }
}
