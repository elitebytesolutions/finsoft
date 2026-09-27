import { Client } from 'pg'
import { recordAudit, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  scalarOn,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { acquireTriggerLock, releaseTriggerLock } from './trigger-mutation-lock.ts'

/*
 * audit_log, exercised through DIRECT SQL as finsoft_app — the role every
 * posting path actually writes as. ADR-0020, NON_NEGOTIABLES rule 9.
 *
 * "A privilege statement's success is not evidence" (task brief, echoing
 * database/tests's own standard): every claim below is either a query that
 * fails, or an effective-privilege question asked of PostgreSQL directly via
 * has_table_privilege, not a read of the migration's GRANT statements.
 */

let tenant: TenantFixture
let other: TenantFixture
let lockClient: Client

beforeAll(async () => {
  await prepareTestDatabase()
  lockClient = new Client({ connectionString: process.env['TEST_MIGRATION_DATABASE_URL'] })
  await lockClient.connect()
  ;[tenant, other] = await Promise.all([createTenantFixture('AUD'), createTenantFixture('AUY')])
}, 60_000)

afterAll(async () => {
  await lockClient.end()
  await teardownTestDatabase()
})

/*
 * EVERY test in this file asserts something about a trigger on audit_log
 * being enabled — that is what "append-only, at the trigger layer" and
 * "chain integrity" mean. ALTER TABLE ... TRIGGER is DDL: it commits
 * immediately and is visible cluster-wide the instant it does, so any test
 * anywhere (audit-log-concurrency.spec.ts deliberately disables triggers in
 * the owner-adversarial regime ADR-0020 §5 describes) can otherwise leave a
 * window where this file's assertions race a transient disabled state.
 * Global beforeEach/afterEach, rather than hunting down each vulnerable
 * assertion individually — that approach was tried first and missed one
 * (see git history on this file), because "every test in this file" is
 * easy to state and easy to under-enumerate by hand.
 */
beforeEach(() => acquireTriggerLock(lockClient))
afterEach(() => releaseTriggerLock(lockClient))

/** Append one real audit row for `tenant` via the actual writer, returning its id/seq/hash. */
async function append(t: TenantFixture = tenant, action = 'PROBE_ACTION') {
  return runAs({ tenantId: t.tenantId, userId: t.ownerId }, () =>
    withTenant((tx) =>
      recordAudit(tx, {
        actorUserId: t.ownerId,
        action,
        entityType: 'probe',
        entityId: null,
        beforeJson: null,
        afterJson: { field: 'value' },
        ip: '203.0.113.7',
        requestId: null,
      }),
    ),
  )
}

describe('append-only, at the privilege layer', () => {
  it('grants finsoft_app SELECT, INSERT, DELETE=false, TRUNCATE=false', async () => {
    for (const [privilege, expected] of [
      ['SELECT', true],
      ['INSERT', true],
      ['DELETE', false],
      ['TRUNCATE', false],
    ] as const) {
      const granted = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) =>
          scalarOn<boolean>(tx, 'select has_table_privilege(current_user, $1, $2)', [
            'audit_log',
            privilege,
          ]),
        ),
      )
      expect(granted, `finsoft_app ${privilege} on audit_log`).toBe(expected)
    }
  })

  it('grants finsoft_app UPDATE on exactly one column (ip), and no table-level UPDATE', async () => {
    // has_table_privilege('UPDATE') reports true if ANY column carries the
    // grant — it does not by itself distinguish "the whole row" from "one
    // column". has_column_privilege is what actually draws that line.
    const columns = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn<{ column_name: string }>(
          tx,
          `select a.attname as column_name
             from pg_attribute a
             join pg_class c on c.oid = a.attrelid
            where c.relname = 'audit_log'
              and a.attnum > 0 and not a.attisdropped
              and has_column_privilege(current_user, c.oid, a.attname, 'UPDATE')`,
        ),
      ),
    )
    expect(
      columns.map((c) => c.column_name),
      'finsoft_app should hold UPDATE on exactly the ip column — a privilege-only grant so ' +
        "PostgreSQL's row-locking clauses (FOR SHARE) are reachable at all, superseded in practice " +
        'by audit_log_no_update, which rejects every UPDATE unconditionally',
    ).toEqual(['ip'])
  })

  it('still rejects an UPDATE of ip itself — the grant confers no real capability', async () => {
    const row = await append()
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) =>
          rawOn(tx, 'UPDATE audit_log SET ip = $1 WHERE id = $2', ['203.0.113.9', row.id]),
        ),
      ),
    ).rejects.toThrow(/append-only/)
  })

  it('grants readonly_support SELECT only', async () => {
    const select = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        scalarOn<boolean>(tx, "select has_table_privilege('readonly_support', $1, 'SELECT')", [
          'audit_log',
        ]),
      ),
    )
    const insert = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        scalarOn<boolean>(tx, "select has_table_privilege('readonly_support', $1, 'INSERT')", [
          'audit_log',
        ]),
      ),
    )
    expect(select).toBe(true)
    expect(insert).toBe(false)
  })
})

