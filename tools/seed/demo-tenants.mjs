#!/usr/bin/env node
/*
 * tools/seed/demo-tenants.mjs — M1-X, BOARD.md "Next / M1-X Exit".
 *
 * Idempotently provisions the two staging demo tenants (Product Owner
 * decision, 2026-09-27: codes `bhatti1` / `bhatti2`, stored uppercase as
 * `BHATTI1` / `BHATTI2` — `tenants.code`'s CHECK is `^[A-Z][A-Z0-9_]{1,15}$`)
 * with three users each — Owner, Accountant, Viewer.
 *
 * THIS SCRIPT IS NOT RUN ON STAGING BY THIS AGENT. Per the M1-X brief, it is
 * run later, on the staging host, inside the API image, by the orchestrator,
 * with the Product Owner's explicit OK — recorded as a BLOCKED item in the
 * delivery report. It is tested here only against the local stack.
 *
 * ---------------------------------------------------------------------
 * MECHANISM (M1-X, Council S3). Every query body lives in
 * @finsoft/database/provisioning as a named export taking parameters and
 * returning rows or ids — this script decides WHAT to do (create vs reuse,
 * which password to use, which role); that module decides HOW (the
 * transaction shape, tenant context, the audit chain anchor). This script
 * never opens a transaction, never names a table, and never imports Kysely.
 * Connects as finsoft_app (DATABASE_URL) — the same restricted, RLS-subject
 * role the running API uses, never finsoft_migration.
 *
 * ---------------------------------------------------------------------
 * IDEMPOTENCY. Every step checks for the row it is about to create first:
 *   - a tenant with the target code already existing is reused, not
 *     recreated (tenants.code is unique; a second INSERT would just fail)
 *   - system roles are seeded only when the tenant has none yet —
 *     `insertSeededRoles` is documented as DELIBERATELY NOT IDEMPOTENT
 *     (packages/database/src/rbac/seed-roles.ts: "a second call for the
 *     same tenant raises 23505 rather than silently duplicating")
 *   - a user with the target (tenant, email) already existing is left
 *     alone: this script does not reset an existing user's password on a
 *     re-run, which would silently invalidate whatever the demo team is
 *     currently using it to sign in with
 *
 * A second run against an already-seeded database does nothing but report
 * what already exists.
 *
 * ---------------------------------------------------------------------
 * PASSWORDS (M1-X, Council S2). NEVER PRINTED — not to stdout, not to a log
 * line, in any environment. Read from environment variables named
 * `DEMO_<TENANT>_<ROLE>_PASSWORD` (e.g. `DEMO_BHATTI1_OWNER_PASSWORD`). Any
 * not set are generated (24 random bytes, base64url) and written to a 0600
 * file at the path given by `--credentials-out` (refused if that path
 * resolves inside this repository, or if the flag is missing and a password
 * needed generating — there is no fallback to stdout). That file is for A
 * HUMAN — the Product Owner — TO READ AND DISTRIBUTE THE DEMO CREDENTIALS.
 * The orchestrator that runs this script does not open it: doing so would
 * put the passwords back into an AI agent's own conversation transcript,
 * which is exactly what writing them to a file instead of stdout is for.
 *
 * ---------------------------------------------------------------------
 * PRODUCTION GUARD (M1-X, Council S1). Unrestricted only when
 * NODE_ENV is "development" or "test". Any other value — INCLUDING
 * "production", which staging's own compose.yaml sets (there is no separate
 * "staging" NODE_ENV) — requires BOTH:
 *   1. FINSOFT_ENVIRONMENT=staging set explicitly, AND
 *   2. a database-level check: every tenant already in this database is one
 *      of the demo codes, or there are none at all.
 * Neither is sufficient alone, and nothing overrides this combination for
 * NODE_ENV=production — there is no "--force" flag.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from '@finsoft/auth'
import { closeDatabase, openDatabase } from '@finsoft/database'
import {
  createMemberWithRole,
  createProvisionedOwnerWithRoles,
  createTenant,
  findMemberByEmail,
  findProvisionedOwner,
  findTenantByCode,
  listAllTenantCodes,
} from '@finsoft/database/provisioning'
import { SYSTEM_ROLE_SEEDS } from '@finsoft/permissions'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/* ------------------------------------------------------------------ *
 * Demo tenant/user definitions
 * ------------------------------------------------------------------ */

