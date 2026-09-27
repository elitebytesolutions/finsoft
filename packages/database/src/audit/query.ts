import type { TenantTx } from '../transaction.ts'

/*
 * The read side for GET /api/audit. ADR-0023 A1: all query construction
 * lives in packages/database, never in apps/api. The Kysely fluent builder
 * is used here rather than raw sql — `audit_log` is in the generated schema
 * (npm run db:codegen), and the builder's `.orderBy('seq', ...)` binds to
 * the actual column unambiguously, sidestepping the exact ORDER BY /
 * aliased-cast pitfall that broke the writer and the verifier (see their own
 * comments) by construction rather than by convention.
 *
 * This is a read surface, not a reporting one: it returns the row shape as
 * stored, and it is tenant-scoped by `tx` alone (RLS plus the caller having
 * already gone through withTenant) — no tenant_id filter is added here,
 * matching outbox.ts's own convention of trusting RLS rather than
 * duplicating it in every WHERE clause.
 */

export interface AuditEventFilter {
  readonly from?: Date | undefined
  readonly to?: Date | undefined
  readonly action?: string | undefined
  readonly entityType?: string | undefined
  readonly entityId?: string | undefined
  readonly actorUserId?: string | undefined
  /** Exclusive: rows with seq strictly less than this. Opaque to the caller. */
  readonly cursor?: string | undefined
  readonly limit: number
}

export interface AuditEventRow {
  readonly id: string
  readonly seq: string
  readonly occurredAt: Date
  readonly actorUserId: string | null
  readonly action: string
  readonly entityType: string
  readonly entityId: string | null
  readonly beforeJson: unknown
  readonly afterJson: unknown
  readonly ip: string | null
  readonly requestId: string | null
  readonly hash: string
  readonly previousHash: string | null
}

export interface AuditEventPage {
  readonly items: readonly AuditEventRow[]
  /** Pass as `cursor` to fetch the next page; null when this is the last one. */
  readonly nextCursor: string | null
}

export async function listAuditEvents(
  tx: TenantTx,
  filter: AuditEventFilter,
): Promise<AuditEventPage> {
  let query = tx
    .selectFrom('audit_log')
    .select([
      'id',
      'seq',
      'occurred_at',
      'actor_user_id',
      'action',
      'entity_type',
      'entity_id',
      'before_json',
      'after_json',
      'ip',
      'request_id',
      'hash',
      'previous_hash',
    ])
    // The seq=0 anchor is not a hashed record and carries no business
    // meaning for a viewer — ADR-0020 §5 calls it "not a hashed record".
    .where('seq', '>=', '1')

  if (filter.from) query = query.where('occurred_at', '>=', filter.from)
  if (filter.to) query = query.where('occurred_at', '<=', filter.to)
  if (filter.action) query = query.where('action', '=', filter.action)
  if (filter.entityType) query = query.where('entity_type', '=', filter.entityType)
  if (filter.entityId) query = query.where('entity_id', '=', filter.entityId)
  if (filter.actorUserId) query = query.where('actor_user_id', '=', filter.actorUserId)
  if (filter.cursor) query = query.where('seq', '<', filter.cursor)

  // limit + 1: fetch one extra row so presence of a "next" page is known
  // without a second COUNT query.
  const rows = await query
    .orderBy('seq', 'desc')
    .limit(filter.limit + 1)
    .execute()

  const hasMore = rows.length > filter.limit
  const page = hasMore ? rows.slice(0, filter.limit) : rows

  return {
    items: page.map((row) => ({
      id: row.id,
      seq: row.seq,
      occurredAt: row.occurred_at,
      actorUserId: row.actor_user_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      beforeJson: row.before_json,
      afterJson: row.after_json,
      ip: row.ip,
      requestId: row.request_id,
      hash: row.hash,
      previousHash: row.previous_hash,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.seq ?? null) : null,
  }
}
