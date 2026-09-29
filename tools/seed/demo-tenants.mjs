#!/usr/bin/env node
/*
 * tools/seed/demo-tenants.mjs — M1-X, BOARD.md "Next / M1-X Exit".
 *
 * Idempotently provisions the two staging demo tenants (Product Owner
 * decision, 2026-09-27: codes `bhatti1` / `bhatti2`, stored uppercase as
 * `BHATTI1` / `BHATTI2` — `tenants.code`'s CHECK is `^[A-Z][A-Z0-9_]{1,15}$`)
 * with three users each — Owner, Accountant, Viewer — through the same
 * provisioning steps a real tenant-onboarding flow would use: a `tenants`
 * row, its audit chain anchor (ADR-0020 §5, in the SAME transaction as the
 * `tenants` insert), then `seedSystemRoles` for the three system roles.
 *
 * THIS SCRIPT IS NOT RUN ON STAGING BY THIS AGENT. Per the M1-X brief, it is
 * run later, on the staging host, inside the API image, by the orchestrator,
 * with the Product Owner's explicit OK — recorded as a BLOCKED item in the
 * delivery report. It is tested here only against the local stack.
 *
 * ---------------------------------------------------------------------
 * Connects as finsoft_app (DATABASE_URL) — the same restricted, RLS-subject
 * role the running API uses, NOT finsoft_migration. There is no BYPASSRLS
 * shortcut here: tenant creation goes through `withGlobal` (the `tenants`
 * table is global) and everything else goes through `withTenant`/
 * `TenantContext.run`, exactly like `packages/database/src/testing/
 * harness.ts`'s `createTenantFixture` — which is, today, the only other
 * code in this repository that provisions a tenant at all (see that file's
 * own comment). finsoft_app already holds every grant this needs: INSERT on
 * `tenants`, `users`, `roles`, `role_permissions`, `user_roles` — the same
 * grants an onboarding endpoint would use.
 *
 * ---------------------------------------------------------------------
 * IDEMPOTENCY. Every step checks for the row it is about to create first:
 *   - a tenant with the target code already existing is reused, not
 *     recreated (tenants.code is unique; a second INSERT would just fail)
 *   - `seedSystemRoles` is documented as DELIBERATELY NOT IDEMPOTENT
 *     (packages/database/src/rbac/seed-roles.ts: "a second call for the
 *     same tenant raises 23505 rather than silently duplicating") — so this
 *     script calls it only when the tenant has no roles yet
 *   - a user with the target (tenant, email) already existing is left
 *     alone: this script does not reset an existing user's password on a
 *     re-run, which would silently invalidate whatever the demo team is
 *     currently using it to sign in with
 *
 * A second run against an already-seeded database does nothing but report
 * what already exists.
 *
 * ---------------------------------------------------------------------
 * PASSWORDS. Never in the repository, never with a hardcoded default
 * (rule 20). Read from environment variables named
 * `DEMO_<TENANT>_<ROLE>_PASSWORD` (e.g. `DEMO_BHATTI1_OWNER_PASSWORD`,
 * `DEMO_BHATTI2_ACCOUNTANT_PASSWORD`). Any not set are generated — 24 random
 * bytes, base64url — and every GENERATED password (never one supplied by an
 * environment variable, which the operator already has a copy of) is
 * printed ONCE, at the very end, inside a clearly marked warning block, and
 * is not written anywhere else: not to a file, not to a log line, not to
 * the audit chain (rule 9's writer rejects a secret-shaped key outright —
 * see packages/database/src/audit/secret-keys.ts — so even an accidental
 * attempt would fail loudly rather than silently succeed).
 *
 * ---------------------------------------------------------------------
 * PRODUCTION GUARD. Refuses to run when NODE_ENV=production unless BOTH:
 *   1. --allow-staging is passed explicitly, AND
 *   2. the connection's database name does not look like a production name
 * There is no committed ADR naming the production database — recorded as a
 * DECISION in the delivery report — so the denylist below is a conservative
 * placeholder the devops-guardian should confirm or extend before this
 * script is ever pointed at a real host.
 */

import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import { hashPassword } from '@finsoft/auth'
import {
  closeDatabase,
  openDatabase,
  TenantContext,
  withGlobal,
  withTenant,
} from '@finsoft/database'
import { createAuditChainAnchor } from '@finsoft/database/provisioning'
import { seedSystemRoles } from '@finsoft/permissions'

const ALLOW_STAGING = process.argv.includes('--allow-staging')

/* ------------------------------------------------------------------ *
 * The production guard
 * ------------------------------------------------------------------ */

// See this file's header: no ADR names the production database today. This
// is a conservative placeholder, not a documented convention.
const PRODUCTION_DATABASE_NAME_DENYLIST = new Set([
  'finsoft_production',
  'finsoft_prod',
  'production',
  'prod',
])

