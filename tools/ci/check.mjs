#!/usr/bin/env node
/*
 * `npm run check` — the fast, no-Docker local gate.
 *
 * OPS-002: CI proves the full risk-tiered gate; this proves the part of it
 * that needs no database, in well under the time it takes to forget why you
 * were about to push. Target: <=90s on a warm install.
 *
 * Runs, in order, failing fast on the first problem:
 *   1. classify (informational — prints the tier this push would run in)
 *   2. typecheck (whole repo — this is the one that catches drift across a
 *      package boundary, which "changed files only" would miss)
 *   3. lint — only files changed since the merge-base with origin/develop,
 *      for the same reason .githooks/pre-push always scoped it: full `npm
 *      run lint` is CI's job, and pre-existing debt in a file this push does
 *      not touch must not block it.
 *   4. format:check
 *   5. depcruise (module boundaries)
 *   6. affected unit tests — `npm test --workspaces --if-present`. Every
 *      workspace test is a pure unit test with no Docker dependency; the one
 *      that used to need Postgres (apps/api's app.spec.ts) now lives in
 *      tests/integration (OPS-002 item 3) and runs under `check:full`.
 *
 * `npm run check:full` additionally brings the data plane up and runs the
 * full `npm run verify` gate (typecheck/lint/depcruise/migrate:verify/
 * format:check/test, where `test` includes test:gate — schema, security,
 * accounting, reconciliation, integration, performance) plus test:e2e.
 */
import { execSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { classify, loadConfig, resolveBase, changedFilesFromGit } from './classify.mjs'

const LINT_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs'])
const LINT_BATCH_SIZE = 40

function run(label, fn) {
  const start = performance.now()
  process.stdout.write(`\n> ${label}\n`)
  try {
    fn()
  } catch (err) {
    const seconds = ((performance.now() - start) / 1000).toFixed(1)
    console.error(`\n  FAILED: ${label} (${seconds}s)\n`)
    throw err
  }
  const seconds = ((performance.now() - start) / 1000).toFixed(1)
  console.log(`  ok: ${label} (${seconds}s)`)
  return seconds
}

// A plain command string through execSync's own shell, never execFileSync's
// shell:true + argv (node warns that combination is unsafe to mix) and never
// a bare 'npm'/'npx' through execFileSync (Windows cannot exec a .cmd shim
// without going through a shell — it fails with EINVAL). Every argument
// built here is either a fixed literal or a repo-relative path quoted below;
// nothing here is untrusted input.
function sh(cmd) {
  execSync(cmd, { stdio: 'inherit' })
}

function quote(p) {
  return `"${p}"`
}

function npm(script) {
  sh(`npm run ${script}`)
}

function lintChangedFiles(files) {
  const targets = files.filter((f) => {
    const dot = f.lastIndexOf('.')
    return dot !== -1 && LINT_EXTENSIONS.has(f.slice(dot))
  })
  if (targets.length === 0) {
    console.log('  no changed .ts/.tsx/.mjs/.cjs files — nothing to lint')
    return
  }
  console.log(`  linting ${targets.length} changed file(s)`)
  for (let i = 0; i < targets.length; i += LINT_BATCH_SIZE) {
    const batch = targets.slice(i, i + LINT_BATCH_SIZE)
    sh(`npx eslint ${batch.map(quote).join(' ')}`)
  }
}

function main() {
  const overallStart = performance.now()
  const config = loadConfig()

  let files = []
  try {
    const base = resolveBase()
    files = changedFilesFromGit(base)
  } catch (err) {
    console.warn(`  classify: could not determine changed files (${err.message})`)
    console.warn('  continuing with a full lint pass instead of a scoped one')
  }

  const result = classify({ files, config, cliFull: false })
  console.log(`\nclassify: tier ${result.tier}${result.full ? ' (full)' : ''}`)
  for (const reason of result.reasons) console.log(`  - ${reason}`)
  if (result.tier === 'T2' || result.tier === 'T3') {
    console.log(
      `\n  This looks like ${result.tier} work (auth/permissions/tenancy/migrations/infra` +
        (result.tier === 'T3' ? ', or posting/money/inventory/tax/periods' : '') +
        `).\n  Run "npm run check:full" before opening the pull request — it brings up the\n` +
        `  data plane and runs the suites CI will require for this tier.`,
    )
  }

  run('typecheck', () => npm('typecheck'))
  run('lint (changed files)', () => lintChangedFiles(files))
  run('format:check', () => npm('format:check'))
  run('depcruise', () => npm('depcruise'))
  run('unit tests (npm test --workspaces --if-present)', () =>
    sh('npm test --workspaces --if-present'),
  )

  const totalSeconds = ((performance.now() - overallStart) / 1000).toFixed(1)
  console.log(`\ncheck passed in ${totalSeconds}s\n`)
}

main()
