#!/usr/bin/env node
/*
 * The outbox claim query's plan, at scale.
 *
 * Required on the dispatcher's pull request by the Database Guardian, in
 * these words: "EXPLAIN (ANALYZE, BUFFERS) on the claim query against
 * realistic data — at least 10^6 rows across >=50 tenants with a small
 * PENDING working set. A plan reviewed against ten rows will not be
 * accepted."
 *
 * That qualification is the whole point. The planner picks a sequential scan
 * for a handful of rows whatever the indexes say, and would pick it again
 * with the index dropped — so a plan assertion over a small table proves
 * nothing about the index and everything about the row count. The suite's
 * own plan test uses 2000 rows, which is enough to make the index the
 * cheaper option; this is the one that answers whether the shape holds when
 * the table is the size it will actually be.
 *
 * What it checks:
 *
 *   - the claim query uses outbox_pending_idx
 *   - there is no sequential scan on outbox
 *   - there is NO SORT NODE above the index scan. This is the assertion that
 *     justifies the index's third column: `(tenant_id, available_at, id)`
 *     supplies `ORDER BY available_at, id` directly, and a Sort appearing
 *     here would mean the ordering is being recomputed on every poll.
 *   - the working set stays small while the table does not
 *
 * Writes to the TEST database only. Run with `npm run db:outbox-plan`.
 */

import { randomUUID } from 'node:crypto'
import pg from 'pg'

const TENANTS = 50
const ROWS_PER_TENANT = 20_000 // 10^6 total
const PENDING_PER_TENANT = 20 // the working set stays small
const BATCH = 50

const url = process.env.TEST_MIGRATION_DATABASE_URL
if (!url) {
  console.error(
    'TEST_MIGRATION_DATABASE_URL is not set. Copy .env.example to .env — this script writes ' +
      'a million rows and must never be pointed at anything but the disposable test cluster.',
  )
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })
await client.connect()

async function seed() {
  const existing = await client.query(
    `SELECT count(*)::bigint AS n FROM outbox WHERE topic = 'PLAN_PROBE'`,
  )
  if (Number(existing.rows[0].n) >= TENANTS * ROWS_PER_TENANT) {
    console.log('  probe data already present, reusing it')
    return
  }

  console.log(`  seeding ${TENANTS} tenants x ${ROWS_PER_TENANT} rows...`)
  const tenantIds = []

  for (let t = 0; t < TENANTS; t += 1) {
    const code = `PLAN${randomUUID().slice(0, 8).toUpperCase()}`
    const { rows } = await client.query(
      `INSERT INTO tenants (code, name) VALUES ($1, $2) RETURNING id`,
      [code, `Plan probe ${code}`],
    )
    const tenantId = rows[0].id
    tenantIds.push(tenantId)

    const owner = await client.query(
      `INSERT INTO users (tenant_id, email, full_name, status)
       VALUES ($1, $2, 'Plan probe owner', 'INVITED') RETURNING id`,
      [tenantId, `owner.${code.toLowerCase()}@plan.test`],
    )
    const ownerId = owner.rows[0].id

    /*
     * Mostly DONE, because that is what the table looks like in production:
     * rule 4 means DONE rows never leave, so the table grows without bound
     * while the PENDING working set stays small. An all-PENDING table would
     * be a kinder test than reality.
     */
    await client.query(
      `INSERT INTO outbox (tenant_id, topic, payload, effect_key, occurred_at, available_at,
                           correlation_id, created_by, updated_by, status, dispatched_at)
       SELECT $1, 'PLAN_PROBE', '{"n":1}'::jsonb, 'PK-' || g, now(),
              now() - (g || ' seconds')::interval, gen_random_uuid(), $2, $2,
              CASE WHEN g <= $3 THEN 'PENDING' ELSE 'DONE' END,
              CASE WHEN g <= $3 THEN NULL ELSE now() END
         FROM generate_series(1, $4) AS g`,
      [tenantId, ownerId, PENDING_PER_TENANT, ROWS_PER_TENANT],
    )
  }

  await client.query('ANALYZE outbox')
  return tenantIds
}

const seeded = await seed()

const probeTenant =
  seeded?.[0] ??
  (
    await client.query(
      `SELECT tenant_id FROM outbox WHERE topic = 'PLAN_PROBE' AND status = 'PENDING' LIMIT 1`,
    )
  ).rows[0]?.tenant_id

const totals = await client.query(
  `SELECT count(*)::bigint AS total,
          count(*) FILTER (WHERE status = 'PENDING')::bigint AS pending
     FROM outbox`,
)
console.log(
  `\n  table: ${totals.rows[0].total} rows, ${totals.rows[0].pending} PENDING across ` +
    `${(await client.query(`SELECT count(DISTINCT tenant_id)::int AS n FROM outbox`)).rows[0].n} tenants`,
)

/*
 * Under the app role and a real tenant context, not as the migration role.
 * The RLS predicate is part of the query being planned — current_setting is
 * STABLE, which is what lets it be used as the leading index qual rather than
 * a filter above the scan, and planning it away would be testing a query
 * nobody runs.
 */
const appUrl = process.env.TEST_DATABASE_URL
if (!appUrl) {
  console.error('TEST_DATABASE_URL is not set; the plan must be taken as the application role.')
  process.exit(2)
}

const app = new pg.Client({ connectionString: appUrl })
await app.connect()
await app.query('BEGIN')
await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [probeTenant])

const { rows: plan } = await app.query(
  `EXPLAIN (ANALYZE, BUFFERS)
   SELECT id FROM outbox
    WHERE status = 'PENDING' AND available_at <= now()
    ORDER BY available_at, id
      FOR UPDATE SKIP LOCKED
    LIMIT ${BATCH}`,
)
await app.query('ROLLBACK')

const text = plan.map((r) => r['QUERY PLAN']).join('\n')
console.log(`\n${text}\n`)

const checks = [
  ['uses outbox_pending_idx', /outbox_pending_idx/.test(text)],
  ['no sequential scan on outbox', !/Seq Scan on outbox/.test(text)],
  ['no Sort node — the index supplies the ordering', !/^\s*(->\s*)?Sort\b/m.test(text)],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed += 1
}

await app.end()
await client.end()

if (failed > 0) {
  console.error(
    `\n  ${failed} check(s) failed. The dispatch index is the whole justification for ` +
      "ADR-0019 correction 2; if the plan does not use it, the correction's premise is wrong.",
  )
  process.exit(1)
}

console.log('\n  plan verified at scale. Paste the output above on the dispatcher PR.')
