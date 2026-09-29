#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import {
  closeDatabase,
  openDatabase,
  TenantContext,
  withGlobal,
  withTenant,
} from '@finsoft/database'
import {
  createFiscalYear,
  hasChartOfAccounts,
  hasFiscalYear,
  seedChartOfAccounts,
} from '@finsoft/database/provisioning'

/*
 * Gives an EXISTING tenant — one provisioned before this lane's chart of
 * accounts and fiscal calendar existed (e.g. BHATTI1/BHATTI2 from the M1-X
 * demo seed) — the standard chart of accounts and FY2027, without touching
 * a tenant that already has either.
 *
 * Idempotent by construction: `hasChartOfAccounts`/`hasFiscalYear` (both
 * packages/database/src/accounting/**) guard each half independently, so a
 * tenant missing only one gets only that one, and a tenant with both is a
 * no-op. Safe to run more than once, and safe to run against a mixed set of
 * old and already-backfilled tenants in the same pass.
 *
 * Connects as finsoft_app (openDatabase's default target, RLS-subject),
 * exactly the role the running application uses — this is ordinary tenant
 * provisioning work, run out of band, not a privileged migration-role
 * operation. `TenantContext.run` is the same entry point ADR-0004's own
 * comment names for "the auth guard ... and the job runner" — a backfill
 * script is a job runner.
 *
 * This writes no journal entry (coa-standard.md §5) — seeding a chart of
 * accounts and a fiscal calendar is provisioning, not a financial posting.
 *
 *   npm run backfill:accounting                    every tenant missing either
 *   npm run backfill:accounting -- --tenant BHATTI1   just one tenant, by code
 *   npm run backfill:accounting -- --dry-run          report only, write nothing
 *
 * Run locally only (per this lane's task contract) — staging runs happen
 * separately, with the Product Owner's sign-off, by whoever orchestrates
 * that environment.
 *
 * Environment guard (Council condition, T3 review): staging and production
 * both set NODE_ENV=production (docs/INFRASTRUCTURE.md) — NODE_ENV alone
 * cannot tell them apart. Under NODE_ENV=production this script refuses to
 * run unless FINSOFT_ENVIRONMENT=staging is ALSO set, and even then only
 * against a database holding nothing but the known demo tenants — mirroring
 * the M1-X demo seed's own rule (that script was not available to read from
 * this worktree at the time this guard was written; reconcile the two rules
 * once it lands, per this lane's Council follow-up). Local development and
 * test runs (NODE_ENV unset or anything other than "production") are
 * unrestricted.
 */

const FISCAL_YEAR = 2027

/** docs/BOARD.md: the only tenants this script may ever touch outside local dev. */
const DEMO_TENANT_CODES = new Set(['BHATTI1', 'BHATTI2'])

function assertSafeEnvironment(tenants) {
  if (process.env.NODE_ENV !== 'production') return

  if (process.env.FINSOFT_ENVIRONMENT !== 'staging') {
    throw new Error(
      'Refusing to run: NODE_ENV=production without FINSOFT_ENVIRONMENT=staging. Staging and ' +
        'production both set NODE_ENV=production, so this second, explicit marker is the only ' +
        'way this script can tell them apart. Set FINSOFT_ENVIRONMENT=staging to confirm this ' +
        'really is staging.',
    )
  }

  const unexpected = tenants.filter((t) => !DEMO_TENANT_CODES.has(t.code))
  if (unexpected.length > 0) {
    throw new Error(
      'Refusing to run: found tenant(s) outside the demo set on a FINSOFT_ENVIRONMENT=staging ' +
        `target: ${unexpected.map((t) => t.code).join(', ')}. This script only ever runs ` +
        'against the known demo tenants ' +
        `(${[...DEMO_TENANT_CODES].join(', ')}) once NODE_ENV=production — a database holding ` +
        'anything else is not a target it may touch.',
    )
  }
}

function parseArgs(argv) {
  const tenantIndex = argv.indexOf('--tenant')
  const tenant = tenantIndex === -1 ? undefined : argv[tenantIndex + 1]
  if (tenantIndex !== -1 && !tenant) {
    throw new Error('--tenant requires a value (the tenant code)')
  }
  return { tenant, dryRun: argv.includes('--dry-run') }
}

