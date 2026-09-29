#!/usr/bin/env node
/*
 * ship:staging — OPS-003 "ship to staging from the laptop"
 *
 * Why this exists: the PO cannot pay for GitHub Actions minutes right now
 * (PO decision, 2026-09-29). Until billing is on, the CI workflow only runs
 * on workflow_dispatch (see .github/workflows/ci.yml) and THIS tool is the
 * gate: it runs the same checks CI would have run, on the laptop, against a
 * fresh throwaway stack, and only then builds and deploys to staging.
 *
 * It never touches production. It never reads a production credential.
 * Database isolation and the release rules in docs/INFRASTRUCTURE.md are
 * enforced by the topology (staging is a different host, different DB, no
 * path exists from here to Hostinger), not by this script — but this script
 * does refuse to ship anything that isn't merged, and refuses to deploy
 * anything the gate didn't pass.
 *
 * Usage:
 *   npm run ship:staging                       ship origin/develop HEAD
 *   npm run ship:staging -- --sha <sha>         ship a specific commit
 *   npm run ship:staging -- --gate-only         run the gate, do not deploy
 *   npm run ship:staging -- --skip-gate --reason "..."   documented emergency
 *   npm run ship:staging -- --rollback          restore the previous release
 *
 * Full flow: docs/workflows/ship-from-laptop.md
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// --------------------------------------------------------------------- //
// Constants
// --------------------------------------------------------------------- //

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// `../finsoft-wt/_ship`, anchored to the MAIN repository — not to whichever
// checkout happens to invoke this script. This tool can be run from the
// primary clone or from any worktree (ops-ship included), and worktrees in
// this project's convention all live as siblings under one `finsoft-wt/`
// next to the primary clone. `git rev-parse --git-common-dir` always
// resolves to the primary clone's `.git`, shared by every worktree, so this
// is correct regardless of where `node tools/ship/staging.mjs` was typed —
// naively resolving from REPO_ROOT alone would nest `finsoft-wt/finsoft-wt`
// when run from inside a worktree already under `finsoft-wt/`.
function resolveWorktreeDir() {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  const commonDir = (r.stdout ?? '').trim()
  const mainRepoRoot = r.status === 0 && commonDir ? path.dirname(commonDir) : REPO_ROOT
  return path.resolve(mainRepoRoot, '..', 'finsoft-wt', '_ship')
}
const WORKTREE_DIR = resolveWorktreeDir()

const SSH_ALIAS = 'vps' // ~/.ssh/config: root@31.220.74.159, key id_ed25519
const APP_DIR = '/opt/finsoft'
// The staging HTTPS origin — matches ci.yml's `vars.STAGING_URL` exactly,
// with the same "no bare-IP fallback" reasoning: infrastructure/staging/
// Caddyfile (FORBIDDEN for this tool to touch) has exactly one site block,
// for the hostname `31-220-74-159.sslip.io`; it dispatches by Host header,
// and a request for the bare IP matches only the catch-all redirect to this
// origin. Smoke-testing the bare IP would not be a degraded test, it would
// be testing a redirect and nothing else (docs/workflows/ci-tiers.md).
const SMOKE_BASE_URL = 'https://31-220-74-159.sslip.io'
const REPO_SLUG = 'elitebytesolutions/finsoft'

// --------------------------------------------------------------------- //
// Small helpers
// --------------------------------------------------------------------- //

const nowIso = () => new Date().toISOString()
const stamp = () => nowIso().replace(/[:.]/g, '-')

function heading(text) {
  console.log(`\n\x1b[1m== ${text} ==\x1b[0m`)
}
function warn(text) {
  console.log(`\x1b[33m${text}\x1b[0m`)
}
function bigWarning(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 4
  console.log('\x1b[41m\x1b[37m' + '#'.repeat(width) + '\x1b[0m')
  for (const l of lines) console.log(`\x1b[41m\x1b[37m# ${l.padEnd(width - 4)} #\x1b[0m`)
  console.log('\x1b[41m\x1b[37m' + '#'.repeat(width) + '\x1b[0m')
}
function fail(text) {
  console.error(`\n\x1b[31m✗ ${text}\x1b[0m`)
}
function ok(text) {
  console.log(`\x1b[32m✓ ${text}\x1b[0m`)
}

// On Windows, npm/npx resolve to .cmd shims that CreateProcess cannot exec
// directly — they need cmd.exe. Everything else here (git, ssh, scp, docker,
// bash, node) is a real executable and is spawned directly, with NO shell,
// so Node's own argv-to-command-line escaping applies and a path containing
// a space (this repository's own checkout does: "...\saim javed\...") is
// passed correctly instead of being split apart.
//
// `shell: true` combined with an args array is deprecated for exactly this
// reason (DEP0190): the shell concatenates, it does not escape. So the one
// place a shell is required builds a single, explicitly-quoted command
// string instead of handing shell:true an args array.
const NEEDS_SHELL = new Set(['npm', 'npx'])

function quoteArg(arg) {
  const s = String(arg)
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return process.platform === 'win32'
    ? `"${s.replace(/"/g, '\\"')}"`
    : `'${s.replace(/'/g, `'\\''`)}'`
}

/** Runs a command with output streamed live AND captured (tail only, for
 * parsing counts and for the evidence file). Never used for anything that
 * might carry a secret in its output. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const start = Date.now()
    const useShell = process.platform === 'win32' && NEEDS_SHELL.has(cmd)
    const child = useShell
      ? spawn([cmd, ...args].map(quoteArg).join(' '), {
          cwd: opts.cwd ?? REPO_ROOT,
          env: opts.env ?? process.env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(cmd, args, {
          cwd: opts.cwd ?? REPO_ROOT,
          env: opts.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
    let out = ''
    let err = ''
    const cap = (buf, chunk) => {
      const s = buf + chunk
      return s.length > 400_000 ? s.slice(s.length - 400_000) : s
    }
    child.stdout.on('data', (d) => {
      if (!opts.quiet) process.stdout.write(d)
      out = cap(out, d.toString())
    })
    child.stderr.on('data', (d) => {
      if (!opts.quiet) process.stderr.write(d)
      err = cap(err, d.toString())
    })
    child.on('close', (code) => resolve({ code, out, err, durationMs: Date.now() - start }))
    child.on('error', (e) =>
      resolve({ code: -1, out, err: err + '\n' + String(e), durationMs: Date.now() - start }),
    )
  })
}

function gitSync(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? REPO_ROOT, encoding: 'utf8' })
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}
async function findFreePort(start) {
  let p = start
  while (!(await isPortFree(p))) p++
  return p
}

/** Runs a command on the staging host. `stdin` defaults to closed (`-n`) —
 * deploy.sh already guards the migrate step, but nothing here should ever
 * depend on a remote command NOT reading the rest of a piped stream. */
