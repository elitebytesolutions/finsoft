import { sql, type RawBuilder } from 'kysely'
import { BaseRepository, findTenantTimezone, type TenantTx } from '@finsoft/database'
import { Receipt, type ReceiptMethod, type ReceiptRow, type ReceiptStatus } from '../domain/receipt.ts'
import type {
  NewReceiptDraft,
  ReceiptAllocationRow,
  ReceiptDraftPatch,
  ReceiptListCursor,
  ReceiptListFilter,
  ReceiptListPage,
  ReceiptProposalRow,
  ReceiptsRepository as ReceiptsRepositoryPort,
} from '../application/ports.ts'
import type { AllocationInput } from '../domain/receipt.ts'

/*
 * `customer_receipts`, `customer_receipt_draft_allocations` and
 * `customer_receipt_allocations`. See invoices.repository.ts's header on
 * why this one module's infrastructure legitimately names all five tables.
 */

const LIST_PAGE_MAX = 200

interface ReceiptDbRow {
  id: string
  customer_id: string
  status: string
  number: string | null
  receipt_date: string | Date
  method: string | null
  amount: string | null
  reference: string | null
  narration: string | null
  proposals_revision: number
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
/** See invoices.repository.ts's identical helper for why this is duplicated. */
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
function sqlDate(iso: string): RawBuilder<Date> {
  return sql<Date>`${iso}::date`
}

function mapRow(row: ReceiptDbRow): Receipt {
  const receiptRow: ReceiptRow = {
    id: row.id,
    customerId: row.customer_id,
    status: row.status as ReceiptStatus,
    number: row.number,
    receiptDate: toDate(row.receipt_date),
    method: row.method as ReceiptMethod | null,
    amount: row.amount,
    reference: row.reference,
    narration: row.narration,
    proposalsRevision: row.proposals_revision,
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
  return Receipt.fromRow(receiptRow)
}

export class ReceiptsRepository
  extends BaseRepository<'customer_receipts'>
  implements ReceiptsRepositoryPort
{
  constructor() {
    super('customer_receipts')
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
  ): Promise<{ readonly receipt: Receipt; readonly fingerprint: string } | null> {
    const row = await this.scopedSelect(tx)
      .selectAll()
      .where('create_idempotency_key', '=', key)
      .executeTakeFirst()
    if (!row) return null
    return { receipt: mapRow(row as ReceiptDbRow), fingerprint: row.create_fingerprint }
  }

  private async insertProposals(
    tx: TenantTx,
    receiptId: string,
    revision: number,
    allocations: readonly AllocationInput[],
  ): Promise<void> {
    if (allocations.length === 0) return
    const actor = this.actingUserId as string
    await tx
      .insertInto('customer_receipt_draft_allocations')
      .values(
        allocations.map((a) => ({
          tenant_id: this.tenantId,
          receipt_id: receiptId,
          revision,
          invoice_id: a.invoiceId,
          amount: a.amount,
          created_by: actor,
          updated_by: actor,
        })),
      )
      .execute()
  }

  async createDraft(tx: TenantTx, draft: NewReceiptDraft): Promise<Receipt> {
    const header = await this.scopedInsert(tx, {
      customer_id: draft.customerId,
      status: 'DRAFT',
      receipt_date: draft.receiptDate,
      method: draft.method,
      amount: draft.amount,
      reference: draft.reference,
      narration: draft.narration,
      proposals_revision: 0,
      create_idempotency_key: draft.createIdempotencyKey,
      create_fingerprint: draft.createFingerprint,
    })
      .returningAll()
      .executeTakeFirstOrThrow()

    if (draft.allocations.length > 0) {
      await this.insertProposals(tx, header.id, 1, draft.allocations)
      const updated = await this.scopedUpdate(
        tx,
        { proposals_revision: 1 },
        { id: header.id, expectedVersion: header.version },
      )
        .returningAll()
        .executeTakeFirstOrThrow()
      return mapRow(updated as ReceiptDbRow)
    }
    return mapRow(header as ReceiptDbRow)
  }

  async findById(tx: TenantTx, id: string): Promise<Receipt | null> {
    const row = await this.scopedSelect(tx).selectAll().where('id', '=', id).executeTakeFirst()
    return row ? mapRow(row as ReceiptDbRow) : null
  }

  async customerIdOf(tx: TenantTx, id: string): Promise<string | null> {
    const row = await this.scopedSelect(tx)
      .select('customer_id')
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? row.customer_id : null
  }

  async lockForUpdate(tx: TenantTx, id: string): Promise<Receipt | null> {
    const row = await this.scopedSelect(tx)
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    return row ? mapRow(row as ReceiptDbRow) : null
  }

  async currentProposals(tx: TenantTx, id: string): Promise<readonly ReceiptProposalRow[]> {
    const receipt = await this.scopedSelect(tx)
      .select('proposals_revision')
      .where('id', '=', id)
      .executeTakeFirst()
    if (!receipt || receipt.proposals_revision === 0) return []
    const rows = await tx
      .selectFrom('customer_receipt_draft_allocations as cda')
      .innerJoin('sales_invoices as si', (join) =>
        join.onRef('si.id', '=', 'cda.invoice_id').on('si.tenant_id', '=', this.tenantId),
      )
      .select(['cda.invoice_id as invoice_id', 'si.number as invoice_number', 'cda.amount as amount'])
      .where('cda.tenant_id', '=', this.tenantId)
      .where('cda.receipt_id', '=', id)
      .where('cda.revision', '=', receipt.proposals_revision)
      .execute()
    return rows.map((r) => ({
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number ?? '',
      amount: r.amount,
    }))
  }

  async updateDraft(
    tx: TenantTx,
    id: string,
    patch: ReceiptDraftPatch,
    expectedVersion: number,
  ): Promise<Receipt> {
    const current = await this.scopedSelect(tx)
      .select('proposals_revision')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

    let nextRevision = current.proposals_revision
    if (patch.allocations !== null) {
      nextRevision = current.proposals_revision + 1
      await this.insertProposals(tx, id, nextRevision, patch.allocations)
    }

    const updated = await this.scopedUpdate(
      tx,
      {
        customer_id: patch.customerId,
        receipt_date: patch.receiptDate,
        method: patch.method,
        amount: patch.amount,
        reference: patch.reference,
        narration: patch.narration,
        proposals_revision: nextRevision,
      },
      { id, expectedVersion },
    )
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapRow(updated as ReceiptDbRow)
  }

  async markCancelled(
    tx: TenantTx,
    id: string,
    cancelledBy: string,
    expectedVersion: number,
  ): Promise<Receipt> {
    const updated = await this.scopedUpdate(
      tx,
      { status: 'CANCELLED', cancelled_at: sql`now()`, cancelled_by: cancelledBy },
      { id, expectedVersion },
    )
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapRow(updated as ReceiptDbRow)
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
  ): Promise<Receipt> {
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
    return mapRow(updated as ReceiptDbRow)
  }

  async insertAllocations(
    tx: TenantTx,
    receiptId: string,
    allocations: readonly AllocationInput[],
    createdBy: string,
  ): Promise<void> {
    if (allocations.length === 0) return
    await tx
      .insertInto('customer_receipt_allocations')
      .values(
        allocations.map((a) => ({
          tenant_id: this.tenantId,
          receipt_id: receiptId,
          invoice_id: a.invoiceId,
          amount: a.amount,
          status: 'LIVE' as const,
          created_by: createdBy,
          updated_by: createdBy,
        })),
      )
      .execute()
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
  ): Promise<Receipt> {
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
    return mapRow(updated as ReceiptDbRow)
  }

  async voidAllocations(tx: TenantTx, receiptId: string, voidedBy: string): Promise<void> {
    await tx
      .updateTable('customer_receipt_allocations')
      .set({
        status: 'VOIDED',
        voided_at: sql`now()`,
        voided_by: voidedBy,
        updated_by: voidedBy,
        version: sql`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('receipt_id', '=', receiptId)
      .where('status', '=', 'LIVE')
      .execute()
  }

  async allocationsOf(tx: TenantTx, receiptId: string): Promise<readonly ReceiptAllocationRow[]> {
    const rows = await tx
      .selectFrom('customer_receipt_allocations as cra')
      .innerJoin('sales_invoices as si', (join) =>
        join.onRef('si.id', '=', 'cra.invoice_id').on('si.tenant_id', '=', this.tenantId),
      )
      .select([
        'cra.invoice_id as invoice_id',
        'si.number as invoice_number',
        'si.invoice_date as invoice_date',
        'cra.amount as amount',
        'cra.status as status',
      ])
      .where('cra.tenant_id', '=', this.tenantId)
      .where('cra.receipt_id', '=', receiptId)
      .orderBy('si.invoice_date')
      .execute()
    return rows.map((r) => ({
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number ?? '',
      invoiceDate: toDate(r.invoice_date),
      amount: r.amount,
      status: r.status as 'LIVE' | 'VOIDED',
    }))
  }

  async allocatedInvoiceIds(tx: TenantTx, receiptId: string): Promise<readonly string[]> {
    const rows = await tx
      .selectFrom('customer_receipt_allocations')
      .select('invoice_id')
      .where('tenant_id', '=', this.tenantId)
      .where('receipt_id', '=', receiptId)
      .execute()
    return [...new Set(rows.map((r) => r.invoice_id))]
  }

  async list(
    tx: TenantTx,
    filter: ReceiptListFilter,
    page: { readonly limit: number; readonly after: ReceiptListCursor | null },
  ): Promise<ReceiptListPage> {
    let query = this.scopedSelect(tx).selectAll()

    if (filter.customerId) query = query.where('customer_id', '=', filter.customerId)
    if (filter.status && filter.status.length > 0) query = query.where('status', 'in', [...filter.status])
    if (filter.method) query = query.where('method', '=', filter.method)
    if (filter.from) query = query.where('receipt_date', '>=', sqlDate(filter.from))
    if (filter.to) query = query.where('receipt_date', '<=', sqlDate(filter.to))
    if (filter.q && filter.q.trim().length > 0) {
      query = query.where('number', 'ilike', `${filter.q.trim()}%`)
    }

    if (page.after) {
      const afterDate = sqlDate(page.after.receiptDate)
      const afterId = page.after.id
      query = query.where((eb) =>
        eb.or([
          eb('receipt_date', '<', afterDate),
          eb.and([eb('receipt_date', '=', afterDate), eb('id', '<', afterId)]),
        ]),
      )
    }
    const limit = Math.max(1, Math.min(Math.trunc(page.limit), LIST_PAGE_MAX))
    const rows = await query
      .orderBy('receipt_date', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute()

    const items = rows.slice(0, limit).map((r) => mapRow(r as ReceiptDbRow))
    const last = items.at(-1)
    const next = rows.length > limit && last ? { receiptDate: last.receiptDate, id: last.id } : null

    return { items, next }
  }
}
