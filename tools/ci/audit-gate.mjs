#!/usr/bin/env node
/*
 * GAP-002 (docs/COMPLIANCE_GAPS.md) — "Split the CI job so that exploitable
 * high/critical fails the build while the rest reports without blocking.
 * continue-on-error on the whole job cannot express that distinction."
 *
 * This is the blocking half. It runs `npm audit --omit=dev`, so a dev-only
 * or build-time-only finding never reaches it — that reading is exactly what
 * `--omit=dev` gives you today with this dependency tree (see the allowlist
 * entry below for why postcss is still here even with --omit=dev), and a
 * future finding that IS purely dev-only will simply not appear in this
 * command's output. Anything HIGH or CRITICAL that remains fails the run,
 * UNLESS it is named in tools/ci/audit-allowlist.json with an owner, a
 * rationale and a review-by date that has not passed.
 *
 * The advisory half (unchanged) is the plain `npm audit --audit-level=high`
 * step in ci.yml, with continue-on-error: true — it reports everything,
 * including dev dependencies and moderate/low findings, and blocks nothing.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ALLOWLIST_PATH = join(HERE, 'audit-allowlist.json')

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  const entries = Array.isArray(raw) ? raw : raw.entries
  for (const e of entries) {
    for (const field of ['package', 'owner', 'rationale', 'reviewBy']) {
      if (!e[field])
        throw new Error(`audit-allowlist.json entry for "${e.package}" is missing "${field}"`)
    }
    if (Number.isNaN(Date.parse(e.reviewBy))) {
      throw new Error(
        `audit-allowlist.json entry for "${e.package}" has an unparseable reviewBy date`,
      )
    }
  }
  return entries
}

function runAudit() {
  try {
    // npm audit exits non-zero when it finds anything at/above --audit-level.
    // We want the JSON either way, so the exit code is read but not thrown on.
    // A plain command string through execSync's own shell (rather than
    // execFileSync's shell:true + argv, which node warns is unsafe to mix)
    // — safe here because every argument is a fixed literal, never input.
    const out = execSync('npm audit --omit=dev --json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(out)
  } catch (err) {
    // execSync throws on non-zero exit; npm still wrote JSON to stdout.
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout)
      } catch {
        /* fall through to the error below */
      }
    }
    throw new Error(`npm audit did not produce parseable JSON: ${err.message}`, { cause: err })
  }
}

function main() {
  const allowlist = loadAllowlist()
  const report = runAudit()
  const vulns = report.vulnerabilities ?? {}

  const blocking = []
  const allowed = []

  for (const [name, v] of Object.entries(vulns)) {
    if (v.severity !== 'high' && v.severity !== 'critical') continue

    const entry = allowlist.find((e) => e.package === name)
    if (!entry) {
      blocking.push({ name, severity: v.severity, reason: 'not in tools/ci/audit-allowlist.json' })
      continue
    }
    const reviewBy = new Date(entry.reviewBy)
    if (reviewBy.getTime() < Date.now()) {
      blocking.push({
        name,
        severity: v.severity,
        reason: `allowlisted but review-by date ${entry.reviewBy} has passed — re-triage required`,
      })
      continue
    }
    allowed.push({ name, severity: v.severity, entry })
  }

  if (allowed.length > 0) {
    console.log('Allowlisted high/critical findings in production dependencies:')
    for (const { name, severity, entry } of allowed) {
      console.log(`  - ${name} (${severity}) — owner: ${entry.owner}, review by: ${entry.reviewBy}`)
      console.log(`    ${entry.rationale}`)
    }
  }

  if (blocking.length > 0) {
    console.error('\nBLOCKING: exploitable high/critical findings in production dependencies:')
    for (const { name, severity, reason } of blocking) {
      console.error(`  - ${name} (${severity}): ${reason}`)
    }
    console.error(
      '\nGAP-002: this fails release. Either fix/upgrade the dependency, or add an entry to\n' +
        'tools/ci/audit-allowlist.json with an owner, a written rationale for why it does not\n' +
        'block, and a review-by date — that is a Security Guardian / Product Owner decision,\n' +
        'not something to wave through here.',
    )
    process.exit(1)
  }

  console.log('\nNo unaddressed high/critical findings in production dependencies.')
}

main()