async function sshRun(remoteCmd, { pipeStdin = false, quiet = false } = {}) {
  const args = pipeStdin ? [SSH_ALIAS, remoteCmd] : ['-n', SSH_ALIAS, remoteCmd]
  return run('ssh', args, { quiet })
}
async function sshRunChecked(remoteCmd, label, opts = {}) {
  const r = await sshRun(remoteCmd, opts)
  if (r.code !== 0) throw new Error(`${label} failed on staging host (exit ${r.code})`)
  return r
}

function parseTestCounts(output) {
  const bits = []
  const testFiles = output.match(/Test Files\s+([^\n]+)/)
  const tests = output.match(/(?:^|\n)\s*Tests\s+([^\n]+)/)
  const pw = output.match(/(\d+)\s+passed(?:\s*\((\d+(?:\.\d+)?m?s)\))?/)
  if (testFiles) bits.push(`files: ${testFiles[1].trim()}`)
  if (tests) bits.push(`tests: ${tests[1].trim()}`)
  if (!testFiles && !tests && pw) bits.push(`${pw[1]} passed`)
  return bits.length ? bits.join(', ') : null
}

// --------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------- //

function parseArgs(argv) {
  const args = {
    sha: null,
    skipGate: false,
    reason: null,
    gateOnly: false,
    rollback: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sha') args.sha = argv[++i]
    else if (a === '--skip-gate') args.skipGate = true
    else if (a === '--reason') args.reason = argv[++i]
    else if (a === '--gate-only') args.gateOnly = true
    else if (a === '--rollback') args.rollback = true
    else if (a === '-h' || a === '--help') args.help = true
    else {
      console.error(`Unknown argument: ${a}`)
      args.help = true
    }
  }
  return args
}

function printHelp() {
  console.log(`
ship:staging — ship a merged commit to Contabo staging from this machine.

  --sha <sha>       ship this commit instead of origin/develop HEAD.
                     Refused unless it is an ancestor of origin/develop.
  --gate-only       run the full gate and stop; do not build or deploy.
  --skip-gate       DOCUMENTED EMERGENCY ONLY. Requires --reason. Skips the
                     entire local gate. The ancestor check still applies.
  --reason "<text>" required with --skip-gate; recorded in the evidence file.
  --rollback        restore the previous .env.images on staging and restart.
                     Does not touch migrations.
  -h, --help        this text.
`)
}

// --------------------------------------------------------------------- //
// Step 1 — resolve and verify the commit
// --------------------------------------------------------------------- //

