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
})
