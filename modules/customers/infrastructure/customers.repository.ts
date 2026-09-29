import { BaseRepository, findTenantTimezone, type TenantTx } from '@finsoft/database'
import { controlAccountLedger, customerSubledgerBalance } from '@finsoft/reporting'
import { Money } from '@finsoft/validation'
import {
  Customer,
  LEDGER_MAX_DAYS,
  type CustomerRow,
  type CustomerStatus,
} from '../domain/customer.ts'
import { CustomerError } from '../domain/errors.ts'
// Type-only import of the application port this class implements — the one
// sanctioned infrastructure -> application edge (ADR-0028 statement 5).
import type {
  CustomerLedgerResult,
  CustomerListCursor,
  CustomerListFilter,
  CustomerListPage,
  CustomerPatch,
  CustomersRepository as CustomersRepositoryPort,
  NewCustomerRow,
} from '../application/ports.ts'

/*
 * The customers table's Kysely repository. Module tables are queried in
 * modules/<name>/infrastructure/, and nowhere else (modules.md §11,
 * ADR-0013 kysely-is-allowlisted). This class names ONLY `customers` — C8/S2.
 */

const LIST_PAGE_MAX = 200
const LEDGER_PAGE_LIMIT = 500
/** ~2,000 lines, matching the MVP ceiling docs/design/M3/README.md §10 names as this debt's forcing condition. */
const LEDGER_MAX_PAGES = 4
/** Accounting seat C4: an "as of" date no real posting can ever be dated past — see hasAnyBalance(). */
const FAR_FUTURE_DATE = '9999-12-31'

