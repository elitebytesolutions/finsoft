import {
  computeAuditHash,
  GENESIS_HASH,
  type CanonicalAuditRecord,
  type JsonValue,
} from './canonical.ts'
import { openSupportConnection, type SupportConnection } from './support-connection.ts'

/*
 * The verifier. ADR-0020 §6, WAVE_1_REGISTER.md W1-005: "the deliverable is
 * the verifier, not the table."
 *
 * Walks each tenant's chain in seq order, recomputing every hash from the
 * stored columns, and reports the FIRST break — with its tenant, seq and id —
 * rather than a boolean. "A verifier that answers yes/no is useless during an
 * incident, when the question is always 'from where'."
 */

export interface ChainBreak {
  readonly tenantId: string
  readonly seq: string
  readonly id: string | null
  readonly reason: string
}

export interface VerifyResult {
  readonly ok: boolean
  readonly tenantsChecked: number
  readonly rowsChecked: number
  readonly firstBreak: ChainBreak | null
}

interface Row {
  id: string
  tenant_id: string
  seq: string
  occurred_at: string
  actor_user_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  before_json: unknown
  after_json: unknown
  ip: string | null
  request_id: string | null
  hash_version: string
  hash: string
  previous_hash: string | null
}

/*
 * occurred_at is read through to_char with ADR-0020 §4's exact format string
 * rather than reconstructed from a driver-parsed Date, so the verifier is not
 * trusting a round-trip assumption about millisecond-vs-microsecond
 * precision — it reproduces the ADR's own formula directly in SQL, which is
 * what the formula is for.
 *
 * `seq` is deliberately NOT cast or aliased in the select list. PostgreSQL
 * resolves an ORDER BY name against the select list first, and `seq::text`
 * (even with no explicit AS — a cast keeps its source column's name) makes
 * `ORDER BY seq` sort ALPHABETICALLY: seq 10 before seq 2. Measured: a
 * 25-row chain reported a false break at seq 2 ("expected seq 2, found 10")
 * on a fully intact chain. int8 already arrives as a string from the driver
 * (ADR-0011's global type-parser default), so the bare column is both
 * correct for ORDER BY and already the right TypeScript type.
 */
const ROW_QUERY = `
  SELECT id::text, tenant_id::text, seq,
         to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
         actor_user_id::text, action, entity_type, entity_id::text,
         before_json, after_json, ip, request_id::text,
         hash_version, hash, previous_hash
    FROM audit_log
   WHERE tenant_id = $1 AND seq >= 1
   ORDER BY seq ASC
`

function rowToCanonicalRecord(row: Row): CanonicalAuditRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    seq: row.seq,
    occurred_at: row.occurred_at,
    actor_user_id: row.actor_user_id,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    before_json: (row.before_json ?? null) as JsonValue,
    after_json: (row.after_json ?? null) as JsonValue,
    ip: row.ip,
    request_id: row.request_id,
  }
}

async function verifyTenant(
  conn: SupportConnection,
  tenantId: string,
): Promise<{ rowsChecked: number; brokenAt: ChainBreak | null }> {
  // Session-level (is_local = false): this connection is private to the
  // verifier, closed when it finishes, and never shared with another caller
  // between tenants — there is no pooled-reuse leakage risk SET LOCAL exists
  // to prevent elsewhere (transaction.ts's withTenant).
  await conn.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])
  const rows = await conn.query<Row>(ROW_QUERY, [tenantId])

  let expectedSeq = 1n
  let expectedPreviousHash = GENESIS_HASH
  let checked = 0

  for (const row of rows) {
    checked += 1
    const seq = BigInt(row.seq)

    if (seq !== expectedSeq) {
      return {
        rowsChecked: checked,
        brokenAt: {
          tenantId,
          seq: expectedSeq.toString(),
          id: null,
          reason: `expected seq ${expectedSeq}, found ${row.seq} — a row is missing, or a seq was renumbered`,
        },
      }
    }

    if (row.previous_hash !== expectedPreviousHash) {
      return {
        rowsChecked: checked,
        brokenAt: {
          tenantId,
          seq: row.seq,
          id: row.id,
          reason: `previous_hash "${row.previous_hash}" does not match the parent's actual hash "${expectedPreviousHash}"`,
        },
      }
    }

    const { hash } = computeAuditHash(
      expectedPreviousHash,
      rowToCanonicalRecord(row),
      row.hash_version,
    )
    if (hash !== row.hash) {
      return {
        rowsChecked: checked,
        brokenAt: {
          tenantId,
          seq: row.seq,
          id: row.id,
          reason: `recomputed hash "${hash}" does not match the stored hash "${row.hash}" — this row was altered after it was written`,
        },
      }
    }

    expectedPreviousHash = row.hash
    expectedSeq += 1n
  }

  return { rowsChecked: checked, brokenAt: null }
}

