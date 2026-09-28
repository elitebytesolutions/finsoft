import { Client } from 'pg'
import { recordAudit, verifyAuditChain, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTriggersLocked } from './trigger-mutation-lock.ts'

/*
 * verifyAuditChain, against a real database. ADR-0020 §6,
 * WAVE_1_REGISTER.md W1-005: "the deliverable is the verifier, not the
 * table."
 */

function migrationClient(): Client {
  const url = process.env['TEST_MIGRATION_DATABASE_URL']
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
  return new Client({ connectionString: url })
}

let lockClient: Client

beforeAll(async () => {
  await prepareTestDatabase()
  lockClient = migrationClient()
  await lockClient.connect()
}, 60_000)

afterAll(async () => {
  await lockClient.end()
  await teardownTestDatabase()
})

/**
 * verifyAuditChain's own structural check (packages/database/src/audit/verify.ts)
 * reports ANY disabled trigger on audit_log, cluster-wide, at the instant it
 * queries pg_trigger — it has no way to know that a DIFFERENT test file's
 * disable window is test-only and about to close. Held under the same
 * test-only advisory lock every trigger-mutating test in this directory
 * holds (trigger-mutation-lock.ts), so a verification that is not itself
 * mutating anything still waits for any in-flight disable window to clear
 * rather than racing it. Not needed inside the tamper-detection tests below
 * — those call verifyAuditChain only AFTER their own disable/enable window
 * has already closed.
 */
function verifyLocked(tenantId?: string) {
  return withTriggersLocked(lockClient, () => verifyAuditChain(tenantId, 'TEST_DATABASE_URL'))
}

async function appendN(tenant: TenantFixture, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    // Sequential, not Promise.all: each append must chain onto the previous one's head.
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        recordAudit(tx, {
          actorUserId: tenant.ownerId,
          action: `SEQUENCE_STEP_${i}`,
          entityType: 'probe',
          entityId: null,
          beforeJson: null,
          afterJson: { step: String(i) },
          ip: null,
          requestId: null,
        }),
      ),
    )
  }
}

describe('a long, intact chain', () => {
  it('verifies clean past 10 appends — the regression case for the seq TEXT-sort defect', async () => {
    /*
     * Database Guardian review measured that selecting `seq::text AS seq`
     * (or even unaliased `seq::text`, which keeps the source name) makes
     * `ORDER BY seq` sort ALPHABETICALLY: the 11th append for a tenant read
     * seq 10 as the head (alphabetically last-but-one among '1'..'10') and
     * failed audit_log_tenant_seq_key trying to write seq 2 again. 25 is
     * comfortably past the '9' -> '10' boundary where the defect first
     * bites, and past '19' -> '20' too.
     */
    const tenant = await createTenantFixture('VER')
    await appendN(tenant, 25)

    const result = await verifyLocked(tenant.tenantId)
    expect(result.ok, JSON.stringify(result.firstBreak)).toBe(true)
    expect(result.rowsChecked).toBe(25)
  }, 30_000)

  it('reports ok with zero rows checked for a tenant with only the anchor', async () => {
    const tenant = await createTenantFixture('VEZ')
    const result = await verifyLocked(tenant.tenantId)
    expect(result.ok).toBe(true)
    expect(result.rowsChecked).toBe(0)
  })

  it('omitting tenantId walks tenants from the global registry rather than throwing', async () => {
    // Not asserting result.ok or an exact tenantsChecked count here: this
    // test database ACCUMULATES tenants across every run of this file (rule
    // 4 — nothing is ever deleted, and re-running this suite without
    // `npm run db:reset` finds tenants earlier runs deliberately tampered).
    // verifyAuditChain(undefined, …) reports the FIRST break across the
    // whole cluster and stops there by design (§6: "reports the first
    // break… not a boolean"), so a prior run's tampered tenant can
    // legitimately make this ok:false with tenantsChecked as low as 1. What
    // this test owns is narrower and still real: the no-argument form
    // enumerates the global `tenants` table and processes at least one of
    // them without throwing, and each INDIVIDUALLY-scoped tenant below is
    // independently proven clean.
    const a = await createTenantFixture('VEA')
    const b = await createTenantFixture('VEB')
    await appendN(a, 3)
    await appendN(b, 5)

    expect((await verifyLocked(a.tenantId)).ok).toBe(true)
    expect((await verifyLocked(b.tenantId)).ok).toBe(true)

    const result = await verifyLocked(undefined)
    expect(result.tenantsChecked).toBeGreaterThanOrEqual(1)
  })
})