/** Every tenant, or the one named by `--tenant`, oldest first (creation order). */
async function listTargetTenants(tenantCode) {
  return withGlobal(async (tx) => {
    let query = tx.selectFrom('tenants').select(['id', 'code']).orderBy('created_at')
    if (tenantCode) query = query.where('code', '=', tenantCode)
    return query.execute()
  })
}

/**
 * The tenant's provisioned owner: the one user with no `created_by`
 * (migration 002 permits exactly one such row per tenant — nobody existed
 * yet to author it). `userId: null` here is legitimate per TenantContext's
 * own contract ("tenant provisioning creates the first user ... nobody to
 * name as its author") — this read needs a tenant in scope, not an actor.
 */
async function findOwnerId(tenantId) {
  return TenantContext.run({ tenantId, userId: null }, () =>
    withTenant(async (tx) => {
      const row = await tx
        .selectFrom('users')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('created_by', 'is', null)
        .executeTakeFirst()
      return row?.id ?? null
    }),
  )
}

function describeMissing(hadCoa, hadFy) {
  return [!hadCoa && 'chart of accounts', !hadFy && `FY${FISCAL_YEAR}`].filter(Boolean).join(', ')
}

async function backfillTenant(tenant, dryRun) {
  const ownerId = await findOwnerId(tenant.id)
  if (ownerId === null || ownerId === undefined) {
    return {
      code: tenant.code,
      status: 'SKIPPED',
      reason: 'no provisioned owner (a user with created_by IS NULL) found for this tenant',
    }
  }

  return TenantContext.run({ tenantId: tenant.id, userId: ownerId }, () =>
    withTenant(async (tx) => {
      const hadCoa = await hasChartOfAccounts(tx, tenant.id)
      const hadFy = await hasFiscalYear(tx, tenant.id, FISCAL_YEAR)

      if (hadCoa && hadFy) {
        return { code: tenant.code, status: 'UP_TO_DATE' }
      }

      const missing = describeMissing(hadCoa, hadFy)
      if (dryRun) {
        return { code: tenant.code, status: 'WOULD_BACKFILL', reason: missing }
      }

      // `via` names this CLI in the audit record's afterJson (hashed into
      // the chain); `requestId` must be a uuid, not a label, so a fresh one
      // is minted per write rather than reused across a whole run.
      const origin = { via: 'backfill-accounting', requestId: randomUUID() }
      if (!hadCoa) await seedChartOfAccounts(tx, tenant.id, undefined, origin)
      if (!hadFy) await createFiscalYear(tx, tenant.id, FISCAL_YEAR, undefined, origin)

      return { code: tenant.code, status: 'BACKFILLED', reason: missing }
    }),
  )
}

async function main() {
  const { tenant: tenantCode, dryRun } = parseArgs(process.argv.slice(2))
  await openDatabase()

  const tenants = await listTargetTenants(tenantCode)
  if (tenants.length === 0) {
    console.log(tenantCode ? `  no tenant with code ${tenantCode}` : '  no tenants found')
    return 0
  }

  // The environment guard needs the full, unfiltered tenant list to check
  // for anything outside the demo set — check it against every tenant on
  // the target database, not just the one named by --tenant.
  const allTenants = tenantCode ? await listTargetTenants(undefined) : tenants
  assertSafeEnvironment(allTenants)

  let failed = 0
  for (const tenant of tenants) {
    try {
      const result = await backfillTenant(tenant, dryRun)
      const suffix = result.reason ? ` — ${result.reason}` : ''
      console.log(`  ${result.status.padEnd(14)} ${result.code}${suffix}`)
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`  FAILED         ${tenant.code} — ${message}`)
    }
  }

  console.log(`\n  ${tenants.length} tenant(s) checked, ${failed} failure(s)`)
  return failed === 0 ? 0 : 1
}

main()
  .then(async (code) => {
    await closeDatabase()
    process.exit(code)
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    await closeDatabase().catch(() => {})
    process.exit(1)
  })
