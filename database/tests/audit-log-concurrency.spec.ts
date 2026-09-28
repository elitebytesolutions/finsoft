import { Client } from 'pg'
import { closeDatabase, openDatabase, recordAudit, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  scalarOn,
  TEST_TARGET,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTriggersLocked } from './trigger-mutation-lock.ts'

/*
 * Concurrency and chain-fork resistance. ADR-0020 §5, and its three
 * conditions carried to this migration:
 *
 *   1. The two-connection FOR SHARE test must go RED against an unlocked
 *      read before it counts. Verified manually during development by
 *      temporarily removing FOR SHARE from audit_log_enforce_linkage() in
 *      the live test database, confirming this suite's first test failed,
 *      then restoring it — the committed function always carries FOR SHARE,
 *      so that negative run is not repeatable from this file alone, exactly
 *      as migration 005's own doctrine describes.
 *   2. Multi-row audit inserts: forbidden by the writer (recordAudit issues
 *      exactly one INSERT per call), and tested in BOTH seq orders below —
 *      the forward direction is not evidence on its own (005/009's own
 *      lesson: a trigger that sees rows in statement order can pass in one
 *      direction and fail in the other for a reason that has nothing to do
 *      with the property under test).
 *   3. A concurrent-append test running AS finsoft_app UNDER RLS, not as the
 *      migration role — a fork test with BYPASSRLS is not testing the table
 *      the application writes to.
 */

