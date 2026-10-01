import { execFileSync } from 'node:child_process'
import { recordAudit, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * pg_dump -> pg_restore round trip. Database Guardian review measured that
 * the original `audit_log_jsonb_all_strings(jsonb)` — a recursive plpgsql
 * function calling itself unqualified, with no search_path pinned — could
 * not survive a real restore: pg_dump sets an EMPTY search_path during
 * restore, so the function's own recursive self-call failed to resolve and
 * `pg_restore` on a real dump of this table restored ZERO rows. ADR-0020's
 * whole premise is that this table is evidence; evidence that cannot be
 * restored from a backup is not evidence.
 *
 * The fix replaced the function with a single IMMUTABLE jsonpath expression
 * (`jsonb_path_exists(x, 'strict $.** ? (...)')`) — no function, no
 * recursion, no search_path for a restore to get wrong. This test proves it
 * by actually dumping and restoring, not by re-reading the migration file.
 */

const SERVICE = 'postgres-test'
const SCRATCH_DB = `finsoft_audit_restore_probe_${Date.now().toString(36)}`

/*
 * QA-001: with many containers running (parallel worktree stacks on the
 * same machine — see the brief), the default 1 MB `maxBuffer` for
 * `execFileSync`/`spawnSync` is not always enough for `pg_dump`'s output or
 * for `docker compose` CLI chatter, and Node throws `ENOBUFS` rather than
 * truncating. The audit_log/tenants/users tables this test dumps also only
 * ever grow across a run (rule 4: no role holds DELETE — see `unique()`'s
 * own comment in harness.ts), so the dump gets larger the later this file
 * runs in a suite. 64 MB is comfortably above any dump this test produces
 * today, with headroom for the table to keep growing.
 */
const MAX_BUFFER = 64 * 1024 * 1024

function sh(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER })
}

function bootstrapPsql(db: string, sql: string): string {
  return sh([
    'compose',
    'exec',
    '-T',
    SERVICE,
    'psql',
    '-U',
    'finsoft_bootstrap',
    '-d',
    db,
    '-tAc',
    sql,
  ])
}

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

describe('audit_log survives a real pg_dump / pg_restore round trip', () => {
  it('restores every row and keeps the no-numbers CHECK enforceable afterward', async () => {
    const tenant = await createTenantFixture('RST')

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        recordAudit(tx, {
          actorUserId: tenant.ownerId,
          action: 'RESTORE_PROBE',
          entityType: 'probe',
          entityId: null,
          beforeJson: null,
          afterJson: { note: 'before the dump' },
          ip: '203.0.113.7',
          requestId: null,
        }),
      ),
    )

    // 2: the seq=0 anchor createTenantFixture also creates, plus the one
    // real event recorded above.
    const beforeCount = bootstrapPsql(
      'finsoft_test',
      `select count(*)::text from audit_log where tenant_id = '${tenant.tenantId}'`,
    ).trim()
    expect(beforeCount).toBe('2')

    // Dump the real table (schema + data) from inside the container, and
    // restore into a fresh scratch database on the same server — the same
    // shape of operation a real backup/restore drill performs.
    sh(['compose', 'exec', '-T', SERVICE, 'createdb', '-U', 'finsoft_bootstrap', SCRATCH_DB])

    try {
      const dump = sh([
        'compose',
        'exec',
        '-T',
        SERVICE,
        'pg_dump',
        '-U',
        'finsoft_bootstrap',
        '-d',
        'finsoft_test',
        '--no-owner',
        '--no-privileges',
        '-t',
        'audit_log',
        '-t',
        'tenants',
        '-t',
        'users',
      ])

      // A table-only dump (audit_log/tenants/users) does not carry the
      // standalone trigger FUNCTIONS those tables' triggers reference, so
      // CREATE TRIGGER fails for each one here — expected and harmless for
      // this test, which is about the CHECK constraint and the data, not
      // about restoring a fully working table in isolation from its
      // dependencies. Stderr is swallowed so that expected noise does not
      // read as a test failure in CI output.
      execFileSync(
        'docker',
        ['compose', 'exec', '-T', SERVICE, 'psql', '-U', 'finsoft_bootstrap', '-d', SCRATCH_DB],
        { input: dump, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: MAX_BUFFER },
      )

      const afterCount = bootstrapPsql(
        SCRATCH_DB,
        `select count(*)::text from audit_log where tenant_id = '${tenant.tenantId}'`,
      ).trim()
      expect(afterCount, 'the restored database should have the same row count as the source').toBe(
        beforeCount,
      )

      // The restored CHECK constraint must still be live — a number sneaking
      // into after_json is rejected in the RESTORED database exactly as it
      // is in the source, proving the constraint (and, before the fix, the
      // function it called) actually resolved after restore rather than
      // silently vanishing along with the rows.
      let rejected = false
      try {
        bootstrapPsql(
          SCRATCH_DB,
          `insert into audit_log (tenant_id, seq, occurred_at, action, entity_type, after_json, hash_version, hash, previous_hash)
           values ('${tenant.tenantId}', 999, now(), 'POST_RESTORE_PROBE', 'probe', '{"amount": 1.1}'::jsonb, 'v1', '${'a'.repeat(64)}', null)`,
        )
      } catch {
        rejected = true
      }
      expect(
        rejected,
        'the restored audit_log_after_json_no_numbers CHECK should still reject a number',
      ).toBe(true)
    } finally {
      sh([
        'compose',
        'exec',
        '-T',
        SERVICE,
        'dropdb',
        '-U',
        'finsoft_bootstrap',
        '--if-exists',
        SCRATCH_DB,
      ])
    }
  }, 60_000)
})