async function resolveShaOrRefuse(requestedSha) {
  heading('resolve commit')
  const fetched = await run('git', ['fetch', 'origin'])
  if (fetched.code !== 0) throw new Error('git fetch origin failed')

  const develop = gitSync(['rev-parse', 'origin/develop'])
  if (develop.code !== 0) throw new Error('could not resolve origin/develop')

  let sha = requestedSha
  if (!sha) {
    sha = develop.out
    console.log(`shipping origin/develop HEAD: ${sha}`)
  } else {
    const verify = gitSync(['rev-parse', '--verify', `${sha}^{commit}`])
    if (verify.code !== 0) {
      fail(`${sha} is not a commit this repository knows about (did you fetch?)`)
      throw new Error('unknown commit')
    }
    sha = verify.out
    console.log(`shipping requested commit: ${sha}`)
  }

  const ancestor = gitSync(['merge-base', '--is-ancestor', sha, 'origin/develop'])
  if (ancestor.code !== 0) {
    fail(`REFUSED: ${sha} is not an ancestor of origin/develop (${develop.out}).`)
    console.error(
      '  Humans merge; this tool never ships an unmerged branch. Open a PR,\n' +
        '  get it merged to develop, then ship develop (or its merge commit).',
    )
    throw new Error('sha is not merged')
  }
  ok(`${sha} is an ancestor of origin/develop — merged, ship-eligible`)
  return sha
}

// --------------------------------------------------------------------- //
// Step 2 — worktree
// --------------------------------------------------------------------- //

async function setupWorktree(sha) {
  heading('worktree')
  fs.mkdirSync(path.dirname(WORKTREE_DIR), { recursive: true })

  const list = gitSync(['worktree', 'list', '--porcelain']).out
  const normalized = WORKTREE_DIR.replace(/\\/g, '/')
  const registered = list
    .split('\n\n')
    .some((block) => block.split('\n')[0] === `worktree ${normalized}`)

  if (registered && fs.existsSync(WORKTREE_DIR)) {
    console.log(`reusing existing worktree at ${WORKTREE_DIR}`)
    await run('git', ['fetch', 'origin'], { cwd: WORKTREE_DIR })
    const co = await run('git', ['checkout', '--force', '--detach', sha], { cwd: WORKTREE_DIR })
    if (co.code !== 0) throw new Error('worktree checkout failed')
    const reset = await run('git', ['reset', '--hard', sha], { cwd: WORKTREE_DIR })
    if (reset.code !== 0) throw new Error('worktree reset failed')
    // Full clean, including node_modules: the PO's dirty checkout is never
    // used, and this must be as fresh as a CI runner. npm ci reinstalls.
    const clean = await run('git', ['clean', '-fdx'], { cwd: WORKTREE_DIR })
    if (clean.code !== 0) throw new Error('worktree clean failed')
  } else {
    console.log(`creating worktree at ${WORKTREE_DIR}`)
    const add = await run('git', ['worktree', 'add', '--detach', WORKTREE_DIR, sha])
    if (add.code !== 0) throw new Error('git worktree add failed')
  }
  ok(`worktree clean at ${sha}`)

  heading('npm ci')
  const ci = await run('npm', ['ci'], { cwd: WORKTREE_DIR })
  if (ci.code !== 0) throw new Error('npm ci failed')
  ok('dependencies installed')
}

// --------------------------------------------------------------------- //
// Step 3 — the gate
// --------------------------------------------------------------------- //

async function secretScanStep(cwd) {
  const local = await run('bash', ['tools/security/secret-scan.sh'], { cwd })
  if (local.code === 0) return { pass: true, detail: 'gitleaks (pinned binary, checksum-verified)' }

  // tools/security/secret-scan.sh's own header is explicit that this is
  // deliberate: a real finding and a broken scanner both `exit 1`, but they
  // are reported differently on purpose ("SECRETS DETECTED" vs "SCANNER
  // ERROR:") so the two cases can be told apart. This pinned binary is a
  // linux_x64 tarball — on this Windows/Git Bash laptop it downloads and
  // checksums fine and then cannot execute at all ("gitleaks binary will not
  // run"), which is a SCANNER ERROR, not a finding, and is exactly the case
  // the docker fallback exists for.
  const scannerBroken = /SCANNER ERROR:/.test(local.out + local.err)
  if (!scannerBroken) {
    // A real finding ("SECRETS DETECTED") — do not paper over it with the
    // docker fallback.
    return { pass: false, detail: 'gitleaks (pinned binary) reported a failure — see output above' }
  }

  warn(
    '\n  the pinned gitleaks binary could not run in this environment (wrong platform,\n' +
      '  or no network to GitHub releases).\n' +
      '  Falling back to the zricethezav/gitleaks docker image, as the OPS-003 brief\n' +
      '  requires when the pinned local binary is unavailable. This path is LESS\n' +
      '  verified than the pinned+checksummed binary CI uses — it pulls "latest".\n',
  )
  const dockerScan = await run('docker', [
    'run',
    '--rm',
    '-v',
    `${cwd.replace(/\\/g, '/')}:/repo`,
    'zricethezav/gitleaks:latest',
    'detect',
    '--source=/repo',
    '--redact',
    '--verbose',
    '--exit-code',
    '1',
  ])
  return {
    pass: dockerScan.code === 0,
    detail:
      dockerScan.code === 0
        ? 'gitleaks (docker fallback — pinned binary unavailable, see warning above)'
        : 'gitleaks (docker fallback) found secrets or failed to run',
  }
}