function databaseNameFrom(connectionString) {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '')
  } catch {
    return undefined
  }
}

function assertSafeToRun() {
  const nodeEnv = process.env.NODE_ENV

  if (nodeEnv !== 'production') return

  if (!ALLOW_STAGING) {
    console.error(
      'Refusing to run: NODE_ENV=production and --allow-staging was not passed.\n' +
        'This script provisions demo tenants and users and is never run against a real ' +
        'production database. Pass --allow-staging only when the orchestrator has the Product ' +
        "Owner's explicit OK to seed the staging host (see this file's header).",
    )
    process.exit(1)
  }

  const dbName = databaseNameFrom(process.env.DATABASE_URL ?? '')
  if (dbName && PRODUCTION_DATABASE_NAME_DENYLIST.has(dbName.toLowerCase())) {
    console.error(
      `Refusing to run: DATABASE_URL points at "${dbName}", which looks like a production ` +
        'database name, even with --allow-staging. If this genuinely is the staging database, ' +
        'rename it, or extend PRODUCTION_DATABASE_NAME_DENYLIST in this file with the ' +
        "devops-guardian's sign-off — never by deleting this check.",
    )
    process.exit(1)
  }
}

/* ------------------------------------------------------------------ *
 * Demo tenant/user definitions
 * ------------------------------------------------------------------ */

const DEMO_TENANTS = [
  { code: 'BHATTI1', name: 'Bhatti Demo 1' },
  { code: 'BHATTI2', name: 'Bhatti Demo 2' },
]

const DEMO_ROLES = [
  { code: 'owner', label: 'Owner', localPart: 'owner' },
  { code: 'accountant', label: 'Accountant', localPart: 'accountant' },
  { code: 'viewer', label: 'Viewer', localPart: 'viewer' },
]

function demoEmail(tenantCode, localPart) {
  return `${localPart}@${tenantCode.toLowerCase()}.demo`
}

function passwordEnvVar(tenantCode, roleCode) {
  return `DEMO_${tenantCode}_${roleCode.toUpperCase()}_PASSWORD`
}

function generateStrongPassword() {
  return randomBytes(24).toString('base64url')
}

/** Passwords generated by THIS run (never one read from an env var), to print once at the end. */
const generatedPasswords = []

function resolvePassword(tenantCode, roleCode) {
  const envVar = passwordEnvVar(tenantCode, roleCode)
  const fromEnv = process.env[envVar]
  if (fromEnv && fromEnv.trim() !== '') {
    return { password: fromEnv, generated: false, envVar }
  }
  const password = generateStrongPassword()
  generatedPasswords.push({ tenantCode, roleCode, envVar, password })
  return { password, generated: true, envVar }
}

/* ------------------------------------------------------------------ *
 * Provisioning
 * ------------------------------------------------------------------ */

async function findOrCreateTenant(code, name) {
  const existing = await withGlobal((tx) =>
    tx.selectFrom('tenants').select(['id', 'status']).where('code', '=', code).executeTakeFirst(),
  )
  if (existing) {
    console.log(`  tenant ${code}: already exists (status ${existing.status}) — reusing`)
    return { tenantId: existing.id, created: false }
  }

  const tenantId = await withGlobal(async (tx) => {
    const row = await tx
      .insertInto('tenants')
      .values({ code, name })
      .returning('id')
      .executeTakeFirstOrThrow()

    // ADR-0020 §5: the anchor is created in the SAME transaction as the
    // tenants insert, before the tenant is generally visible — the one
    // legitimate caller for this, per createAuditChainAnchor's own
    // provisioning-only placement (@finsoft/database/provisioning).
    await createAuditChainAnchor(tx, row.id)
    return row.id
  })

  console.log(`  tenant ${code}: created (${tenantId})`)
  return { tenantId, created: true }
}