describe('append-only, at the trigger layer — against the OWNING role, not just finsoft_app', () => {
  it('rejects UPDATE as finsoft_app at the privilege layer (no grant at all)', async () => {
    const row = await append()
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) =>
          rawOn(tx, 'UPDATE audit_log SET action = $1 WHERE id = $2', ['TAMPERED', row.id]),
        ),
      ),
      // finsoft_app has no UPDATE grant on this table at all, so PostgreSQL
      // refuses at the privilege layer before the statement can even reach
      // the append-only trigger. The trigger is the control against the
      // OWNING role (finsoft_migration, which holds every privilege
      // inherently) — see audit-log-concurrency.spec.ts, which connects AS
      // that role directly and finds the trigger rejecting it there.
    ).rejects.toThrow(/permission denied for table audit_log/)
  })

  it('rejects DELETE as finsoft_app at the privilege layer', async () => {
    const row = await append()
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) => rawOn(tx, 'DELETE FROM audit_log WHERE id = $1', [row.id])),
      ),
    ).rejects.toThrow(/permission denied for table audit_log/)
  })

  it('has both triggers enabled (pg_trigger.tgenabled = O), not merely present', async () => {
    // ADR-0020 Compliance: presence alone is not the assertion, because a
    // non-superuser owner can ALTER TABLE ... DISABLE TRIGGER a plpgsql
    // trigger. This is the CI-reachable half of that check — the
    // production-reachable half is verifyAuditChain's own structural check
    // (packages/database/src/audit/verify.ts).
    //
    const rows = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn<{ tgname: string; tgenabled: string }>(
          tx,
          `select t.tgname, t.tgenabled
             from pg_trigger t
             join pg_class c on c.oid = t.tgrelid
            where c.relname = 'audit_log' and not t.tgisinternal
            order by t.tgname`,
        ),
      ),
    )
    const names = rows.map((r) => r.tgname).sort()
    expect(names).toEqual([
      'audit_log_link',
      'audit_log_no_delete',
      'audit_log_no_truncate',
      'audit_log_no_update',
    ])
    for (const row of rows) {
      expect(row.tgenabled, `${row.tgname} is not enabled ('O')`).toBe('O')
    }
  })
})