describe('tamper detection — each forgery is planted as the migration role, bypassing the application entirely', () => {
  /*
   * These simulate exactly what ADR-0020 §6 exists to catch: a row altered
   * (or deleted-and-reinserted, or reordered) by someone with direct
   * database access — rule 21's premise — after the fact. The append-only
   * trigger has to be disabled to even attempt it, which is itself the
   * adversarial regime this control is measured against (see
   * audit-log-concurrency.spec.ts).
   */

  it('detects an altered field: "1.1000" tampered to "1.1" in after_json', async () => {
    const tenant = await createTenantFixture('VTA')
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        recordAudit(tx, {
          actorUserId: tenant.ownerId,
          action: 'PRICE_OVERRIDDEN',
          entityType: 'price',
          entityId: null,
          beforeJson: { amount: '1.1000' },
          afterJson: { amount: '1.1100' },
          ip: null,
          requestId: null,
        }),
      ),
    )

    const admin = migrationClient()
    await admin.connect()
    try {
      await withTriggersLocked(admin, async () => {
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update')
        try {
          await admin.query(
            `UPDATE audit_log SET before_json = '{"amount":"1.1"}'::jsonb
              WHERE tenant_id = $1 AND seq = 1`,
            [tenant.tenantId],
          )
        } finally {
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update')
        }
      })
    } finally {
      await admin.end()
    }

    const result = await verifyLocked(tenant.tenantId)
    expect(result.ok).toBe(false)
    expect(result.firstBreak?.seq).toBe('1')
    expect(result.firstBreak?.reason).toMatch(/does not match the stored hash/)
  })

  it('detects a missing/renumbered row: a seq gap with nothing deleted', async () => {
    const tenant = await createTenantFixture('VTG')
    await appendN(tenant, 3)

    const admin = migrationClient()
    await admin.connect()
    try {
      await withTriggersLocked(admin, async () => {
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update')
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_link')
        try {
          // Exactly the shape ADR-0020 §6 describes: a seq rewrite, not a
          // deletion — "0, 1, 3, 99" with nothing deleted.
          await admin.query('UPDATE audit_log SET seq = 99 WHERE tenant_id = $1 AND seq = 2', [
            tenant.tenantId,
          ])
        } finally {
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_link')
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update')
        }
      })
    } finally {
      await admin.end()
    }

    const result = await verifyLocked(tenant.tenantId)
    expect(result.ok).toBe(false)
    expect(result.firstBreak?.seq).toBe('2')
    // Walking in ASC order, the next row physically present after seq 1 is
    // now seq 3 (the renumbered row sits at 99, further along) — the
    // verifier correctly names the row it actually found, not the one the
    // forger moved the original to.
    expect(result.firstBreak?.reason).toMatch(/expected seq 2, found 3/)
  })

  it('detects a reordered pair', async () => {
    const tenant = await createTenantFixture('VTR')
    await appendN(tenant, 3)

    const admin = migrationClient()
    await admin.connect()
    try {
      await withTriggersLocked(admin, async () => {
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update')
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_link')
        try {
          // Swap seq 2 and seq 3 directly (two-step, through a scratch
          // value, to dodge the UNIQUE constraint mid-swap).
          await admin.query('UPDATE audit_log SET seq = 999 WHERE tenant_id = $1 AND seq = 2', [
            tenant.tenantId,
          ])
          await admin.query('UPDATE audit_log SET seq = 2 WHERE tenant_id = $1 AND seq = 3', [
            tenant.tenantId,
          ])
          await admin.query('UPDATE audit_log SET seq = 3 WHERE tenant_id = $1 AND seq = 999', [
            tenant.tenantId,
          ])
        } finally {
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_link')
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update')
        }
      })
    } finally {
      await admin.end()
    }

    const result = await verifyLocked(tenant.tenantId)
    expect(result.ok).toBe(false)
    // The row now at seq 2 is the old seq-3 row; its previous_hash names the
    // old seq-2 row's hash, which no longer sits immediately before it.
    expect(result.firstBreak?.seq).toBe('2')
  })

  it('detects an appended forgery: a plausible-looking extra row with a fabricated hash', async () => {
    const tenant = await createTenantFixture('VTF')
    const last = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
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

    const admin = migrationClient()
    await admin.connect()
    try {
      await admin.query(
        `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type, hash_version, hash, previous_hash)
         VALUES ($1, 2, now(), 'FORGED_APPEND', 'probe', 'v1', $2, $3)`,
        [tenant.tenantId, 'f'.repeat(64), last.hash],
      )
    } finally {
      await admin.end()
    }

    const result = await verifyLocked(tenant.tenantId)
    expect(result.ok).toBe(false)
    expect(result.firstBreak?.seq).toBe('2')
    expect(result.firstBreak?.reason).toMatch(/does not match the stored hash/)
  })
})