interface CustomerDbRow {
  id: string
  code: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  city: string | null
  ntn: string | null
  credit_days: number
  status: string
  version: number
  created_at: string | Date
  created_by: string
  updated_at: string | Date
  updated_by: string
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

function mapRow(row: CustomerDbRow): Customer {
  const customerRow: CustomerRow = {
    id: row.id,
    code: row.code,
    fields: {
      name: row.name,
      phone: row.phone,
      email: row.email,
      address: row.address,
      city: row.city,
      ntn: row.ntn,
      creditDays: row.credit_days,
    },
    status: row.status as CustomerStatus,
    version: row.version,
    createdAt: toIso(row.created_at),
    createdBy: row.created_by,
    updatedAt: toIso(row.updated_at),
    updatedBy: row.updated_by,
  }
  return Customer.fromRow(customerRow)
}

/** en-CA formats as YYYY-MM-DD — this table's `date` and this API's LocalDate shape. */
function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export class CustomersRepository
  extends BaseRepository<'customers'>
  implements CustomersRepositoryPort
{
  constructor() {
    super('customers')
  }

  async findByCreateIdempotencyKey(
    tx: TenantTx,
    key: string,
  ): Promise<{ readonly customer: Customer; readonly fingerprint: string } | null> {
    const row = await this.scopedSelect(tx)
      .selectAll()
      .where('create_idempotency_key', '=', key)
      .executeTakeFirst()
    if (!row) return null
    return { customer: mapRow(row as CustomerDbRow), fingerprint: row.create_fingerprint }
  }

  async insert(tx: TenantTx, row: NewCustomerRow): Promise<Customer> {
    const inserted = await this.scopedInsert(tx, {
      id: row.id,
      party_type: 'CUSTOMER',
      code: row.code,
      name: row.fields.name,
      phone: row.fields.phone,
      email: row.fields.email,
      address: row.fields.address,
      city: row.fields.city,
      ntn: row.fields.ntn,
      credit_days: row.fields.creditDays,
      create_idempotency_key: row.createIdempotencyKey,
      create_fingerprint: row.createFingerprint,
    })
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapRow(inserted as CustomerDbRow)
  }

  async findById(tx: TenantTx, id: string): Promise<Customer | null> {
    const row = await this.scopedSelect(tx).selectAll().where('id', '=', id).executeTakeFirst()
    return row ? mapRow(row as CustomerDbRow) : null
  }

  async lockForUpdate(tx: TenantTx, id: string): Promise<Customer | null> {
    const row = await this.scopedSelect(tx)
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    return row ? mapRow(row as CustomerDbRow) : null
  }

  async lockForShare(tx: TenantTx, id: string): Promise<Customer | null> {
    const row = await this.scopedSelect(tx)
      .selectAll()
      .where('id', '=', id)
      .forShare()
      .executeTakeFirst()
    return row ? mapRow(row as CustomerDbRow) : null
  }

  async update(
    tx: TenantTx,
    id: string,
    patch: CustomerPatch,
    expectedVersion: number,
  ): Promise<Customer> {
    const values: Record<string, unknown> = {}
    if (patch.name !== undefined) values.name = patch.name
    if (patch.phone !== undefined) values.phone = patch.phone
    if (patch.email !== undefined) values.email = patch.email
    if (patch.address !== undefined) values.address = patch.address
    if (patch.city !== undefined) values.city = patch.city
    if (patch.ntn !== undefined) values.ntn = patch.ntn
    if (patch.creditDays !== undefined) values.credit_days = patch.creditDays
    if (patch.status !== undefined) values.status = patch.status

    // Safe: the caller already holds this row's FOR UPDATE lock and checked
    // expectedVersion against it in the SAME transaction (Customer.assertVersion),
    // so no concurrent writer can have moved the version in between.
    const updated = await this.scopedUpdate(tx, values, { id, expectedVersion })
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapRow(updated as CustomerDbRow)
  }

  async list(
    tx: TenantTx,
    filter: CustomerListFilter,
    page: { readonly limit: number; readonly after: CustomerListCursor | null },
  ): Promise<CustomerListPage> {
    let query = this.scopedSelect(tx).selectAll()

    if (filter.status && filter.status.length > 0) {
      query = query.where('status', 'in', [...filter.status])
    }
    if (filter.q && filter.q.trim().length > 0) {
      const q = filter.q.trim()
      query = query.where((eb) =>
        eb.or([
          eb('code', 'ilike', `${q}%`),
          eb('name', 'ilike', `%${q}%`),
          eb('phone', 'ilike', `%${q}%`),
        ]),
      )
    }
    if (page.after) {
      query = query.where('code', '>', page.after.code)
    }

    const limit = Math.max(1, Math.min(Math.trunc(page.limit), LIST_PAGE_MAX))
    const rows = await query
      .orderBy('code', 'asc')
      .limit(limit + 1)
      .execute()

    const items = rows.slice(0, limit).map((row) => mapRow(row as CustomerDbRow))
    const last = items.at(-1)
    const next = rows.length > limit && last ? { code: last.code } : null

    return { items, next }
  }

  async findByIds(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, Customer>> {
    if (ids.length === 0) return new Map()
    const rows = await this.scopedSelect(tx)
      .selectAll()
      .where('id', 'in', [...ids])
      .execute()
    return new Map(rows.map((row) => [row.id, mapRow(row as CustomerDbRow)]))
  }

  async currentBalance(
    tx: TenantTx,
    id: string,
  ): Promise<{ readonly balance: string; readonly asOf: string }> {
    const timezone = await findTenantTimezone(tx, this.tenantId)
    const asOf = todayInTimezone(timezone)
    const result = await customerSubledgerBalance(tx, this.tenantId, id, asOf)
    return { balance: result.balance, asOf }
  }

  async hasAnyBalance(tx: TenantTx, id: string): Promise<boolean> {
    // Accounting seat C4: unbounded by date, deliberately — see this
    // method's port-level doc comment. `customerSubledgerBalance`'s one
    // signature takes a mandatory `asOf`, so "no bound" is expressed as a
    // date far enough in the future that no real posting can be dated past
    // it (fiscal periods do not exist that far out either) — not a change
    // to the kernel-adjacent query itself, which stays a single, simple
    // `<=` comparison used identically by every other caller.
    const result = await customerSubledgerBalance(tx, this.tenantId, id, FAR_FUTURE_DATE)
    return !Money.isZero(Money.from(result.balance))
  }

  async ledger(
    tx: TenantTx,
    id: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<CustomerLedgerResult> {
    const lines: CustomerLedgerResult['lines'][number][] = []
    let opening = '0.0000'
    let closing = '0.0000'
    let after: {
      occurredAt: string
      createdAt: string
      entryNumber: string
      lineNumber: number
    } | null = null
    let carryForwardBalance: string | undefined

    for (let pageIndex = 0; pageIndex < LEDGER_MAX_PAGES; pageIndex++) {
      const result = await controlAccountLedger(tx, this.tenantId, 'AR', id, {
        from: range.from,
        to: range.to,
        limit: LEDGER_PAGE_LIMIT,
        after,
        ...(carryForwardBalance !== undefined ? { carryForwardBalance } : {}),
      })
      if (pageIndex === 0) opening = result.openingBalance
      closing = result.closingBalance
      for (const line of result.lines) {
        lines.push({
          occurredAt: line.occurredAt,
          entryId: line.entryId,
          entryNumber: line.entryNumber,
          entryStatus: line.entryStatus,
          sourceType: line.sourceType,
          sourceId: line.sourceId,
          narration: line.narration,
          debit: line.debit,
          credit: line.credit,
          runningBalance: line.runningBalance,
          reversalOf: line.reversalOf,
          reversedBy: line.reversedBy,
        })
      }
      if (!result.next) break
      after = result.next
      carryForwardBalance = result.closingBalance

      // Accounting seat C1 (Council review, 2026-09-29): a page still
      // remaining after the LAST allowed page means this ledger has more
      // lines than LEDGER_MAX_PAGES * LEDGER_PAGE_LIMIT can show — and a
      // `closing` computed from only the lines fetched SO FAR is not the
      // customer's true closing balance for the range; every line beyond
      // the cut-off still moves it. Returning that number unlabelled would
      // be a financial UI showing a wrong figure with no indication it is
      // wrong. Refused outright, same code and shape as the date-range cap
      // (api-contract.md §3 LEDGER_RANGE_TOO_LARGE, 422) — the fix on both
      // is the same instruction to the user: narrow the range.
      if (pageIndex === LEDGER_MAX_PAGES - 1) {
        throw new CustomerError(
          'LEDGER_RANGE_TOO_LARGE',
          `customer ${id}'s ledger for ${range.from}..${range.to} has more than ` +
            `${LEDGER_MAX_PAGES * LEDGER_PAGE_LIMIT} lines; the closing balance cannot be shown ` +
            'reliably without fetching all of them. Narrow the date range.',
          { maxDays: LEDGER_MAX_DAYS },
        )
      }
    }

    return { openingBalance: opening, closingBalance: closing, lines }
  }
}
