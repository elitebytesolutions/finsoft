import { sql, type RawBuilder } from 'kysely'
import { BaseRepository, findTenantTimezone, type TenantTx } from '@finsoft/database'
import {
  Invoice,
  type ComputedInvoiceLine,
  type InvoiceRow,
  type InvoiceStatus,
} from '../domain/invoice.ts'
import type {
  InvoiceAllocationView,
  InvoiceDraftPatch,
  InvoiceListCursor,
  InvoiceListFilter,
  InvoiceListItemRow,
  InvoiceListPage,
  InvoicesRepository as InvoicesRepositoryPort,
  LiveAllocationRef,
  NewInvoiceDraft,
} from '../application/ports.ts'

/*
 * `sales_invoices` and `sales_invoice_lines`. Module tables are queried in
 * modules/<name>/infrastructure/, and nowhere else (modules.md §11). This
 * class names only these two tables plus, for the allocation/outstanding
 * reads, `customer_receipt_allocations` and `customer_receipts` — all FIVE
 * are owned by this ONE module (modules.md §2), so this is not a
 * cross-module table access.
 */

const LIST_PAGE_MAX = 200

interface InvoiceDbRow {
  id: string
  customer_id: string
  status: string
  number: string | null
  invoice_date: string | Date
  due_date: string | Date | null
  narration: string | null
  net_amount: string
  lines_revision: number
  version: number
  posted_at: string | Date | null
  posted_by: string | null
  post_idempotency_key: string | null
  post_fingerprint: string | null
  reversed_at: string | Date | null
  reversed_by: string | null
  reversal_reason: string | null
  reverse_idempotency_key: string | null
  reverse_fingerprint: string | null
  cancelled_at: string | Date | null
  cancelled_by: string | null
  created_at: string | Date
  created_by: string
  updated_at: string | Date
  updated_by: string
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}
function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value)
}

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/
/**
 * `date` columns come back as a `Date` built at LOCAL midnight (node-postgres's
 * default parser, per ADR-0013: no `setTypeParser` override). Reading it back
 * with the LOCAL getters — never `toISOString()`, which is a day early east
 * of UTC — returns exactly the calendar date PostgreSQL stored. Mirrors
 * packages/database/src/accounting/calendar-date.ts's `calendarDate`,
 * duplicated because that file is not part of `@finsoft/database`'s public
 * index (modules import the root export only, ADR-0028 statement 5).
 */