describe('structural controls — the production-reachable counterpart to the CI-only tgenabled check', () => {
  it('fails closed if a trigger is left disabled', async () => {
    const admin = migrationClient()
    await admin.connect()
    try {
      await withTriggersLocked(admin, async () => {
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_link')
        try {
          const result = await verifyAuditChain(undefined, 'TEST_DATABASE_URL')
          expect(result.ok).toBe(false)
          expect(result.firstBreak?.reason).toMatch(/audit_log_link.*DISABLED/)
        } finally {
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_link')
        }
      })
    } finally {
      await admin.end()
    }
  })

  it('fails closed and names the trigger if one is DROPPED entirely, not merely disabled', async () => {
    // R2: a query that only inspects rows already present in pg_trigger
    // cannot see a DROPPED trigger — it would report zero issues over an
    // empty result set. The structural check compares against the closed,
    // named REQUIRED_TRIGGERS list for exactly this reason.
    const admin = migrationClient()
    await admin.connect()
    try {
      await withTriggersLocked(admin, async () => {
        await admin.query('DROP TRIGGER audit_log_no_truncate ON audit_log')
        try {
          const result = await verifyAuditChain(undefined, 'TEST_DATABASE_URL')
          expect(result.ok).toBe(false)
          expect(result.firstBreak?.reason).toMatch(/audit_log_no_truncate.*DROPPED/)
        } finally {
          await admin.query(`
            CREATE TRIGGER audit_log_no_truncate
              BEFORE TRUNCATE ON audit_log
              FOR EACH STATEMENT EXECUTE FUNCTION audit_log_forbid_mutation()
          `)
        }
      })
    } finally {
      await admin.end()
    }
  })

  it('fails closed and names the constraint if one is DROPPED', async () => {
    const admin = migrationClient()
    await admin.connect()
    try {
      await withTriggersLocked(admin, async () => {
        await admin.query('ALTER TABLE audit_log DROP CONSTRAINT audit_log_not_self')
        try {
          const result = await verifyAuditChain(undefined, 'TEST_DATABASE_URL')
          expect(result.ok).toBe(false)
          expect(result.firstBreak?.reason).toMatch(/audit_log_not_self.*DROPPED/)
        } finally {
          await admin.query(`
            ALTER TABLE audit_log
              ADD CONSTRAINT audit_log_not_self CHECK (previous_hash IS NULL OR previous_hash <> hash)
          `)
        }
      })
    } finally {
      await admin.end()
    }
  })

  it('checks every tenant and reports every break, not only the first (S3)', async () => {
    const admin = migrationClient()
    await admin.connect()
    try {
      // 3 events each, not 2: audit_log_genesis_ties pins seq=1's
      // previous_hash to the genesis constant, so the row renumbered away
      // must be seq 2 (as in audit-log-concurrency.spec.ts's own FOR SHARE
      // test), not seq 1.
      const a = await createTenantFixture('SBA')
      const b = await createTenantFixture('SBB')
      await appendN(a, 3)
      await appendN(b, 3)

      await withTriggersLocked(admin, async () => {
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update')
        try {
          await admin.query('UPDATE audit_log SET seq = 99 WHERE tenant_id = $1 AND seq = 2', [
            a.tenantId,
          ])
          await admin.query('UPDATE audit_log SET seq = 99 WHERE tenant_id = $1 AND seq = 2', [
            b.tenantId,
          ])
        } finally {
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update')
        }
      })

      const resultA = await verifyLocked(a.tenantId)
      const resultB = await verifyLocked(b.tenantId)
      expect(resultA.ok).toBe(false)
      expect(resultB.ok).toBe(false)

      // The whole-cluster call must not stop at the first broken tenant: both
      // a and b must appear among the reported breaks.
      const wholeCluster = await verifyLocked(undefined)
      const brokenTenantIds = new Set(wholeCluster.breaks.map((brk) => brk.tenantId))
      expect(brokenTenantIds.has(a.tenantId), 'tenant a should be among the reported breaks').toBe(
        true,
      )
      expect(brokenTenantIds.has(b.tenantId), 'tenant b should be among the reported breaks').toBe(
        true,
      )
    } finally {
      await admin.end()
    }
  })
})