/**
 * Structural controls a CI-only assertion cannot see on a production
 * cluster: whether the append-only and linkage triggers are still enabled,
 * and whether every constraint on `audit_log` is `convalidated`. ADR-0020
 * Compliance: "the tgenabled assertion needs a production-reachable
 * counterpart, because a CI-only check runs against a freshly migrated
 * database and never sees the cluster where a trigger was disabled to run a
 * bulk fix." The verifier — run against any live cluster as readonly_support
 * — is that counterpart.
 */
export interface StructuralIssue {
  readonly kind: 'trigger_disabled' | 'constraint_not_validated'
  readonly name: string
}

async function checkStructuralControls(conn: SupportConnection): Promise<StructuralIssue[]> {
  const issues: StructuralIssue[] = []

  const triggers = await conn.query<{ tgname: string; tgenabled: string }>(`
    select t.tgname, t.tgenabled
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'audit_log' and not t.tgisinternal
  `)
  for (const t of triggers) {
    if (t.tgenabled !== 'O') issues.push({ kind: 'trigger_disabled', name: t.tgname })
  }

  const constraints = await conn.query<{ conname: string; convalidated: boolean }>(`
    select con.conname, con.convalidated
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
     where c.relname = 'audit_log'
  `)
  for (const c of constraints) {
    if (!c.convalidated) issues.push({ kind: 'constraint_not_validated', name: c.conname })
  }

  return issues
}

/**
 * Verify one tenant's chain, or every tenant's if `tenantId` is omitted.
 * `baseUrlVar` selects which connection string the readonly_support
 * credentials are derived from (DATABASE_URL in production; tests pass
 * TEST_DATABASE_URL).
 */
export async function verifyAuditChain(
  tenantId?: string,
  baseUrlVar = 'DATABASE_URL',
): Promise<VerifyResult> {
  const conn = await openSupportConnection(baseUrlVar)
  try {
    const structuralIssues = await checkStructuralControls(conn)
    if (structuralIssues.length > 0) {
      const first = structuralIssues[0]!
      return {
        ok: false,
        tenantsChecked: 0,
        rowsChecked: 0,
        firstBreak: {
          tenantId: '(structural)',
          seq: '-',
          id: null,
          reason:
            first.kind === 'trigger_disabled'
              ? `trigger "${first.name}" on audit_log is DISABLED — the owning role has defeated a control ADR-0020 §5 requires enabled`
              : `constraint "${first.name}" on audit_log is NOT VALIDATED`,
        },
      }
    }

    const tenantIds = tenantId
      ? [tenantId]
      : (await conn.query<{ id: string }>('SELECT id::text AS id FROM tenants ORDER BY id')).map(
          (r) => r.id,
        )

    let rowsChecked = 0
    let tenantsChecked = 0

    for (const id of tenantIds) {
      const { rowsChecked: checked, brokenAt } = await verifyTenant(conn, id)
      rowsChecked += checked
      tenantsChecked += 1

      if (brokenAt) {
        return { ok: false, tenantsChecked, rowsChecked, firstBreak: brokenAt }
      }
    }

    return { ok: true, tenantsChecked, rowsChecked, firstBreak: null }
  } finally {
    await conn.close()
  }
}
