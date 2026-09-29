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
 * stored columns, and reports EVERY tenant's first break — with its tenant,
 * seq and id — rather than a boolean, and rather than stopping at the first
 * broken tenant. "A verifier that answers yes/no is useless during an
 * incident, when the question is always 'from where'" extends to "and how
 * many tenants" once more than one tenant exists.
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
  /** The first break found, across every tenant checked — null when ok is true. Kept for callers that only care whether/where verification first failed. */
  readonly firstBreak: ChainBreak | null
  /** Every break found. Verification does not stop at the first broken tenant: one tenant's corruption must not hide another's. */
  readonly breaks: readonly ChainBreak[]
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
 *
 * `seq > $2` (keyset) rather than OFFSET: this is read in BATCHES (see
 * verifyTenant below) so that verifying a large chain does not hold one
 * unbounded result set in memory. `seq > $2 ORDER BY seq LIMIT $3` reuses
 * audit_log_tenant_seq_key directly.
 */
const ROW_BATCH_QUERY = `
  SELECT id::text, tenant_id::text, seq,
         to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
         actor_user_id::text, action, entity_type, entity_id::text,
         before_json, after_json, ip, request_id::text,
         hash_version, hash, previous_hash
    FROM audit_log
   WHERE tenant_id = $1 AND seq > $2
   ORDER BY seq ASC
   LIMIT $3
`

/** Rows per batch. Small enough to bound memory on a multi-million-row chain, large enough that the round-trip count stays reasonable. */
const VERIFY_BATCH_SIZE = 5000

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
  batchSize: number = VERIFY_BATCH_SIZE,
): Promise<{ rowsChecked: number; brokenAt: ChainBreak | null }> {
  // Session-level (is_local = false): this connection is private to the
  // verifier, closed when it finishes, and never shared with another caller
  // between tenants — there is no pooled-reuse leakage risk SET LOCAL exists
  // to prevent elsewhere (transaction.ts's withTenant).
  await conn.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])

  let expectedSeq = 1n
  let expectedPreviousHash = GENESIS_HASH
  let checked = 0
  let lastSeq = '0'

  for (;;) {
    const rows = await conn.query<Row>(ROW_BATCH_QUERY, [tenantId, lastSeq, batchSize])
    if (rows.length === 0) break

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

    lastSeq = rows[rows.length - 1]!.seq
    if (rows.length < batchSize) break
  }

  return { rowsChecked: checked, brokenAt: null }
}

/*
 * Structural controls a CI-only assertion cannot see on a production
 * cluster. ADR-0020 Compliance: "the tgenabled assertion needs a
 * production-reachable counterpart, because a CI-only check runs against a
 * freshly migrated database and never sees the cluster where a trigger was
 * disabled to run a bulk fix." The verifier — run against any live cluster
 * as readonly_support — is that counterpart.
 *
 * EXPLICIT, NAMED SETS, not "whatever exists must be enabled/validated". A
 * query that only inspects rows already present in pg_trigger/pg_constraint
 * cannot see a DROPPED trigger or constraint at all — it would report zero
 * issues over an empty result set. The migration is compared against these
 * closed lists so a missing row is itself a finding, by name.
 */
const REQUIRED_TRIGGERS = [
  'audit_log_link',
  'audit_log_no_update',
  'audit_log_no_delete',
  'audit_log_no_truncate',
] as const

const REQUIRED_CONSTRAINTS = [
  'audit_log_pkey',
  'audit_log_seq_check',
  'audit_log_hash_check',
  'audit_log_hash_version_check',
  'audit_log_previous_hash_check',
  'audit_log_action_shape',
  'audit_log_entity_type_shape',
  'audit_log_before_json_is_object',
  'audit_log_after_json_is_object',
  'audit_log_before_json_no_numbers',
  'audit_log_after_json_no_numbers',
  'audit_log_before_json_bounded',
  'audit_log_after_json_bounded',
  'audit_log_ip_bounded',
  'audit_log_not_self',
  'audit_log_anchor_ties',
  'audit_log_genesis_ties',
  'audit_log_tenant_id_id_key',
  'audit_log_tenant_seq_key',
  'audit_log_tenant_hash_key',
  'audit_log_tenant_prev_key',
  'audit_log_tenant_fkey',
  'audit_log_actor_fkey',
  'audit_log_prev_fkey',
] as const