describe('chain integrity — forgeries rejected as finsoft_app, under FORCE RLS', () => {
  /*
   * ADR-0020 §5's own table says which control catches which forgery WHEN
   * THE LINKAGE TRIGGER IS ENABLED (the only regime finsoft_app can ever
   * reach — it holds no privilege to disable a trigger). Two consequences
   * that shape every test below:
   *
   *   - The trigger is a BEFORE ROW trigger and runs before CHECK
   *     constraints, so any row whose (seq, previous_hash) does not
   *     correctly name the real predecessor is rejected BY THE TRIGGER,
   *     with its own message — never reaching the constraint that would
   *     otherwise have caught it. "orphan" and "bad adjacency" are exactly
   *     this case, per the ADR's own table.
   *   - To exercise duplicate-hash / self-link / second-genesis IN
   *     ISOLATION, a probe row must first satisfy the trigger's adjacency
   *     check (correct seq, previous_hash = the real predecessor's hash) —
   *     only then does it reach the constraints these tests are actually
   *     about.
   */

  it('rejects an orphan: previous_hash naming a hash that does not exist in this tenant (caught by the trigger, enabled)', async () => {
    await append() // establish a real head so seq 500 is unambiguously non-adjacent
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) =>
          rawOn(
            tx,
            `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type,
               hash_version, hash, previous_hash)
             VALUES ($1, 500, now(), 'ORPHAN_ATTEMPT', 'probe', 'v1', $2, $3)`,
            [tenant.tenantId, 'a'.repeat(64), 'b'.repeat(64)],
          ),
        ),
      ),
    ).rejects.toThrow(/previous_hash does not match the hash at seq/)
  })

  it('rejects a bad adjacency: seq correctly next, previous_hash wrong for that seq (caught by the trigger, enabled)', async () => {
    const first = await append(other, 'SEQ2_SETUP')
    await expect(
      runAs({ tenantId: other.tenantId, userId: other.ownerId }, () =>
        withTenant((tx) =>
          rawOn(
            tx,
            `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type,
               hash_version, hash, previous_hash)
             VALUES ($1, $2, now(), 'BAD_ADJACENCY', 'probe', 'v1', $3, $4)`,
            [other.tenantId, Number(first.seq) + 1, 'e'.repeat(64), 'f'.repeat(64)],
          ),
        ),
      ),
    ).rejects.toThrow(/previous_hash does not match the hash at seq/)
  })

  it('rejects a duplicate hash within the same tenant, once adjacency is otherwise correct', async () => {
    const first = await append()
    // previous_hash correctly names the real predecessor (passes the
    // trigger); hash duplicates the ANCHOR's hash (GENESIS_HASH), a value
    // already present in this tenant and distinct from previous_hash — so
    // this row is not also a self-link.
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) =>
          rawOn(
            tx,
            `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type,
               hash_version, hash, previous_hash)
             VALUES ($1, $2, now(), 'DUPLICATE_HASH_ATTEMPT', 'probe', 'v1', $3, $4)`,
            [tenant.tenantId, Number(first.seq) + 1, '0'.repeat(64), first.hash],
          ),
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'audit_log_tenant_hash_key' })
  })

  it('rejects a self-link: previous_hash equal to hash, once adjacency is otherwise correct', async () => {
    const first = await append()
    // previous_hash correctly names the real predecessor (passes the
    // trigger); hash is set to that SAME value, which is simultaneously a
    // self-link (previous_hash = hash) and a duplicate of an existing hash —
    // the two are inseparable once previous_hash must name a real row.
    // CHECK constraints are evaluated before unique-index insertion in
    // PostgreSQL's insert path, so audit_log_not_self is what actually fires.
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) =>
          rawOn(
            tx,
            `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type,
               hash_version, hash, previous_hash)
             VALUES ($1, $2, now(), 'SELF_LINK_ATTEMPT', 'probe', 'v1', $3, $3)`,
            [tenant.tenantId, Number(first.seq) + 1, first.hash],
          ),
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'audit_log_not_self' })
  })

  it('rejects a second genesis: a second seq=1 for a tenant that already has one', async () => {
    await append(other) // the real seq=1 for `other`
    await expect(
      runAs({ tenantId: other.tenantId, userId: other.ownerId }, () =>
        withTenant((tx) =>
          rawOn(
            tx,
            `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type,
               hash_version, hash, previous_hash)
             VALUES ($1, 1, now(), 'SECOND_GENESIS_ATTEMPT', 'probe', 'v1', $2, $3)`,
            [other.tenantId, 'd'.repeat(64), '0'.repeat(64)],
          ),
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'audit_log_tenant_seq_key' })
  })

  it('rejects a numeric leaf inside after_json (ADR-0020 §2), once adjacency is otherwise correct', async () => {
    const first = await append()
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) =>
          rawOn(
            tx,
            `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type,
               after_json, hash_version, hash, previous_hash)
             VALUES ($1, $2, now(), 'NUMERIC_LEAF', 'probe', '{"amount": 1.1}'::jsonb, 'v1', $3, $4)`,
            [tenant.tenantId, Number(first.seq) + 1, '1'.repeat(64), first.hash],
          ),
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'audit_log_after_json_no_numbers' })
  })

  it('rejects a boolean leaf inside before_json, once adjacency is otherwise correct', async () => {
    const first = await append()
    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant((tx) =>
          rawOn(
            tx,
            `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type,
               before_json, hash_version, hash, previous_hash)
             VALUES ($1, $2, now(), 'BOOLEAN_LEAF', 'probe', '{"active": true}'::jsonb, 'v1', $3, $4)`,
            [tenant.tenantId, Number(first.seq) + 1, '2'.repeat(64), first.hash],
          ),
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'audit_log_before_json_no_numbers' })
  })
})

describe('a legitimate append still succeeds', () => {
  it('chains onto the tenant head via the real writer', async () => {
    const r1 = await append(tenant, 'LEGIT_ONE')
    const r2 = await append(tenant, 'LEGIT_TWO')
    expect(r2.previousHash).toBe(r1.hash)
    expect(Number(r2.seq)).toBe(Number(r1.seq) + 1)
  })
})

describe('cross-tenant isolation on this table', () => {
  it('tenant B cannot see tenant A rows via a bare SELECT', async () => {
    const a = await append(tenant, 'ISOLATION_A')
    const visible = await runAs({ tenantId: other.tenantId, userId: other.ownerId }, () =>
      withTenant((tx) => rawOn(tx, 'SELECT 1 FROM audit_log WHERE id = $1', [a.id])),
    )
    expect(visible).toEqual([])
  })
})
