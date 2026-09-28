import type { CanonicalAuditRecord, JsonObject } from './canonical.ts'

/*
 * Raw application values -> the canonical string/null form ADR-0020 §4's
 * column mapping table specifies. Kept separate from canonical.ts so the
 * golden-vector tests can feed already-formatted literals straight into
 * computeAuditHash without going through Date/uuid formatting at all.
 */

export interface RawAuditFields {
  readonly id: string
  readonly tenantId: string
  /** Decimal string, no sign for positives — the caller has already done the bigint arithmetic. */
  readonly seq: string
  readonly occurredAt: Date
  readonly actorUserId: string | null
  readonly action: string
  readonly entityType: string
  readonly entityId: string | null
  readonly beforeJson: JsonObject | null
  readonly afterJson: JsonObject | null
  /** Already normalised by normalizeIp, or null. */
  readonly ip: string | null
  readonly requestId: string | null
}

/**
 * `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
 * — ADR-0020 §4's column mapping, reproduced in TypeScript for the writer,
 * which must format its OWN timestamp before the database has stored
 * anything (the app must never hash a value the database has not produced
 * yet — §4 writer rule 2).
 *
 * `Date.prototype.toISOString()` yields three fractional digits; this pads to
 * exactly six, matching the ADR's own example
 * (2026-09-24T00:17:04.120000Z from a plain millisecond value).
 */
export function toMicrosecondIso(date: Date): string {
  const iso = date.toISOString()
  const match = /^(.*)\.(\d{3})Z$/.exec(iso)
  if (!match) {
    // toISOString() always produces this shape for a valid Date; a Date that
    // is not finite (Invalid Date) is the only way to reach here.
    throw new RangeError(
      `"${String(date)}" is not a valid Date and cannot be hashed into the audit chain.`,
    )
  }
  return `${match[1]}.${match[2]}000Z`
}

/** Lowercase canonical uuid text, or null. PostgreSQL already renders uuid::text lowercase; this is for values that have not been through the database yet. */
function lowercaseOrNull(value: string | null): string | null {
  return value === null ? null : value.toLowerCase()
}

export function buildCanonicalRecord(fields: RawAuditFields): CanonicalAuditRecord {
  return {
    id: fields.id.toLowerCase(),
    tenant_id: fields.tenantId.toLowerCase(),
    seq: fields.seq,
    occurred_at: toMicrosecondIso(fields.occurredAt),
    actor_user_id: lowercaseOrNull(fields.actorUserId),
    action: fields.action,
    entity_type: fields.entityType,
    entity_id: lowercaseOrNull(fields.entityId),
    before_json: fields.beforeJson,
    after_json: fields.afterJson,
    ip: fields.ip,
    request_id: lowercaseOrNull(fields.requestId),
  }
}