const DEMO_TENANTS = [
  { code: 'BHATTI1', name: 'Bhatti Demo 1' },
  { code: 'BHATTI2', name: 'Bhatti Demo 2' },
]
const DEMO_TENANT_CODES = new Set(DEMO_TENANTS.map((t) => t.code))

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

/* ------------------------------------------------------------------ *
 * S1: the production guard
 * ------------------------------------------------------------------ */

async function assertSafeToRun() {
  const nodeEnv = process.env.NODE_ENV

  if (nodeEnv === 'development' || nodeEnv === 'test') return

  if (process.env.FINSOFT_ENVIRONMENT !== 'staging') {
    console.error(
      `Refusing to run: NODE_ENV="${nodeEnv ?? '(unset)'}" is not "development" or "test".\n` +
        'This script provisions demo tenants and users. Staging is not exempt by NODE_ENV alone ' +
        '- its own compose.yaml sets NODE_ENV=production, the same value real production would - ' +
        'so FINSOFT_ENVIRONMENT=staging must ALSO be set explicitly. There is no flag that ' +
        'bypasses this, and nothing bypasses it at all for a value other than "staging".',
    )
    process.exit(1)
  }

  // Database-level check: this is staging only if every tenant already here
  // is a demo tenant, or there are none. FINSOFT_ENVIRONMENT=staging is an
  // operator's claim; this is the check that does not just trust it.
  const existingCodes = await listAllTenantCodes()
  const unexpected = existingCodes.filter((code) => !DEMO_TENANT_CODES.has(code))
  if (unexpected.length > 0) {
    const shown = unexpected.slice(0, 10)
    const suffix =
      unexpected.length > shown.length ? `, and ${unexpected.length - shown.length} more` : ''
    console.error(
      `Refusing to run: this database already contains ${unexpected.length} tenant(s) outside ` +
        `the demo set (${shown.join(', ')}${suffix}). FINSOFT_ENVIRONMENT=staging is not enough ` +
        'on its own - every existing tenant must already be BHATTI1/BHATTI2, or there must be ' +
        'none. This is the one check standing between this script and a database that turns ' +
        'out to be production.',
    )
    process.exit(1)
  }
}

/* ------------------------------------------------------------------ *
 * S2: passwords — never printed
 * ------------------------------------------------------------------ */

function parseCredentialsOutPath() {
  const flagIndex = process.argv.indexOf('--credentials-out')
  if (flagIndex === -1) return undefined
  const value = process.argv[flagIndex + 1]
  if (!value) {
    console.error('--credentials-out requires a path argument.')
    process.exit(1)
  }
  const resolved = resolve(value)
  const rel = relative(REPO_ROOT, resolved)
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    console.error(
      `Refusing to write credentials to "${resolved}": it resolves inside this repository. ` +
        'Generated passwords are written OUTSIDE the repo, never into anything that could be ' +
        'committed, diffed or attached to a ticket. Pass a path elsewhere on the host.',
    )
    process.exit(1)
  }
  return resolved
}

/** Passwords generated by THIS run (never one read from an env var). Never logged; written to --credentials-out only. */
const generatedPasswords = []

function resolvePassword(tenantCode, roleCode) {
  const envVar = passwordEnvVar(tenantCode, roleCode)
  const fromEnv = process.env[envVar]
  if (fromEnv && fromEnv.trim() !== '') {
    return { password: fromEnv, generated: false }
  }
  const password = generateStrongPassword()
  generatedPasswords.push({ tenantCode, roleCode, envVar, password })
  return { password, generated: true }
}