// GAP-002's blocking half, and there is exactly one canonical implementation
// of it: tools/ci/audit-gate.mjs against tools/ci/audit-allowlist.json (an
// owner, a written rationale and a live reviewBy date per entry — currently
// one postcss-via-next entry, Security Guardian, reviewBy 2026-10-27). CI's
// own `audit-gate` job is just `npm run audit:gate`; this tool calls the
// exact same script rather than keeping a second copy of the policy that
// could drift from the first. Any HIGH/CRITICAL finding not on that
// allowlist fails the ship.
async function auditStep(cwd) {
  const r = await run('npm', ['run', 'audit:gate'], { cwd })
  return {
    pass: r.code === 0,
    detail:
      r.code === 0 ? 'npm run audit:gate — see tools/ci/audit-allowlist.json' : `exit ${r.code}`,
  }
}

async function runGate(sha) {
  const cwd = WORKTREE_DIR
  const steps = []
  let ports
  let projectName
  let aborted = false

  const record = async (name, fn) => {
    if (aborted) {
      steps.push({ name, status: 'skipped', durationMs: 0, detail: 'earlier step failed' })
      return
    }
    heading(name)
    const start = Date.now()
    let result
    try {
      result = await fn()
      // Verification-only fault injection (OPS-003 §Verify: prove a failing
      // gate step aborts the ship, without committing a broken test to any
      // real branch or file — a worktree reset would just discard that).
      // SHIP_TEST_FORCE_FAIL=<substring> forces the first matching step to
      // fail AFTER it has actually run. Unset in every real ship. It can only
      // turn a pass into a failure, never the reverse, so it cannot weaken
      // the gate — it can only be used to prove the gate stops.
      const forceFail = process.env.SHIP_TEST_FORCE_FAIL
      if (forceFail && name.includes(forceFail)) {
        result = {
          pass: false,
          detail: `FORCED FAILURE for verification (SHIP_TEST_FORCE_FAIL=${forceFail})`,
        }
      }
    } catch (e) {
      result = { pass: false, detail: String(e?.message ?? e) }
    }
    const durationMs = Date.now() - start
    if (result.pass) {
      ok(`${name} — ${result.detail ?? 'passed'} (${(durationMs / 1000).toFixed(1)}s)`)
      steps.push({ name, status: 'pass', durationMs, detail: result.detail ?? null })
    } else {
      fail(`${name} — ${result.detail ?? 'failed'}`)
      steps.push({ name, status: 'fail', durationMs, detail: result.detail ?? null })
      aborted = true
    }
  }

  const npmStep = (name, script, args = []) =>
    record(name, async () => {
      const r = await run('npm', ['run', script, ...args], { cwd })
      return { pass: r.code === 0, detail: parseTestCounts(r.out) ?? `exit ${r.code}` }
    })

  // ---- phase 1: static, no data plane (mirrors ci.yml's `static`,
  // `secrets`, `unit` and `web-preview` jobs — none of these need a
  // database since OPS-002 moved the one DB-touching workspace test into
  // tests/integration/) ---------------------------------------------------
  await record('secret scan (history)', () => secretScanStep(cwd))
  await npmStep('typecheck', 'typecheck')
  await npmStep('lint', 'lint')
  await npmStep('format:check', 'format:check')
  await npmStep('module boundaries (depcruise)', 'depcruise')
  await npmStep('runtime smoke (entrypoints load under plain node)', 'smoke')
  await npmStep('migration ledger', 'db:migrate:verify')
  await npmStep('git hooks installed', 'hooks:verify')
  await npmStep('ci tooling tests (tools/ci/classify)', 'test:ci-tools')
  await npmStep('unit tests (all workspaces, no database)', 'test', [
    '--workspaces',
    '--if-present',
  ])
  await npmStep('web build', 'build', ['--workspace', '@finsoft/web'])

  // ---- phase 2: fresh throwaway data plane -----------------------------
  await record('provision throwaway compose project', async () => {
    const base = 25000 + (process.pid % 4000)
    const p1 = await findFreePort(base)
    const p2 = await findFreePort(p1 + 1)
    const p3 = await findFreePort(p2 + 1)
    const p4 = await findFreePort(p3 + 1)
    const p5 = await findFreePort(p4 + 1)
    ports = { postgres: p1, postgresTest: p2, redis: p3, redisTest: p4, adminer: p5 }
    projectName = `finsoft-ship-${sha.slice(0, 12)}-${process.pid}`

    const example = fs.readFileSync(path.join(cwd, '.env.example'), 'utf8')
    const overrides = {
      COMPOSE_PROJECT_NAME: projectName,
      COMPOSE_PROFILES: '', // no adminer in an unattended gate run
      POSTGRES_PORT: String(ports.postgres),
      POSTGRES_TEST_PORT: String(ports.postgresTest),
      REDIS_PORT: String(ports.redis),
      REDIS_TEST_PORT: String(ports.redisTest),
      ADMINER_PORT: String(ports.adminer),
      DATABASE_URL: `postgresql://finsoft_app:local-dev-only-app@localhost:${ports.postgres}/finsoft`,
      MIGRATION_DATABASE_URL: `postgresql://finsoft_migration:local-dev-only-migration@localhost:${ports.postgres}/finsoft`,
      TEST_DATABASE_URL: `postgresql://finsoft_app:local-dev-only-app@localhost:${ports.postgresTest}/finsoft_test`,
      TEST_MIGRATION_DATABASE_URL: `postgresql://finsoft_migration:local-dev-only-migration@localhost:${ports.postgresTest}/finsoft_test`,
      REDIS_URL: `redis://localhost:${ports.redis}`,
      TEST_REDIS_URL: `redis://localhost:${ports.redisTest}`,
    }
    let out = example
    for (const [k, v] of Object.entries(overrides)) {
      const re = new RegExp(`^${k}=.*$`, 'm')
      out = re.test(out) ? out.replace(re, `${k}=${v}`) : `${out}\n${k}=${v}\n`
    }
    fs.writeFileSync(path.join(cwd, '.env'), out)
    return { pass: true, detail: `project ${projectName}, ports ${p1}/${p2}/${p3}/${p4}` }
  })

  // Belt and braces: a leftover stack under the same name from a killed
  // previous run must not corrupt this one.
  await run('docker', ['compose', 'down', '-v'], { cwd, quiet: true })

  await npmStep('data plane up (fresh, from empty)', 'db:up', ['--', '--wait'])
  // db:up is `docker compose up -d`; --wait is appended above so migrations
  // never race a starting database, exactly like every DB-touching job in
  // ci.yml (`invariants`, `db-suites`, `financial`, `e2e`) does with its own
  // `docker compose up -d --wait` — this tool brings the data plane up ONCE
  // and reuses it across all of them, which is a legitimate local speedup:
  // it is still fresh-from-empty for every one of those suites.
  await npmStep('data plane assertions (RLS, roles, no BYPASSRLS on finsoft_app)', 'db:verify')
  await npmStep('migrate', 'db:migrate')
  await npmStep('migrate test cluster', 'db:migrate:test')
  await record('schema types match the migrated database', async () => {
    const gen = await run('npm', ['run', 'db:codegen'], { cwd })
    if (gen.code !== 0) return { pass: false, detail: 'db:codegen failed' }
    const diff = await run(
      'git',
      ['diff', '--quiet', '--', 'packages/database/src/generated/schema.d.ts'],
      {
        cwd,
      },
    )
    return diff.code === 0
      ? { pass: true, detail: 'generated/schema.d.ts matches the migrated database' }
      : { pass: false, detail: 'generated/schema.d.ts is STALE — run db:codegen and commit it' }
  })

  // ---- phase 3: the suites, mirroring ci.yml's `invariants` (LEVEL 0,
  // NON_NEGOTIABLES.md §3 — never scoped by risk tier), `db-suites`,
  // `financial` and `e2e` jobs ---------------------------------------------
  await npmStep('FinancialInvariantSuite (every ship — LEVEL 0)', 'test:financial-invariant-suite')
  await npmStep(
    'accounting suite (includes the invariant suite again — harmless)',
    'test:accounting',
  )
  await npmStep('reconciliation', 'test:reconciliation')
  await npmStep('db suite: schema', 'test:schema')
  await npmStep('db suite: security (tenant isolation, RBAC)', 'test:security')
  await npmStep('db suite: integration', 'test:integration')
  await npmStep('performance', 'test:performance')
  await record('playwright browser install', async () => {
    const r = await run('npx', ['playwright', 'install', '--with-deps', 'chromium'], { cwd })
    return { pass: r.code === 0, detail: r.code === 0 ? 'chromium installed' : `exit ${r.code}` }
  })
  await npmStep('e2e (Playwright, built API + real browser)', 'test:e2e')

  // ---- phase 4: dependency audit, mirroring ci.yml's `audit-gate` job ----
  await record('audit:gate (blocking — production deps, GAP-002)', () => auditStep(cwd))

  // ---- teardown, always --------------------------------------------------
  await run('docker', ['compose', 'down', '-v'], { cwd, quiet: true })

  const skippedCodeQL = {
    name: 'CodeQL (SAST)',
    reason:
      'CodeQL Action is a GitHub-hosted analysis; there is no free local equivalent to run here',
  }

  return { steps, passed: !aborted, skipped: [skippedCodeQL] }
}