function migrationClient(): Client {
  const url = process.env['TEST_MIGRATION_DATABASE_URL']
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
  return new Client({ connectionString: url })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

describe("the linkage trigger's FOR SHARE lock", () => {
  /*
   * ORDERING MATTERS, and an earlier draft of this test got it backwards.
   * "T_A inserts seq 3, THEN T_B renumbers seq 2" (the ADR's own prose order)
   * blocks with or without FOR SHARE, because `seq` is itself part of a
   * UNIQUE constraint (audit_log_tenant_seq_key) — PostgreSQL promotes ANY
   * update to a uniquely-indexed column to a lock strength that conflicts
   * with the FK's own automatic FOR KEY SHARE on the referenced row
   * (audit_log_prev_fkey), independent of anything this trigger does.
   * Measured directly: a bare `SELECT ... FOR KEY SHARE` (no trigger
   * involved at all) already blocks a concurrent `UPDATE ... SET seq = …`
   * for exactly this reason, and removing FOR SHARE from
   * audit_log_enforce_linkage() left this test's original ordering green.
   * ADR-0020 §5's claim that "the FK does not help ... seq is not in [the
   * referenced key]" is therefore incomplete on PostgreSQL 17: it is true
   * that seq is not in audit_log_prev_fkey's OWN referenced key, but
   * PostgreSQL's lock-strength decision is driven by ANY unique index on the
   * table, not only by the specific FK doing the referencing. Flagged for
   * the Architecture/Database Guardians to correct at the ADR level; not
   * something this migration can amend.
   *
   * The ordering that actually isolates FOR SHARE's contribution is the
   * OTHER one: T_B renumbers seq 2 FIRST and leaves it UNCOMMITTED, then T_A
   * attempts to insert seq 3. Without FOR SHARE, T_A's unlocked read sees
   * the pre-renumber snapshot (plain MVCC readers never block on or see
   * uncommitted writes), so it succeeds — and once T_B then commits, the
   * result is 0, 1, 3, 99: the ADR's own false gap. WITH FOR SHARE, T_A's
   * read blocks until T_B commits, then re-evaluates against the NEW
   * committed row (seq now 99, not 2) and correctly rejects the insert.
   *
   * T_A runs as `finsoft_app`, through the real `recordAudit`/withTenant
   * path — not as the migration role — because a race exercised only by a
   * superuser-equivalent connection is not proof about the table the
   * application actually writes to (ADR-0020 Compliance, condition 3).
   * T_B still has to be the owner with the append-only trigger disabled:
   * finsoft_app holds no UPDATE grant on `seq` at all (only the
   * privilege-only grant on `ip`), so it cannot issue this statement under
   * any circumstances — which is itself asserted in audit-log.spec.ts.
   */
  let tenant: TenantFixture

  beforeAll(async () => {
    tenant = await createTenantFixture('CCF')
  }, 30_000)

  it("blocks T_A (finsoft_app) behind T_B's uncommitted renumber of seq 2, and re-checks against the committed result", async () => {
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        recordAudit(tx, {
          actorUserId: tenant.ownerId,
          action: 'SEED_ONE',
          entityType: 'probe',
          entityId: null,
          beforeJson: null,
          afterJson: null,
          ip: null,
          requestId: null,
        }),
      ),
    )
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        recordAudit(tx, {
          actorUserId: tenant.ownerId,
          action: 'SEED_TWO',
          entityType: 'probe',
          entityId: null,
          beforeJson: null,
          afterJson: null,
          ip: null,
          requestId: null,
        }),
      ),
    )

    const admin = migrationClient()
    const tB = migrationClient()
    await admin.connect()
    await tB.connect()

    // A second, wider pool so T_A's recordAudit call gets its own physical
    // connection and can genuinely overlap with T_B rather than queueing
    // behind it on a pool of size 1 (mirrors tenant-isolation-multiconnection.spec.ts).
    await closeDatabase()
    process.env['DATABASE_POOL_MAX'] = '4'
    await openDatabase(TEST_TARGET)

    try {
      // The whole disable -> mutate -> re-enable window is held under a
      // single test-only advisory lock (see trigger-mutation-lock.ts):
      // ALTER TABLE ... TRIGGER is DDL and commits immediately, visible to
      // every other connection instantly, and this suite's own "both
      // triggers enabled" assertion in audit-log.spec.ts must never observe
      // the disabled window.
      await withTriggersLocked(admin, async () => {
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update')

        try {
          // T_B: renumber seq 2 -> 99, and leave it UNCOMMITTED.
          await tB.query('BEGIN')
          await tB.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId])
          const renumberResult = await tB.query(
            'UPDATE audit_log SET seq = 99 WHERE tenant_id = $1 AND seq = 2',
            [tenant.tenantId],
          )
          expect(renumberResult.rowCount, 'T_B must actually have renumbered a row').toBe(1)

          // T_A: attempt seq 3, linking onto the ORIGINAL seq-2 hash, as
          // finsoft_app, through the real writer. Its FOR SHARE read must
          // block on T_B's uncommitted row lock.
          let aSettled: 'pending' | 'resolved' | 'rejected' = 'pending'
          let earlyRejectionReason: unknown
          const insertPromise = runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
            withTenant((tx) =>
              recordAudit(tx, {
                actorUserId: tenant.ownerId,
                action: 'SEED_THREE',
                entityType: 'probe',
                entityId: null,
                beforeJson: null,
                afterJson: null,
                ip: null,
                requestId: null,
              }),
            ),
          )
          insertPromise.then(
            () => {
              aSettled = 'resolved'
            },
            (reason: unknown) => {
              aSettled = 'rejected'
              earlyRejectionReason = reason
            },
          )

          // T_A must still be blocked while T_B's transaction is open.
          await sleep(500)
          // Read through a function: TS's control-flow narrowing does not
          // (and cannot) account for `aSettled` having been reassigned by an
          // async callback during the `await` above, so it otherwise infers
          // the literal type 'pending' all the way down and flags the
          // comparisons below as unreachable — which they are not.
          const settledNow = aSettled as 'pending' | 'resolved' | 'rejected'
          if (settledNow === 'resolved') {
            expect.fail(
              'T_A RESOLVED before T_B committed — FOR SHARE is not serialising it, and an unlocked ' +
                'read would let this interleaving commit a false gap (ADR-0020 §5).',
            )
          } else if (settledNow === 'rejected') {
            // A rejection this early is NOT itself evidence that FOR SHARE is
            // working — it could equally be an unrelated bug (a connection
            // error, a different constraint firing before the lock wait even
            // begins). Fail loudly with the actual reason rather than let a
            // misattributed pass through as "FOR SHARE serialised it".
            expect.fail(
              `T_A REJECTED before T_B committed, for a reason that needs its own diagnosis rather ` +
                `than being read as "FOR SHARE worked": ${String(earlyRejectionReason)}`,
            )
          }

          await tB.query('COMMIT')

          // Once T_B's renumber is visible, T_A's re-evaluated FOR SHARE read
          // no longer finds a row at seq=2 (it is now at seq=99), so it must
          // reject.
          await expect(insertPromise).rejects.toThrow(
            /previous_hash does not match the hash at seq 2/,
          )
        } finally {
          await tB.query('ROLLBACK').catch(() => undefined)
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update')
        }
      })
    } finally {
      await tB.end()
      await admin.end()
      await closeDatabase()
      process.env['DATABASE_POOL_MAX'] = '1'
      await openDatabase(TEST_TARGET)
    }
  }, 20_000)
})