describe('S1: adversarial cases the verifier must and must not claim to catch', () => {
  it('fails rather than reporting OK for a tenant id that does not exist', async () => {
    const result = await verifyLocked('00000000-0000-4000-8000-000000000000')
    expect(result.ok).toBe(false)
    expect(result.firstBreak?.reason).toMatch(/does not exist/)
  })

  it('fails rather than reporting OK for a tenant with no seq=0 anchor', async () => {
    // A tenant created WITHOUT going through createAuditChainAnchor — exactly
    // the state a future, buggy provisioning path could leave behind.
    const admin = migrationClient()
    await admin.connect()
    try {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO tenants (code, name) VALUES ($1, $2) RETURNING id`,
        [`TNOANCHOR${Date.now().toString(36)}`.slice(0, 16).toUpperCase(), 'No anchor'],
      )
      const tenantId = rows[0]!.id

      const result = await verifyLocked(tenantId)
      expect(result.ok).toBe(false)
      expect(result.firstBreak?.reason).toMatch(/no seq=0 anchor/)
    } finally {
      await admin.end()
    }
  })

  it('detects a cross-tenant splice (a forged row naming a hash from the wrong tenant)', async () => {
    const victim = await createTenantFixture('SPV')
    const attacker = await createTenantFixture('SPA')
    const victimHead = await runAs({ tenantId: victim.tenantId, userId: victim.ownerId }, () =>
      withTenant((tx) =>
        recordAudit(tx, {
          actorUserId: victim.ownerId,
          action: 'VICTIM_EVENT',
          entityType: 'probe',
          entityId: null,
          beforeJson: null,
          afterJson: null,
          ip: null,
          requestId: null,
        }),
      ),
    )
    // The attacker's tenant needs its OWN real seq=1 first — audit_log_
    // genesis_ties pins seq=1's previous_hash to the genesis constant
    // unconditionally, so a splice attempt at seq=1 would be rejected by
    // that CHECK regardless of whose hash it named, proving nothing about
    // cross-tenant detection specifically.
    await appendN(attacker, 1)

    const admin = migrationClient()
    await admin.connect()
    try {
      // Attempt to splice a row into the ATTACKER's tenant at seq=2, naming
      // the VICTIM's hash as its previous_hash — audit_log_link (seq > 1)
      // checks THIS tenant's own seq=1 row for a matching hash FOR SHARE,
      // and the attacker's real seq=1 row does not have the victim's hash,
      // so the linkage trigger rejects it before the FK is even reached
      // (the same "trigger enabled" precedence as the orphan/bad-adjacency
      // cases in audit-log.spec.ts). audit_log_prev_fkey is the backup that
      // still catches this if the trigger is ever disabled — see "the
      // orphan forgery under a disabled linkage trigger" in
      // audit-log-concurrency.spec.ts.
      await expect(
        admin.query(
          `INSERT INTO audit_log (tenant_id, seq, occurred_at, action, entity_type, hash_version, hash, previous_hash)
           VALUES ($1, 2, now(), 'SPLICE_ATTEMPT', 'probe', 'v1', $2, $3)`,
          [attacker.tenantId, 'a'.repeat(64), victimHead.hash],
        ),
      ).rejects.toThrow(/previous_hash does not match the hash at seq 1/)
    } finally {
      await admin.end()
    }
  })

  it('DOCUMENTED LIMITATION: a TAIL deletion (the most recent row, deleted, with nothing appended after) is NOT detected', async () => {
    // Stated plainly because it is a real limitation, not an oversight: the
    // verifier walks seq 1..N and stops the moment it runs out of rows. If
    // the CURRENT tail (the highest seq) is deleted and nothing is appended
    // afterward, there is no gap for the verifier to find — "the chain ends
    // at seq 2" is indistinguishable from "seq 3 existed and was deleted".
    // A gap is only detectable when something ELSE still points past it (a
    // later row's previous_hash, or an out-of-band expected-seq record this
    // verifier does not keep). This is why rule 4's grants (no DELETE at
    // all, for any role, ever) are the REAL control here — the trigger and
    // grants prevent this from being reachable at all in the running
    // system. This test exercises it anyway, as the owning role would have
    // to (bypassing the trigger, which only a superuser-equivalent
    // connection can do), to prove the verifier's boundary honestly rather
    // than assert a guarantee it cannot give.
    const tenant = await createTenantFixture('TAILDEL')
    await appendN(tenant, 3)

    const okBefore = await verifyLocked(tenant.tenantId)
    expect(okBefore.ok).toBe(true)
    expect(okBefore.rowsChecked).toBe(3)

    const admin = migrationClient()
    await admin.connect()
    try {
      await withTriggersLocked(admin, async () => {
        await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete')
        try {
          const deleted = await admin.query(
            'DELETE FROM audit_log WHERE tenant_id = $1 AND seq = 3',
            [tenant.tenantId],
          )
          expect(deleted.rowCount, 'the tail row must actually have been deleted').toBe(1)
        } finally {
          await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete')
        }
      })

      // The documented limitation, demonstrated rather than merely claimed:
      // the verifier reports OK, having checked only the 2 rows that remain.
      const afterTailDeletion = await verifyLocked(tenant.tenantId)
      expect(
        afterTailDeletion.ok,
        'this assertion documents the limitation — it is EXPECTED to be true',
      ).toBe(true)
      expect(afterTailDeletion.rowsChecked).toBe(2)
    } finally {
      await admin.end()
    }
  })
})