// --------------------------------------------------------------------- //
// Step 4 — build on the server
// --------------------------------------------------------------------- //

async function streamArchiveToServer(sha, remoteDir) {
  await sshRunChecked(`rm -rf ${remoteDir} && mkdir -p ${remoteDir}`, 'prepare remote build dir')
  return new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', sha], { cwd: REPO_ROOT })
    // No -n here: this ssh process's stdin IS the tar stream, deliberately.
    const remote = spawn('ssh', [SSH_ALIAS, `tar -x -C ${remoteDir}`], {
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    archive.stdout.pipe(remote.stdin)
    archive.stderr.on('data', (d) => process.stderr.write(d))
    let settled = false
    const done = (err) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    archive.on('error', done)
    remote.on('error', done)
    remote.on('close', (code) =>
      code === 0 ? done() : done(new Error(`remote tar extraction exit ${code}`)),
    )
  })
}

async function buildImagesOnServer(sha) {
  heading('build on server')
  const remoteDir = `${APP_DIR}/build/${sha}`
  console.log(`streaming git archive of ${sha} to ${SSH_ALIAS}:${remoteDir} ...`)
  await streamArchiveToServer(sha, remoteDir)
  ok('source streamed (tracked files only — no .git, no node_modules)')

  const buildScript = `#!/usr/bin/env bash
set -euo pipefail
SHA="$1"; REPO_SLUG="$2"
cd "${remoteDir}"
NODE_VERSION=$(cat .nvmrc)
CREATED=$(date -u +%FT%TZ)
for IMAGE in api worker web; do
  echo "--- building finsoft-$IMAGE:$SHA ---"
  docker build \\
    -f "infrastructure/docker/Dockerfile.$IMAGE" \\
    --build-arg NODE_VERSION="$NODE_VERSION" \\
    --label "org.opencontainers.image.source=https://github.com/$REPO_SLUG" \\
    --label "org.opencontainers.image.revision=$SHA" \\
    --label "org.opencontainers.image.created=$CREATED" \\
    -t "finsoft-$IMAGE:$SHA" \\
    .
done
`
  const localScriptPath = path.join(WORKTREE_DIR, '.ship-evidence', 'build-images.sh')
  fs.mkdirSync(path.dirname(localScriptPath), { recursive: true })
  fs.writeFileSync(localScriptPath, buildScript)
  const scp1 = await run('scp', [localScriptPath, `${SSH_ALIAS}:${remoteDir}/build-images.sh`])
  if (scp1.code !== 0) throw new Error('scp build-images.sh failed')

  const build = await sshRun(`bash ${remoteDir}/build-images.sh ${sha} ${REPO_SLUG}`)
  if (build.code !== 0) throw new Error('docker build failed on staging host')
  ok('all three images built: finsoft-{api,worker,web}:' + sha)

  await sshRun(`rm -rf ${remoteDir}`)
  ok('build context cleaned up on the server (images kept)')
}