describe('the orphan forgery under a disabled linkage trigger — the FK is what still catches it', () => {
  it('rejects an orphan via audit_log_prev_fkey once audit_log_link is disabled', async () => {
    const tenant = await createTenantFixture('CCO')
    const admin = migrationClient()
    await admin.connect()

    try {
      await withTriggersLocked(admin, async () => {
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_link')
        try {
          await expect(
            admin.query(
              `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type, hash_version, hash, previous_hash)
               VALUES ($1, 500, now(), 'ORPHAN_TRIGGER_DISABLED', 'probe', 'v1', $2, $3)`,
              [tenant.tenantId, 'a'.repeat(64), 'b'.repeat(64)],
            ),
          ).rejects.toMatchObject({ constraint: 'audit_log_prev_fkey' })
        } finally {
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_link')
        }
      })
    } finally {
      await admin.end()
    }
  })
})

describe('omitting the advisory lock — the unique constraint is not redundant', () => {
  /*
   * "A variant that deliberately omits the advisory lock and asserts the
   * unique constraint fires" — ADR-0020 Compliance. Two connections read
   * MAX(seq) and insert without ever taking pg_advisory_xact_lock, which is
   * exactly what recordAudit does NOT do. This proves the constraint is real
   * backup, not decoration the lock happens to make redundant.
   */
  it('lets two unlocked appenders race to the same seq, and the UNIQUE constraint catches the loser', async () => {
    const tenant = await createTenantFixture('CCL')

    const clientA = migrationClient()
    const clientB = migrationClient()
    await clientA.connect()
    await clientB.connect()

    try {
      for (const c of [clientA, clientB]) {
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant.tenantId])
      }

      const headOf = async (c: Client) => {
        // `seq` unaliased and uncast: int8 already arrives as a string, and
        // casting it renames the output column, which makes ORDER BY sort
        // alphabetically instead of numerically (writer.ts's own fixed bug).
        const { rows } = await c.query<{ seq: string; hash: string }>(
          'SELECT seq, hash FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1',
          [tenant.tenantId],
        )
        return rows[0]!
      }

      const [headA, headB] = await Promise.all([headOf(clientA), headOf(clientB)])
      expect(headA.seq).toBe('0')
      expect(headB.seq).toBe('0')

      const insert = (c: Client, tag: string) =>
        c.query(
          `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type, hash_version, hash, previous_hash)
           VALUES ($1, 1, now(), $2, 'probe', 'v1', $3, $4)`,
          [tenant.tenantId, tag, 'f'.repeat(64), headA.hash],
        )

      const results = await Promise.allSettled([
        insert(clientA, 'RACE_A'),
        insert(clientB, 'RACE_B'),
      ])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        constraint: 'audit_log_tenant_seq_key',
      })
    } finally {
      await clientA.end()
      await clientB.end()
    }
  })
})

