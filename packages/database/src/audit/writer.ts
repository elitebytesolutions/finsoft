import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { TenantContext } from '../tenant-context.ts'
import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'
import { auditChainLockKeyExpr } from './anchor.ts'
import { assertJcsSafe, computeAuditHash, HASH_VERSION, type JsonObject } from './canonical.ts'
import { normalizeIp } from './ip.ts'
import { buildCanonicalRecord } from './record.ts'

/*
 * The writer: recordAudit(tx, event). ADR-0020, NON_NEGOTIABLES rule 9.
 *
 * Runs inside the CALLER'S transaction — same-transaction audit — and MUST be
 * one of the LAST statements before commit. LOCK_REGISTRY.md position 6 is
 * TERMINAL: no external call (HTTP, SMTP, queue) may happen while the
 * advisory lock this function takes is held, and nothing may lock anything
 * after it in the same transaction except the implicit KEY SHARE row locks
 * audit_log's own foreign keys take.
 */

export interface AuditEventInput {
  readonly actorUserId: string | null
  readonly action: string
  readonly entityType: string
  readonly entityId: string | null
  /** Embedded and hashed as an object (ADR-0020 §4); every leaf must already be a string or null. */
  readonly beforeJson: JsonObject | null
  readonly afterJson: JsonObject | null
  /** Raw textual form; normalizeIp renders it before hashing. Null for job/system-originated events. */
  readonly ip: string | null
  readonly requestId: string | null
  /**
   * When the event happened. Defaults to the server clock. Rule 13: this must
   * already be a server-validated value — a business timestamp the domain
   * owns, or the moment the request was received — never a raw client-supplied
   * date passed straight through.
   */
  readonly occurredAt?: Date
}

export interface AuditAppendResult {
  readonly id: string
  readonly tenantId: string
  readonly seq: string
  readonly hash: string
  readonly previousHash: string
}

export class AuditChainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditChainError'
  }
}

/**
 * The terminal advisory lock (LOCK_REGISTRY.md position 6) could not be
 * acquired within `lock_timeout` (TD-001). Retryable: another append for the
 * same tenant is in flight and will release it shortly. Distinct from
 * AuditChainError, which means the chain itself is in a state recordAudit
 * cannot proceed from.
 */
export class AuditLockTimeoutError extends Error {
  readonly tenantId: string

  constructor(tenantId: string) {
    super(
      `audit_log: could not acquire the per-tenant chain lock for tenant ${tenantId} within the ` +
        'configured lock_timeout. Another append for this tenant is in flight; retry.',
    )
    this.name = 'AuditLockTimeoutError'
    this.tenantId = tenantId
  }
}

interface HeadRow {
  seq: string
  hash: string
}

/**
 * Append one audit record. Idempotency is the caller's — the posting engine
 * and its own idempotency key decide whether an operation happens at all; if
 * it does, exactly one audit row is written for it because this function is
 * called exactly once, inside the same transaction as everything else the
 * operation does.
 */
export async function recordAudit(
  tx: TenantTx,
  event: AuditEventInput,
): Promise<AuditAppendResult> {
  assertIssuedTenantTx(tx)
  const { tenantId } = TenantContext.require()

  // Fail fast in TypeScript, before a locked, half-built INSERT statement
  // finds out from a CHECK violation five layers into a posting transaction.
  if (event.beforeJson !== null) assertJcsSafe(event.beforeJson)
  if (event.afterJson !== null) assertJcsSafe(event.afterJson)

  /*
   * TD-001. `lock_timeout` is unset everywhere else in the repository, and
   * this is the first code path that takes the terminal advisory lock — the
   * decision TD-001 names as forcing it. Transaction-scoped (not pool-wide):
   * this bounds the wait for the lock itself, and 005:127-131's doctrine — a
   * revoke that gives up is worse than one that waits — governs OTHER waits
   * this transaction takes (the FK's KEY SHARE), not this one. 2000ms is
   * 2.5x the ARCHITECTURE §11 800ms posting P95 budget and well under the
   * 15000ms statement_timeout; Database/Architecture Guardian value pending
   * final sign-off (see the delivery report).
   */
  await sql`select set_config('lock_timeout', '2000ms', true)`.execute(tx)

  try {
    await sql`select pg_advisory_xact_lock(${auditChainLockKeyExpr(tenantId)})`.execute(tx)
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') {
      throw new AuditLockTimeoutError(tenantId)
    }
    throw error
  }

  /*
   * `seq` is NOT aliased. PostgreSQL resolves an ORDER BY name against the
   * SELECT LIST first, and `seq::text AS seq` (or even `seq::text` with no
   * explicit alias, which still names its output `seq`) makes `ORDER BY seq`
   * bind to the TEXT column — sorting alphabetically, so seq 10 sorts before
   * seq 2. Measured: the 11th append for a tenant failed
   * audit_log_tenant_seq_key because the "head" read named seq 10 as most
   * recent. int8 already arrives from the driver as a string (ADR-0011's
   * global type-parser default), so no cast is needed at all — selecting the
   * bare column keeps ORDER BY unambiguous AND keeps the TypeScript type a
   * string.
   */
  const { rows } = await sql<HeadRow>`
    SELECT seq, hash FROM audit_log
     WHERE tenant_id = ${tenantId}
     ORDER BY seq DESC
     LIMIT 1
  `.execute(tx)

  const head = rows[0]
  if (!head) {
    throw new AuditChainError(
      `audit_log has no anchor row for tenant ${tenantId} (available head: none, expected at least ` +
        'the seq=0 anchor). Tenant provisioning must create one in the same transaction as the ' +
        'tenants insert — see createAuditChainAnchor in packages/database/src/audit/anchor.ts.',
    )
  }

  const id = randomUUID()
  const seq = (BigInt(head.seq) + 1n).toString()
  const ip = event.ip === null ? null : normalizeIp(event.ip)
  const occurredAt = event.occurredAt ?? new Date()

  const record = buildCanonicalRecord({
    id,
    tenantId,
    seq,
    occurredAt,
    actorUserId: event.actorUserId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    beforeJson: event.beforeJson,
    afterJson: event.afterJson,
    ip,
    requestId: event.requestId,
  })

  const { hash } = computeAuditHash(head.hash, record)

  await sql`
    INSERT INTO audit_log (
      id, tenant_id, seq, occurred_at, actor_user_id, action, entity_type, entity_id,
      before_json, after_json, ip, request_id, hash_version, hash, previous_hash
    ) VALUES (
      ${record.id}, ${record.tenant_id}, ${record.seq}, ${record.occurred_at}::timestamptz,
      ${record.actor_user_id}, ${record.action}, ${record.entity_type}, ${record.entity_id},
      ${record.before_json === null ? null : JSON.stringify(record.before_json)}::jsonb,
      ${record.after_json === null ? null : JSON.stringify(record.after_json)}::jsonb,
      ${record.ip}, ${record.request_id}, ${HASH_VERSION}, ${hash}, ${head.hash}
    )
  `.execute(tx)

  return { id, tenantId, seq, hash, previousHash: head.hash }
}

/**
 * The structural seam the auth lane's `AuthAuditSink` (and any future module)
 * plugs into: `{ record(tx, event): Promise<void> }`. Deliberately not an
 * abstract class or a decorator — a plain object literal satisfying a plain
 * interface, so a caller can swap in a no-op default with no dependency on
 * this module beyond the type.
 */
export interface AuditSink {
  record(tx: TenantTx, event: AuditEventInput): Promise<void>
}

export const auditSink: AuditSink = {
  async record(tx, event) {
    await recordAudit(tx, event)
  },
}