async function pruneOldLocalImages() {
  heading('prune old local images (keep last 3 SHAs)')
  const script = `
for IMAGE in api worker web; do
  docker images "finsoft-$IMAGE" --format '{{.Tag}}\\t{{.CreatedAt}}' \\
    | sort -k2 -r | cut -f1 | grep -v '<none>' | tail -n +4 \\
    | while read -r TAG; do
        echo "pruning finsoft-$IMAGE:$TAG"
        docker rmi "finsoft-$IMAGE:$TAG" >/dev/null 2>&1 || true
      done
done
docker image prune -f --filter 'dangling=true' >/dev/null 2>&1 || true
`
  await sshRun(script)
  ok('pruned; last 3 SHAs kept for rollback')
}

// --------------------------------------------------------------------- //
// Step 5 — deploy
// --------------------------------------------------------------------- //

async function readRemoteEnvImages() {
  // .env.images holds only image references and APP_VERSION — no
  // credentials. It is safe to read and safe to print (unlike .env).
  const r = await sshRun(`cat ${APP_DIR}/.env.images 2>/dev/null || true`, { quiet: true })
  return r.out
}

async function deployLocalImages(sha, previousEnvImages) {
  heading('deploy (local-images mode)')
  await sshRunChecked(`install -d -o deploy -g deploy ${APP_DIR}/deploys`, 'prepare deploys dir')
  if (previousEnvImages.trim()) {
    const tmp = path.join(WORKTREE_DIR, '.ship-evidence', 'last-good.env.images')
    fs.writeFileSync(tmp, previousEnvImages)
    const scp = await run('scp', [tmp, `${SSH_ALIAS}:${APP_DIR}/deploys/last-good.env.images`])
    if (scp.code !== 0) throw new Error('failed to store rollback checkpoint on server')
    ok('previous .env.images checkpointed for rollback')
  } else {
    warn('no existing .env.images on the server — first deploy, nothing to roll back to')
  }

  // From REPO_ROOT — this tool's OWN checkout — not from WORKTREE_DIR (the
  // target SHA's checkout). deploy.sh's IMAGE_SOURCE=local support is part
  // of the SHIPPING MECHANISM (OPS-003), not of the application artefact
  // being shipped, and a target commit that predates this tool's own branch
  // has no such support in its tree — deploying that copy fails with
  // "REGISTRY_TOKEN: parameter null or not set" because it still requires
  // GHCR credentials unconditionally. Found by running this for real: the
  // first end-to-end attempt failed exactly this way, deploying nothing,
  // before this fix.
  const scpDeploy = await run('scp', [
    path.join(REPO_ROOT, 'infrastructure/staging/deploy.sh'),
    `${SSH_ALIAS}:${APP_DIR}/deploy.sh`,
  ])
  if (scpDeploy.code !== 0) throw new Error('failed to copy deploy.sh to the staging host')
  const deploy = await sshRun(
    `IMAGE_SOURCE=local SHA=${sha} REPO=${REPO_SLUG} bash ${APP_DIR}/deploy.sh`,
  )
  if (deploy.code !== 0) throw new Error('deploy.sh failed on staging host')
  ok(`deployed: APP_VERSION=${sha}`)
}