export interface StructuralIssue {
  readonly kind:
    | 'trigger_missing'
    | 'trigger_disabled'
    | 'constraint_missing'
    | 'constraint_not_validated'
    | 'rls_not_enabled'
    | 'rls_not_forced'
    | 'policy_missing'
    | 'grant_unexpected'
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
  const triggersByName = new Map(triggers.map((t) => [t.tgname, t]))
  for (const name of REQUIRED_TRIGGERS) {
    const found = triggersByName.get(name)
    if (!found) {
      issues.push({ kind: 'trigger_missing', name })
    } else if (found.tgenabled !== 'O') {
      issues.push({ kind: 'trigger_disabled', name })
    }
  }

  const constraints = await conn.query<{ conname: string; convalidated: boolean }>(`
    select con.conname, con.convalidated
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
     where c.relname = 'audit_log'
  `)
  const constraintsByName = new Map(constraints.map((c) => [c.conname, c]))
  for (const name of REQUIRED_CONSTRAINTS) {
    const found = constraintsByName.get(name)
    if (!found) {
      issues.push({ kind: 'constraint_missing', name })
    } else if (!found.convalidated) {
      issues.push({ kind: 'constraint_not_validated', name })
    }
  }

  // RLS. ADR-0004: ENABLE turns policies on; FORCE applies them to the
  // table's owner too. Overlaps database/tests/rls.spec.ts by design — that
  // suite runs once, at CI time, against a freshly migrated database; this
  // runs every time against whatever cluster is live.
  const [rlsRow] = await conn.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
    select relrowsecurity, relforcerowsecurity from pg_class where relname = 'audit_log'
  `)
  if (!rlsRow?.relrowsecurity) issues.push({ kind: 'rls_not_enabled', name: 'audit_log' })
  if (!rlsRow?.relforcerowsecurity) issues.push({ kind: 'rls_not_forced', name: 'audit_log' })

  const policies = await conn.query<{ polname: string }>(`
    select p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
     where c.relname = 'audit_log' and p.polname = 'tenant_isolation'
  `)
  if (policies.length === 0) issues.push({ kind: 'policy_missing', name: 'tenant_isolation' })

  // Privileges. Overlaps database/tests/audit-log.spec.ts's exact-ACL test by
  // design (see that file's own note on why) — this is the same question
  // asked of a live cluster rather than a freshly migrated CI database.
  const tableGrants = await conn.query<{ grantee: string; privilege: string }>(`
    select a.rolname as grantee, priv.privilege_type as privilege
      from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as x
      join pg_roles a on a.oid = x.grantee
      cross join lateral (values (x.privilege_type)) as priv(privilege_type)
     where c.relname = 'audit_log'
       and a.rolname in ('finsoft_app', 'readonly_support')
  `)
  const expectedTableGrants = new Set([
    'finsoft_app:SELECT',
    'finsoft_app:INSERT',
    'readonly_support:SELECT',
  ])
  const actualTableGrants = new Set(tableGrants.map((g) => `${g.grantee}:${g.privilege}`))
  for (const grant of actualTableGrants) {
    if (!expectedTableGrants.has(grant)) issues.push({ kind: 'grant_unexpected', name: grant })
  }

  const columnGrants = await conn.query<{ grantee: string; privilege: string; column: string }>(`
    select a.rolname as grantee, x.privilege_type as privilege, attr.attname as column
      from pg_class c
      join pg_attribute attr on attr.attrelid = c.oid and attr.attnum > 0 and not attr.attisdropped
      cross join lateral aclexplode(attr.attacl) as x
      join pg_roles a on a.oid = x.grantee
     where c.relname = 'audit_log'
       and attr.attacl is not null
       and a.rolname in ('finsoft_app', 'readonly_support')
  `)
  const expectedColumnGrants = new Set(['finsoft_app:UPDATE:ip'])
  const actualColumnGrants = new Set(
    columnGrants.map((g) => `${g.grantee}:${g.privilege}:${g.column}`),
  )
  for (const grant of actualColumnGrants) {
    if (!expectedColumnGrants.has(grant)) issues.push({ kind: 'grant_unexpected', name: grant })
  }

  return issues
}

/**
 * Verify one tenant's chain, or every tenant's if `tenantId` is omitted.
 * Does not stop at the first broken tenant when checking the whole cluster —
 * every tenant is checked, and every break found is returned.
 *
 * `baseUrlVar` selects which connection string the readonly_support
 * credentials are derived from (DATABASE_URL in production; tests pass
 * TEST_DATABASE_URL).
 *
 * An explicit `tenantId` that does not exist in the global `tenants` table,
 * or whose chain has no seq=0 anchor at all, is itself a break — not a
 * silent "0 rows checked, ok: true". A verifier that reports OK for a typo'd
 * tenant id is worse than one that refuses to run at all.
 */
export async function verifyAuditChain(
  tenantId?: string,
  baseUrlVar = 'DATABASE_URL',
  /** Test-only: override the keyset page size to exercise multi-batch continuation without needing thousands of rows. */
  batchSize: number = VERIFY_BATCH_SIZE,
): Promise<VerifyResult> {
  const conn = await openSupportConnection(baseUrlVar)
  try {
    const structuralIssues = await checkStructuralControls(conn)
    if (structuralIssues.length > 0) {
      const breaks = structuralIssues.map((issue) => ({
        tenantId: '(structural)',
        seq: '-',
        id: null,
        reason: describeStructuralIssue(issue),
      }))
      return { ok: false, tenantsChecked: 0, rowsChecked: 0, firstBreak: breaks[0]!, breaks }
    }

    let tenantIds: string[]
    if (tenantId) {
      const [exists] = await conn.query<{ id: string }>(
        'SELECT id::text AS id FROM tenants WHERE id = $1',
        [tenantId],
      )
      if (!exists) {
        const brokenAt: ChainBreak = {
          tenantId,
          seq: '-',
          id: null,
          reason: `tenant "${tenantId}" does not exist in the tenants table`,
        }
        return {
          ok: false,
          tenantsChecked: 0,
          rowsChecked: 0,
          firstBreak: brokenAt,
          breaks: [brokenAt],
        }
      }

      // audit_log is tenant-owned and RLS-protected: app.tenant_id must be
      // set before this query, or current_setting() inside the policy
      // raises "unrecognized configuration parameter" rather than the
      // expected "no anchor" outcome — measured, this was missing here.
      await conn.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])

      const [anchor] = await conn.query<{ hash: string; previous_hash: string | null }>(
        'SELECT hash, previous_hash FROM audit_log WHERE tenant_id = $1 AND seq = 0',
        [tenantId],
      )
      if (!anchor) {
        const brokenAt: ChainBreak = {
          tenantId,
          seq: '0',
          id: null,
          reason:
            'no seq=0 anchor row exists for this tenant — tenant provisioning did not create one',
        }
        return {
          ok: false,
          tenantsChecked: 0,
          rowsChecked: 0,
          firstBreak: brokenAt,
          breaks: [brokenAt],
        }
      }
      if (anchor.hash !== GENESIS_HASH || anchor.previous_hash !== null) {
        const brokenAt: ChainBreak = {
          tenantId,
          seq: '0',
          id: null,
          reason: `the seq=0 anchor is malformed (hash="${anchor.hash}", previous_hash="${anchor.previous_hash}") — expected hash=${GENESIS_HASH}, previous_hash=null`,
        }
        return {
          ok: false,
          tenantsChecked: 0,
          rowsChecked: 0,
          firstBreak: brokenAt,
          breaks: [brokenAt],
        }
      }

      tenantIds = [tenantId]
    } else {
      tenantIds = (
        await conn.query<{ id: string }>('SELECT id::text AS id FROM tenants ORDER BY id')
      ).map((r) => r.id)
    }

    let rowsChecked = 0
    const breaks: ChainBreak[] = []

    for (const id of tenantIds) {
      const { rowsChecked: checked, brokenAt } = await verifyTenant(conn, id, batchSize)
      rowsChecked += checked
      if (brokenAt) breaks.push(brokenAt)
    }

    return {
      ok: breaks.length === 0,
      tenantsChecked: tenantIds.length,
      rowsChecked,
      firstBreak: breaks[0] ?? null,
      breaks,
    }
  } finally {
    await conn.close()
  }
}

function describeStructuralIssue(issue: StructuralIssue): string {
  switch (issue.kind) {
    case 'trigger_missing':
      return `trigger "${issue.name}" on audit_log does not exist — it was DROPPED`
    case 'trigger_disabled':
      return `trigger "${issue.name}" on audit_log is DISABLED — the owning role has defeated a control ADR-0020 §5 requires enabled`
    case 'constraint_missing':
      return `constraint "${issue.name}" on audit_log does not exist — it was DROPPED`
    case 'constraint_not_validated':
      return `constraint "${issue.name}" on audit_log is NOT VALIDATED`
    case 'rls_not_enabled':
      return 'audit_log does not have ROW LEVEL SECURITY enabled'
    case 'rls_not_forced':
      return 'audit_log does not FORCE ROW LEVEL SECURITY (the owner would bypass it)'
    case 'policy_missing':
      return 'audit_log has no "tenant_isolation" policy'
    case 'grant_unexpected':
      return `unexpected grant: ${issue.name}`
  }
}