async function provisionOwner(tenantId, code) {
  const email = demoEmail(code, 'owner')

  // The owner is the ONE row per tenant whose created_by/updated_by are
  // NULL (migration 002: "created_by / updated_by are NULLABLE only here,
  // and only for one row" — enforced by a partial unique index). Reading it
  // is therefore reading whether an owner exists at all.
  const found = await TenantContext.run({ tenantId, userId: null }, () =>
    withTenant((tx) =>
      tx
        .selectFrom('users')
        .select(['id', 'status'])
        .where('tenant_id', '=', tenantId)
        .where('created_by', 'is', null)
        .executeTakeFirst(),
    ),
  )

  if (found) {
    console.log(`  ${code} owner (${email}): already exists (status ${found.status}) — reusing`)
    return { userId: found.id, created: false }
  }

  const { password, generated } = resolvePassword(code, 'owner')
  const passwordHash = await hashPassword(password)

  const userId = await TenantContext.run({ tenantId, userId: null }, () =>
    withTenant(async (tx) => {
      const owner = await tx
        .insertInto('users')
        .values({
          tenant_id: tenantId,
          email,
          full_name: `${code} Owner`,
          status: 'ACTIVE',
          password_hash: passwordHash,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      // Roles are authored by the owner that was just created — the same
      // shape a real provisioning flow uses (the acting user for
      // created_by/updated_by must already exist by the time roles are
      // seeded; see packages/database/src/rbac/seed-roles.ts's own header).
      await seedSystemRoleRolesIfMissing(tx, tenantId, owner.id)

      const ownerRole = await tx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('code', '=', 'owner')
        .executeTakeFirstOrThrow()

      await tx
        .insertInto('user_roles')
        .values({
          tenant_id: tenantId,
          user_id: owner.id,
          role_id: ownerRole.id,
          created_by: owner.id,
          updated_by: owner.id,
        })
        .execute()

      return owner.id
    }),
  )

  console.log(`  ${code} owner (${email}): created${generated ? ' (password generated)' : ''}`)
  return { userId, created: true }
}

/**
 * seedSystemRoles is deliberately NOT idempotent (a second call for the
 * same tenant raises 23505) — this checks first, so a re-run of this whole
 * script does not fail on a tenant it already seeded roles for.
 */
async function seedSystemRoleRolesIfMissing(tx, tenantId, actorUserId) {
  const anyRole = await tx
    .selectFrom('roles')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst()

  if (anyRole) return

  await TenantContext.run({ tenantId, userId: actorUserId }, () => seedSystemRoles(tx, tenantId))
}

async function provisionMember(tenantId, code, ownerId, roleCode, localPart, label) {
  const email = demoEmail(code, localPart)

  const existing = await TenantContext.run({ tenantId, userId: ownerId }, () =>
    withTenant((tx) =>
      tx
        .selectFrom('users')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where(sql`lower(email) = ${email.toLowerCase()}`)
        .executeTakeFirst(),
    ),
  )

  if (existing) {
    console.log(`  ${code} ${label.toLowerCase()} (${email}): already exists — reusing`)
    return { created: false }
  }

  const { password, generated } = resolvePassword(code, roleCode)
  const passwordHash = await hashPassword(password)

  await TenantContext.run({ tenantId, userId: ownerId }, () =>
    withTenant(async (tx) => {
      const user = await tx
        .insertInto('users')
        .values({
          tenant_id: tenantId,
          email,
          full_name: `${code} ${label}`,
          status: 'ACTIVE',
          password_hash: passwordHash,
          created_by: ownerId,
          updated_by: ownerId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      const role = await tx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('code', '=', roleCode)
        .executeTakeFirstOrThrow()

      await tx
        .insertInto('user_roles')
        .values({
          tenant_id: tenantId,
          user_id: user.id,
          role_id: role.id,
          created_by: ownerId,
          updated_by: ownerId,
        })
        .execute()
    }),
  )

  console.log(
    `  ${code} ${label.toLowerCase()} (${email}): created${generated ? ' (password generated)' : ''}`,
  )
  return { created: true }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  assertSafeToRun()

  await openDatabase()

  try {
    for (const tenant of DEMO_TENANTS) {
      console.log(`\n${tenant.code} (${tenant.name})`)
      const { tenantId } = await findOrCreateTenant(tenant.code, tenant.name)
      const { userId: ownerId } = await provisionOwner(tenantId, tenant.code)

      for (const role of DEMO_ROLES) {
        if (role.code === 'owner') continue
        await provisionMember(tenantId, tenant.code, ownerId, role.code, role.localPart, role.label)
      }
    }

    if (generatedPasswords.length > 0) {
      console.log(
        '\n' +
          '================================================================\n' +
          '  GENERATED PASSWORDS — shown ONCE, not stored anywhere else.\n' +
          '  Save these now. Re-running this script will NOT show them again\n' +
          "  (an already-provisioned user is left untouched, per this file's\n" +
          '  header) — recovery is a manual password reset, not a re-run.\n' +
          '================================================================',
      )
      for (const { tenantCode, roleCode, envVar, password } of generatedPasswords) {
        console.log(
          `  ${tenantCode} / ${roleCode}: ${password}   (set ${envVar} to pin this next time)`,
        )
      }
      console.log('================================================================\n')
    } else {
      console.log('\nNo passwords were generated — every account used an existing DEMO_*_PASSWORD.')
    }
  } finally {
    await closeDatabase()
  }
}

main().catch((error) => {
  console.error('demo-tenants seed failed:', error)
  process.exitCode = 1
})