async function restoreEnvImagesAndRestart(envImagesContent) {
  const tmp = path.join(WORKTREE_DIR, '.ship-evidence', 'restore.env.images')
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, envImagesContent)
  await run('scp', [tmp, `${SSH_ALIAS}:${APP_DIR}/.env.images`])
  // Restart only. Never re-run migrate on a rollback.
  await sshRun(
    `cd ${APP_DIR} && docker compose --env-file .env --env-file .env.images up -d --remove-orphans`,
  )
}

// --------------------------------------------------------------------- //
// Step 6 — smoke
// --------------------------------------------------------------------- //

async function smokeTest(baseUrl) {
  heading('smoke test')
  // Deviation from the OPS-003 brief, noted here and in the evidence file:
  // the brief's smoke checks assume https://<host>.sslip.io with a login
  // page and JWKS. The Caddyfile (FORBIDDEN for this task to change) is
  // HTTP-only, IP-addressed, and this stage has no /login or JWKS route
  // wired up yet. Reusing infrastructure/staging/smoke.sh unmodified over
  // http://31.220.74.159 satisfies the literal instruction — "the same
  // checks as CI's smoke step" — because that script IS CI's smoke step
  // (ci.yml: `bash infrastructure/staging/smoke.sh "http://$HOST"`).
  const r = await run('bash', [path.join(WORKTREE_DIR, 'infrastructure/staging/smoke.sh'), baseUrl])
  return { pass: r.code === 0, out: r.out, err: r.err }
}

// --------------------------------------------------------------------- //
// Evidence
// --------------------------------------------------------------------- //

async function writeEvidence(record) {
  const filename = `${stamp()}-${record.sha}.json`
  const local = path.join(WORKTREE_DIR, '.ship-evidence', filename)
  fs.mkdirSync(path.dirname(local), { recursive: true })
  fs.writeFileSync(local, JSON.stringify(record, null, 2))

  const remotePath = `${APP_DIR}/deploys/${filename}`
  await sshRun(`install -d -o deploy -g deploy ${APP_DIR}/deploys`)
  const scp = await run('scp', [local, `${SSH_ALIAS}:${remotePath}`])
  return { local, remote: scp.code === 0 ? remotePath : null }
}

function printGateSummary(gate) {
  heading('gate summary')
  for (const s of gate.steps) {
    const icon = s.status === 'pass' ? '✓' : s.status === 'fail' ? '✗' : '·'
    console.log(`  ${icon} ${s.name.padEnd(55)} ${s.status.padEnd(8)} ${s.detail ?? ''}`)
  }
  for (const s of gate.skipped) console.log(`  · ${s.name.padEnd(55)} skipped  ${s.reason}`)
}

// --------------------------------------------------------------------- //
// Orchestration
// --------------------------------------------------------------------- //

async function doRollback() {
  heading('rollback')
  const prev = await sshRun(`cat ${APP_DIR}/deploys/last-good.env.images 2>/dev/null || true`, {
    quiet: true,
  })
  if (!prev.out.trim()) {
    fail('no last-good.env.images checkpoint on the server — nothing to roll back to')
    process.exitCode = 1
    return
  }
  console.log('restoring previous release:')
  console.log(
    prev.out
      .split('\n')
      .filter((l) => l.startsWith('APP_VERSION'))
      .join('\n'),
  )
  await restoreEnvImagesAndRestart(prev.out)
  const smoke = await smokeTest(SMOKE_BASE_URL)
  if (smoke.pass) ok('rollback complete — smoke passed')
  else {
    fail('rollback deployed but smoke test still failing — needs a human')
    process.exitCode = 1
  }
}