describe('multi-row single-statement inserts are order-dependent — both directions tested', () => {
  /*
   * recordAudit itself never issues a multi-row INSERT, which is this
   * writer's answer to ADR-0020's "forbid multi-row audit inserts, or pin
   * seq order and test both directions". This section is the second half
   * anyway: it documents, with a red and a green case, exactly why a
   * multi-row insert would be dangerous if anyone added one later.
   */
  it('accepts a two-row VALUES list in ascending seq order (statement order happens to match trigger visibility)', async () => {
    const tenant = await createTenantFixture('CCM')
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        recordAudit(tx, {
          actorUserId: tenant.ownerId,
          action: 'SEED',
          entityType: 'probe',
          entityId: null,
          beforeJson: null,
          afterJson: null,
          ip: null,
          requestId: null,
        }),
      ),
    )

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        const rows = await rawOn<{ hash: string; seq: string }>(
          tx,
          'SELECT hash, seq::text FROM audit_log WHERE tenant_id = $1 AND seq = 1',
          [tenant.tenantId],
        )
        const seed = rows[0]!
        await rawOn(
          tx,
          `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type, hash_version, hash, previous_hash)
           VALUES
             ($1, 2, now(), 'MULTI_FORWARD_A', 'probe', 'v1', $2, $3),
             ($1, 3, now(), 'MULTI_FORWARD_B', 'probe', 'v1', $4, $2)`,
          [tenant.tenantId, '3'.repeat(64), seed.hash, '4'.repeat(64)],
        )
      }),
    )

    const count = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        scalarOn<string>(tx, 'SELECT count(*)::text FROM audit_log WHERE tenant_id = $1', [
          tenant.tenantId,
        ]),
      ),
    )
    expect(count).toBe('4') // anchor + seed + the two multi-row inserts
  })

  it('rejects the SAME two rows in descending seq order — the direction the naive form gets wrong', async () => {
    const tenant = await createTenantFixture('CCN')
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        recordAudit(tx, {
          actorUserId: tenant.ownerId,
          action: 'SEED',
          entityType: 'probe',
          entityId: null,
          beforeJson: null,
          afterJson: null,
          ip: null,
          requestId: null,
        }),
      ),
    )

    await expect(
      runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
        withTenant(async (tx) => {
          const rows = await rawOn<{ hash: string }>(
            tx,
            'SELECT hash FROM audit_log WHERE tenant_id = $1 AND seq = 1',
            [tenant.tenantId],
          )
          const seed = rows[0]!
          // seq 3 BEFORE seq 2 in the VALUES list: when the trigger evaluates
          // the seq-3 row first, seq 2 does not exist yet in any snapshot the
          // FOR EACH ROW trigger can see.
          await rawOn(
            tx,
            `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type, hash_version, hash, previous_hash)
             VALUES
               ($1, 3, now(), 'MULTI_REVERSE_B', 'probe', 'v1', $2, $3),
               ($1, 2, now(), 'MULTI_REVERSE_A', 'probe', 'v1', $3, $4)`,
            [tenant.tenantId, '5'.repeat(64), '6'.repeat(64), seed.hash],
          )
        }),
      ),
    ).rejects.toThrow(/previous_hash does not match the hash at seq/)
  })
})

describe('a concurrent append fork test, AS finsoft_app, UNDER RLS', () => {
  /*
   * Not as the migration role: a fork test running with BYPASSRLS is not
   * testing the table the application writes to (ADR-0020 Compliance). Two
   * REAL recordAudit calls for the SAME tenant, on separate pooled
   * connections, racing for the advisory lock — the pool is reopened wider
   * for exactly this reason (mirroring tests/security/tenant-isolation-
   * multiconnection.spec.ts).
   */
  it('serialises two concurrent recordAudit calls into one unforked chain', async () => {
    const tenant = await createTenantFixture('CCP')

    await closeDatabase()
    process.env['DATABASE_POOL_MAX'] = '6'
    await openDatabase(TEST_TARGET)

    try {
      const appendOnce = (action: string) =>
        runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
          withTenant((tx) =>
            recordAudit(tx, {
              actorUserId: tenant.ownerId,
              action,
              entityType: 'probe',
              entityId: null,
              beforeJson: null,
              afterJson: null,
              ip: null,
              requestId: null,
            }),
          ),
        )

      const [r1, r2, r3, r4] = await Promise.all([
        appendOnce('CONCURRENT_A'),
        appendOnce('CONCURRENT_B'),
        appendOnce('CONCURRENT_C'),
        appendOnce('CONCURRENT_D'),
      ])

      const seqs = [r1, r2, r3, r4].map((r) => Number(r.seq)).sort((a, b) => a - b)
      expect(seqs).toEqual([1, 2, 3, 4])

      // No fork: exactly one row exists per seq, and walking hash ->
      // previous_hash from the highest seq down reaches every row exactly
      // once and terminates at the genesis constant.
      const byHash = new Map([r1, r2, r3, r4].map((r) => [r.hash, r]))
      let cursor = [r1, r2, r3, r4].find((r) => Number(r.seq) === 4)!
      let walked = 0
      while (cursor) {
        walked += 1
        const parentHash = cursor.previousHash
        if (parentHash === '0'.repeat(64)) break
        const parent = byHash.get(parentHash)
        expect(
          parent,
          `no row found with hash ${parentHash} — the chain forked or gapped`,
        ).toBeDefined()
        cursor = parent!
      }
      expect(walked).toBe(4)
    } finally {
      await closeDatabase()
      process.env['DATABASE_POOL_MAX'] = '1'
      await openDatabase(TEST_TARGET)
    }
  }, 30_000)
})