function writeCredentialsFile(path) {
  const lines = [
    '# FinSoft demo tenant credentials — generated by tools/seed/demo-tenants.mjs',
    `# Generated ${new Date().toISOString()}`,
    '#',
    '# FOR A HUMAN TO READ. The Product Owner reads this file and distributes these',
    '# credentials. The orchestrator that ran this script does NOT open it - these',
    '# values are never printed to a terminal, a log, or an AI agent’s own',
    '# conversation transcript. Store or delete this file according to your own',
    '# secret-handling policy once the credentials have been distributed (rule 20).',
    '',
    ...generatedPasswords.map(
      ({ tenantCode, roleCode, envVar, password }) =>
        `${tenantCode}_${roleCode}=${password}  # set ${envVar} to pin this next time`,
    ),
    '',
  ].join('\n')

  writeFileSync(path, lines, { mode: 0o600 })
  // writeFileSync's mode is masked by umask on some platforms; set it
  // explicitly rather than trusting that alone.
  chmodSync(path, 0o600)
}

/* ------------------------------------------------------------------ *
 * Provisioning — decisions only; every query is in @finsoft/database/provisioning
 * ------------------------------------------------------------------ */

async function provisionTenant(code, name) {
  const existing = await findTenantByCode(code)
  if (existing) {
    console.log(`  tenant ${code}: already exists (status ${existing.status}) — reusing`)
    return existing.id
  }
  const tenantId = await createTenant(code, name)
  console.log(`  tenant ${code}: created (${tenantId})`)
  return tenantId
}

async function provisionOwner(tenantId, code) {
  const email = demoEmail(code, 'owner')

  const existing = await findProvisionedOwner(tenantId)
  if (existing) {
    console.log(`  ${code} owner (${email}): already exists (status ${existing.status}) — reusing`)
    return existing.id
  }

  const { password, generated } = resolvePassword(code, 'owner')
  const passwordHash = await hashPassword(password)

  const ownerId = await createProvisionedOwnerWithRoles(
    tenantId,
    email,
    `${code} Owner`,
    passwordHash,
    SYSTEM_ROLE_SEEDS,
    'owner',
  )

  console.log(`  ${code} owner (${email}): created${generated ? ' (password generated)' : ''}`)
  return ownerId
}

async function provisionMember(tenantId, code, ownerId, roleCode, localPart, label) {
  const email = demoEmail(code, localPart)

  const existing = await findMemberByEmail(tenantId, ownerId, email)
  if (existing) {
    console.log(`  ${code} ${label.toLowerCase()} (${email}): already exists — reusing`)
    return
  }

  const { password, generated } = resolvePassword(code, roleCode)
  const passwordHash = await hashPassword(password)

  await createMemberWithRole(tenantId, ownerId, email, `${code} ${label}`, passwordHash, roleCode)

  console.log(
    `  ${code} ${label.toLowerCase()} (${email}): created${generated ? ' (password generated)' : ''}`,
  )
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const credentialsOutPath = parseCredentialsOutPath()

  await openDatabase()

  try {
    await assertSafeToRun()

    for (const tenant of DEMO_TENANTS) {
      console.log(`\n${tenant.code} (${tenant.name})`)
      const tenantId = await provisionTenant(tenant.code, tenant.name)
      const ownerId = await provisionOwner(tenantId, tenant.code)

      for (const role of DEMO_ROLES) {
        if (role.code === 'owner') continue
        await provisionMember(tenantId, tenant.code, ownerId, role.code, role.localPart, role.label)
      }
    }

    if (generatedPasswords.length === 0) {
      console.log('\nNo passwords were generated — every account used an existing DEMO_*_PASSWORD.')
      return
    }

    if (!credentialsOutPath) {
      console.error(
        '\nRefusing to finish: passwords were generated but --credentials-out was not given, ' +
          'and passwords are never printed. Either set every DEMO_<TENANT>_<ROLE>_PASSWORD ' +
          'environment variable in advance, or pass --credentials-out <path-outside-the-repo>.',
      )
      process.exitCode = 1
      return
    }

    writeCredentialsFile(credentialsOutPath)
    console.log(
      `\n${generatedPasswords.length} password(s) generated and written to ${credentialsOutPath} ` +
        '(mode 0600). A HUMAN reads that file — this script never prints a password.',
    )
  } finally {
    await closeDatabase()
  }
}

main().catch((error) => {
  console.error('demo-tenants seed failed:', error)
  process.exitCode = 1
})