async function doShip(args) {
  const startedAt = nowIso()
  const t0 = Date.now()
  const sha = await resolveShaOrRefuse(args.sha)

  let gate
  let gateDurationMs = 0

  if (args.skipGate) {
    bigWarning([
      'EMERGENCY: --skip-gate is set. The full local gate is NOT running.',
      `Reason: ${args.reason}`,
      'This is recorded in the evidence file. Use this only for a documented',
      'emergency — see docs/workflows/ship-from-laptop.md.',
    ])
    gate = {
      steps: [{ name: 'GATE SKIPPED', status: 'skipped', durationMs: 0, detail: args.reason }],
      passed: true,
      skipped: [],
    }
  } else {
    await setupWorktree(sha)
    const gt0 = Date.now()
    gate = await runGate(sha)
    gateDurationMs = Date.now() - gt0
    printGateSummary(gate)
    if (!gate.passed) {
      fail('GATE FAILED — nothing will be built or deployed.')
      const record = {
        sha,
        startedAt,
        finishedAt: nowIso(),
        gate: { ...gate, durationMs: gateDurationMs },
        build: null,
        deploy: null,
        smoke: null,
        rollback: null,
        result: 'gate-failed',
      }
      await writeEvidence(record)
      process.exitCode = 1
      return
    }
  }

  if (args.gateOnly) {
    ok('gate-only run complete — not building or deploying')
    await writeEvidence({
      sha,
      startedAt,
      finishedAt: nowIso(),
      gate: { ...gate, durationMs: gateDurationMs },
      build: null,
      deploy: null,
      smoke: null,
      rollback: null,
      result: 'gate-only',
    })
    return
  }

  // ---- build -------------------------------------------------------------
  let buildOk = true
  let buildError = null
  try {
    await buildImagesOnServer(sha)
  } catch (e) {
    buildOk = false
    buildError = String(e?.message ?? e)
  }
  if (!buildOk) {
    fail(`BUILD FAILED: ${buildError}`)
    await writeEvidence({
      sha,
      startedAt,
      finishedAt: nowIso(),
      gate: { ...gate, durationMs: gateDurationMs },
      build: { pass: false, detail: buildError },
      deploy: null,
      smoke: null,
      rollback: null,
      result: 'build-failed',
    })
    process.exitCode = 1
    return
  }

  // ---- deploy --------------------------------------------------------------
  const previousEnvImages = await readRemoteEnvImages()
  let deployOk = true
  let deployError = null
  try {
    await deployLocalImages(sha, previousEnvImages)
  } catch (e) {
    deployOk = false
    deployError = String(e?.message ?? e)
  }
  if (!deployOk) {
    fail(`DEPLOY FAILED: ${deployError}`)
    await writeEvidence({
      sha,
      startedAt,
      finishedAt: nowIso(),
      gate: { ...gate, durationMs: gateDurationMs },
      build: { pass: true },
      deploy: { pass: false, detail: deployError },
      smoke: null,
      rollback: null,
      result: 'deploy-failed',
    })
    process.exitCode = 1
    return
  }

  // ---- smoke ---------------------------------------------------------------
  const smoke = await smokeTest(SMOKE_BASE_URL)
  let rollbackInfo
  if (!smoke.pass) {
    fail('SMOKE FAILED — rolling back automatically')
    if (previousEnvImages.trim()) {
      await restoreEnvImagesAndRestart(previousEnvImages)
      const recheck = await smokeTest(SMOKE_BASE_URL)
      rollbackInfo = {
        triggered: true,
        restoredTo: previousEnvImages.match(/APP_VERSION=(\S+)/)?.[1] ?? null,
        recheckPassed: recheck.pass,
      }
      if (recheck.pass) ok('rolled back — previous release is healthy again')
      else
        fail(
          'rollback deployed but the PREVIOUS release is also failing smoke — needs a human, now',
        )
    } else {
      rollbackInfo = {
        triggered: false,
        reason: 'no previous .env.images to roll back to (first deploy)',
      }
      fail('no previous release to roll back to')
    }
    await writeEvidence({
      sha,
      startedAt,
      finishedAt: nowIso(),
      gate: { ...gate, durationMs: gateDurationMs },
      build: { pass: true },
      deploy: { pass: true },
      smoke: { pass: false },
      rollback: rollbackInfo,
      result: 'smoke-failed-rolled-back',
    })
    process.exitCode = 1
    return
  }

  ok('smoke passed')
  await pruneOldLocalImages()

  const evidence = await writeEvidence({
    sha,
    startedAt,
    finishedAt: nowIso(),
    gate: { ...gate, durationMs: gateDurationMs },
    build: { pass: true },
    deploy: { pass: true },
    smoke: { pass: true },
    rollback: null,
    result: 'shipped',
  })

  heading('DONE')
  console.log(`  sha:          ${sha}`)
  console.log(`  gate:         ${(gateDurationMs / 1000 / 60).toFixed(1)} min`)
  console.log(`  total:        ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`)
  console.log(`  staging:      ${SMOKE_BASE_URL}`)
  console.log(`  evidence:     ${evidence.local}`)
  console.log(`  evidence (server): ${evidence.remote ?? '(scp failed, kept locally only)'}`)
}

// --------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------- //

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return printHelp()
  if (args.skipGate && !args.reason) {
    fail('--skip-gate requires --reason "<why this is a documented emergency>"')
    process.exitCode = 1
    return
  }
  if (args.rollback) return doRollback()
  return doShip(args)
}

main().catch((e) => {
  fail(String(e?.stack ?? e))
  process.exitCode = 1
})