function toDate(value: string | Date): string {
  if (value instanceof Date) {
    const y = String(value.getFullYear()).padStart(4, '0')
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const match = ISO_DATE_PREFIX.exec(value)
  if (match?.[1] !== undefined) return match[1]
  throw new Error(`toDate: not a date value: ${String(value)}`)
}
function toDateOrNull(value: string | Date | null): string | null {
  return value === null ? null : toDate(value)
}
/** An ISO date bound as text and cast in SQL — mirrors calendar-date.ts's `sqlDate`. */
function sqlDate(iso: string): RawBuilder<Date> {
  return sql<Date>`${iso}::date`
}

function mapRow(row: InvoiceDbRow): Invoice {
  const invoiceRow: InvoiceRow = {
    id: row.id,
    customerId: row.customer_id,
    status: row.status as InvoiceStatus,
    number: row.number,
    invoiceDate: toDate(row.invoice_date),
    dueDate: toDateOrNull(row.due_date),
    narration: row.narration,
    netAmount: row.net_amount,
    linesRevision: row.lines_revision,
    version: row.version,
    postedAt: toIsoOrNull(row.posted_at),
    postedBy: row.posted_by,
    postIdempotencyKey: row.post_idempotency_key,
    postFingerprint: row.post_fingerprint,
    reversedAt: toIsoOrNull(row.reversed_at),
    reversedBy: row.reversed_by,
    reversalReason: row.reversal_reason,
    reverseIdempotencyKey: row.reverse_idempotency_key,
    reverseFingerprint: row.reverse_fingerprint,
    cancelledAt: toIsoOrNull(row.cancelled_at),
    cancelledBy: row.cancelled_by,
    createdAt: toIso(row.created_at),
    createdBy: row.created_by,
    updatedAt: toIso(row.updated_at),
    updatedBy: row.updated_by,
  }
  return Invoice.fromRow(invoiceRow)
}

export class InvoicesRepository
  extends BaseRepository<'sales_invoices'>
  implements InvoicesRepositoryPort
{
  constructor() {
    super('sales_invoices')
  }

  async today(tx: TenantTx): Promise<string> {
    const timezone = await findTenantTimezone(tx, this.tenantId)
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  }

  async findByCreateIdempotencyKey(
    tx: TenantTx,
    key: string,
  ): Promise<{ readonly invoice: Invoice; readonly fingerprint: string } | null> {
    const row = await this.scopedSelect(tx)
      .selectAll()
      .where('create_idempotency_key', '=', key)
      .executeTakeFirst()
    if (!row) return null
    return { invoice: mapRow(row as InvoiceDbRow), fingerprint: row.create_fingerprint }
  }

  private async insertLines(
    tx: TenantTx,
    invoiceId: string,
    revision: number,
    lines: readonly ComputedInvoiceLine[],
  ): Promise<void> {
    if (lines.length === 0) return
    // Never null on this authenticated path (rule 9: every mutation has an
    // author); BaseRepository's own scopedInsert makes the same assumption
    // for every other table (repository.ts's own comment on the point).
    const actor = this.actingUserId as string
    await tx
      .insertInto('sales_invoice_lines')
      .values(
        lines.map((line) => ({
          tenant_id: this.tenantId,
          invoice_id: invoiceId,
          revision,
          line_no: line.lineNo,
          kind: 'SERVICE' as const,
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unitPrice,
          line_net: line.lineNet,
          created_by: actor,
          updated_by: actor,
        })),
      )
      .execute()
  }

  async createDraft(tx: TenantTx, draft: NewInvoiceDraft): Promise<Invoice> {
    const header = await this.scopedInsert(tx, {
      customer_id: draft.customerId,
      status: 'DRAFT',
      invoice_date: draft.invoiceDate,
      due_date: draft.dueDate,
      narration: draft.narration,
      net_amount: '0.0000',
      lines_revision: 0,
      create_idempotency_key: draft.createIdempotencyKey,
      create_fingerprint: draft.createFingerprint,
    })
      .returningAll()
      .executeTakeFirstOrThrow()

    await this.insertLines(tx, header.id, 1, draft.lines)

    const updated = await this.scopedUpdate(
      tx,
      { lines_revision: 1, net_amount: draft.netAmount },
      { id: header.id, expectedVersion: header.version },
    )
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapRow(updated as InvoiceDbRow)
  }

  async findById(tx: TenantTx, id: string): Promise<Invoice | null> {
    const row = await this.scopedSelect(tx).selectAll().where('id', '=', id).executeTakeFirst()
    return row ? mapRow(row as InvoiceDbRow) : null
  }

  async customerIdOf(tx: TenantTx, id: string): Promise<string | null> {
    const row = await this.scopedSelect(tx)
      .select('customer_id')
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? row.customer_id : null
  }

  async lockForUpdate(tx: TenantTx, id: string): Promise<Invoice | null> {
    const row = await this.scopedSelect(tx)
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    return row ? mapRow(row as InvoiceDbRow) : null
  }

  async lockManyForAllocation(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, Invoice>> {
    const ordered = [...new Set(ids)].sort()
    const result = new Map<string, Invoice>()
    // LOCK_REGISTRY 1c: ascending id, ONE STATEMENT PER ROW — "ORDER BY …
    // FOR UPDATE does not fix acquisition order" (the migration-008 lesson).
    for (const id of ordered) {
      const row = await this.scopedSelect(tx)
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (row) result.set(id, mapRow(row as InvoiceDbRow))
    }
    return result
  }

  async currentLines(tx: TenantTx, id: string): Promise<readonly ComputedInvoiceLine[]> {
    const invoice = await this.scopedSelect(tx)
      .select('lines_revision')
      .where('id', '=', id)
      .executeTakeFirst()
    if (!invoice) return []
    const rows = await tx
      .selectFrom('sales_invoice_lines')
      .select(['line_no', 'description', 'quantity', 'unit_price', 'line_net'])
      .where('tenant_id', '=', this.tenantId)
      .where('invoice_id', '=', id)
      .where('revision', '=', invoice.lines_revision)
      .orderBy('line_no')
      .execute()
    return rows.map((r) => ({
      lineNo: r.line_no,
      description: r.description,
      quantity: r.quantity,
      unitPrice: r.unit_price,
      lineNet: r.line_net,
    }))
  }

  async updateDraft(
    tx: TenantTx,
    id: string,
    patch: InvoiceDraftPatch,
    expectedVersion: number,
  ): Promise<Invoice> {
    const current = await this.scopedSelect(tx)
      .select('lines_revision')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    const nextRevision = current.lines_revision + 1
    await this.insertLines(tx, id, nextRevision, patch.lines)

    const updated = await this.scopedUpdate(
      tx,
      {
        customer_id: patch.customerId,
        invoice_date: patch.invoiceDate,
        due_date: patch.dueDate,
        narration: patch.narration,
        net_amount: patch.netAmount,
        lines_revision: nextRevision,
      },
      { id, expectedVersion },
    )
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapRow(updated as InvoiceDbRow)
  }

  async markCancelled(
    tx: TenantTx,
    id: string,
    cancelledBy: string,
    expectedVersion: number,
  ): Promise<Invoice> {
    const updated = await this.scopedUpdate(
      tx,
      { status: 'CANCELLED', cancelled_at: sql`now()`, cancelled_by: cancelledBy },
      { id, expectedVersion },
    )
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapRow(updated as InvoiceDbRow)
  }

  async markPosted(
    tx: TenantTx,
    id: string,
    fields: {
      readonly number: string
      readonly postedBy: string
      readonly postIdempotencyKey: string
      readonly postFingerprint: string
    },
    expectedVersion: number,
  ): Promise<Invoice> {
    const updated = await this.scopedUpdate(
      tx,
      {
        status: 'POSTED',
        number: fields.number,
        posted_at: sql`now()`,
        posted_by: fields.postedBy,
        post_idempotency_key: fields.postIdempotencyKey,
        post_fingerprint: fields.postFingerprint,
      },
      { id, expectedVersion },
    )
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapRow(updated as InvoiceDbRow)
  }

  async markReversed(
    tx: TenantTx,
    id: string,
    fields: {
      readonly reversedBy: string
      readonly reason: string
      readonly reverseIdempotencyKey: string
      readonly reverseFingerprint: string
    },
    expectedVersion: number,
  ): Promise<Invoice> {
    const updated = await this.scopedUpdate(
      tx,
      {
        status: 'REVERSED',
        reversed_at: sql`now()`,
        reversed_by: fields.reversedBy,
        reversal_reason: fields.reason,
        reverse_idempotency_key: fields.reverseIdempotencyKey,
        reverse_fingerprint: fields.reverseFingerprint,
      },
      { id, expectedVersion },
    )
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapRow(updated as InvoiceDbRow)
  }

  async liveAllocationsTo(tx: TenantTx, id: string): Promise<readonly LiveAllocationRef[]> {
    const rows = await tx
      .selectFrom('customer_receipt_allocations as cra')
      .innerJoin('customer_receipts as cr', (join) =>
        join.onRef('cr.id', '=', 'cra.receipt_id').on('cr.tenant_id', '=', this.tenantId),
      )
      .select(['cra.receipt_id as receipt_id', 'cr.number as receipt_number'])
      .where('cra.tenant_id', '=', this.tenantId)
      .where('cra.invoice_id', '=', id)
      .where('cra.status', '=', 'LIVE')
      .execute()
    return rows.map((r) => ({ receiptId: r.receipt_id, receiptNumber: r.receipt_number as string }))
  }

  async outstandingOf(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) return new Map()
    const rows = await tx
      .selectFrom('sales_invoices as si')
      .leftJoin('customer_receipt_allocations as cra', (join) =>
        join
          .onRef('cra.invoice_id', '=', 'si.id')
          .on('cra.tenant_id', '=', this.tenantId)
          .on('cra.status', '=', 'LIVE'),
      )
      .select(({ ref }) => [
        'si.id as invoice_id',
        sql<string>`(${ref('si.net_amount')} - COALESCE(SUM(${ref('cra.amount')}), 0))::text`.as(
          'outstanding',
        ),
      ])
      .where('si.tenant_id', '=', this.tenantId)
      .where('si.id', 'in', [...ids])
      .groupBy(['si.id', 'si.net_amount'])
      .execute()
    return new Map(rows.map((r) => [r.invoice_id, r.outstanding]))
  }

  async allocationsOf(tx: TenantTx, id: string): Promise<readonly InvoiceAllocationView[]> {
    const rows = await tx
      .selectFrom('customer_receipt_allocations as cra')
      .innerJoin('customer_receipts as cr', (join) =>
        join.onRef('cr.id', '=', 'cra.receipt_id').on('cr.tenant_id', '=', this.tenantId),
      )
      .select([
        'cra.receipt_id as receipt_id',
        'cr.number as receipt_number',
        'cr.receipt_date as receipt_date',
        'cra.amount as amount',
        'cra.status as status',
      ])
      .where('cra.tenant_id', '=', this.tenantId)
      .where('cra.invoice_id', '=', id)
      .orderBy('cr.receipt_date')
      .execute()
    return rows.map((r) => ({
      receiptId: r.receipt_id,
      receiptNumber: r.receipt_number as string,
      receiptDate: toDate(r.receipt_date),
      amount: r.amount,
      status: r.status as 'LIVE' | 'VOIDED',
    }))
  }

  async list(
    tx: TenantTx,
    filter: InvoiceListFilter,
    page: { readonly limit: number; readonly after: InvoiceListCursor | null },
  ): Promise<InvoiceListPage> {
    let query = this.scopedSelect(tx).selectAll()

    if (filter.customerId) query = query.where('customer_id', '=', filter.customerId)
    if (filter.status && filter.status.length > 0) query = query.where('status', 'in', [...filter.status])
    if (filter.from) query = query.where('invoice_date', '>=', sqlDate(filter.from))
    if (filter.to) query = query.where('invoice_date', '<=', sqlDate(filter.to))
    if (filter.q && filter.q.trim().length > 0) {
      query = query.where('number', 'ilike', `${filter.q.trim()}%`)
    }
    if (filter.openOnly) {
      query = query.where('status', '=', 'POSTED')
    }

    const limit = Math.max(1, Math.min(Math.trunc(page.limit), LIST_PAGE_MAX))

    if (filter.openOnly) {
      // Oldest first (invoiceDate, then id) — the allocation picker's order,
      // same as the preview's suggestion (api-contract.md §4.2).
      if (page.after) {
        const afterDate = sqlDate(page.after.invoiceDate)
        const afterId = page.after.id
        query = query.where((eb) =>
          eb.or([
            eb('invoice_date', '>', afterDate),
            eb.and([eb('invoice_date', '=', afterDate), eb('id', '>', afterId)]),
          ]),
        )
      }
      query = query.orderBy('invoice_date', 'asc').orderBy('id', 'asc')
    } else {
      if (page.after) {
        const afterDate = sqlDate(page.after.invoiceDate)
        const afterId = page.after.id
        query = query.where((eb) =>
          eb.or([
            eb('invoice_date', '<', afterDate),
            eb.and([eb('invoice_date', '=', afterDate), eb('id', '<', afterId)]),
          ]),
        )
      }
      query = query.orderBy('invoice_date', 'desc').orderBy('id', 'desc')
    }

    const rows = await query.limit(limit + 1).execute()
    const pageRows = rows.slice(0, limit).map((r) => mapRow(r as InvoiceDbRow))

    const ids = pageRows.filter((i) => i.status === 'POSTED').map((i) => i.id)
    const outstandingMap = await this.outstandingOf(tx, ids)

    const items: InvoiceListItemRow[] = pageRows.map((invoice) => ({
      invoice,
      outstanding:
        invoice.status === 'POSTED'
          ? (outstandingMap.get(invoice.id) ?? invoice.netAmount)
          : invoice.status === 'REVERSED'
            ? '0.0000'
            : null,
    }))

    const last = pageRows.at(-1)
    const next = rows.length > limit && last ? { invoiceDate: last.invoiceDate, id: last.id } : null

    return { items, next }
  }
}
