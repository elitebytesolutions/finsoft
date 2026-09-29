#!/usr/bin/env node
/*
 * OPS-002 — risk-tiered CI classification.
 *
 * Looks at which files changed relative to a base ref (default: the
 * merge-base with origin/develop) and decides:
 *   - the risk tier (T0..T3, highest matching tier wins, unknown path fails
 *     safe UP to T1 — never down)
 *   - which of the three deployable images need rebuilding
 *   - whether apps/web, apps/api or apps/worker themselves changed
 *   - which optional CI jobs are worth running (db-suites, financial, e2e,
 *     web-preview, CodeQL)
 *
 * Used three ways:
 *   1. `classify` job in .github/workflows/ci.yml, with --github-output.
 *   2. `npm run check` (tools/ci/check.mjs), to decide what a fast local
 *      check needs to run.
 *   3. `.githooks/pre-push`, to print a notice when a push looks T2/T3.
 *
 * See docs/workflows/ci-tiers.md for the human-readable version of this.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matches, matchesAny } from './glob.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(HERE, 'risk-tiers.json')

export function loadConfig(path = CONFIG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tryGit(args) {
  try {
    return git(args)
  } catch {
    return null
  }
}

/**
 * Resolves the base ref to diff against. Tries, in order: an explicit ref,
 * the merge-base with origin/develop, the merge-base with origin/main.
 * Throws if none resolve, because a classifier that silently returned "no
 * changes" on a broken checkout would under-run every gate it exists to run.
 */
export function resolveBase(explicitRef) {
  if (explicitRef) {
    const base = tryGit(['merge-base', explicitRef, 'HEAD'])
    if (base) return base
    throw new Error(`could not resolve a merge-base between "${explicitRef}" and HEAD`)
  }
  for (const ref of ['origin/develop', 'origin/main']) {
    const base = tryGit(['merge-base', ref, 'HEAD'])
    if (base) return base
  }
  throw new Error(
    'could not resolve a base ref (tried origin/develop, origin/main). ' +
      'Pass --base explicitly, or fetch with more history (fetch-depth: 0).',
  )
}

/** Repo-relative, forward-slash paths, whatever the platform. */
function normalise(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function changedFilesFromGit(base) {
  const out = tryGit(['diff', '--name-only', '--diff-filter=ACMRTD', `${base}`, 'HEAD'])
  if (out === null) throw new Error(`git diff against "${base}" failed`)
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(normalise)
}

function refBranchName(ref) {
  if (!ref) return ''
  return ref.replace(/^refs\/heads\//, '')
}

/**
 * @param {{ cliFull?: boolean, eventName?: string, ref?: string, config: object }} opts
 */
export function computeFull({ cliFull, eventName, ref, config }) {
  if (cliFull === true) return { full: true, reason: '--full was passed' }
  if (cliFull === false) return { full: false, reason: '--no-full was passed' }

  if (eventName === 'schedule') return { full: true, reason: 'scheduled (nightly) run' }
  if (eventName === 'workflow_dispatch') return { full: true, reason: 'manual workflow_dispatch' }

  const branch = refBranchName(ref)
  if (branch && config.fullRefs.branches.includes(branch)) {
    return { full: true, reason: `push to protected branch "${branch}"` }
  }
  if (branch && config.fullRefs.branchPrefixes.some((p) => branch.startsWith(p))) {
    return { full: true, reason: `push to a release branch "${branch}"` }
  }
  return { full: false, reason: 'ordinary feature branch / pull request' }
}

function globEntries(section) {
  return Object.entries(section).filter(([key]) => key !== 'comment')
}

/**
 * @param {readonly string[]} files
 * @param {object} config
 */
export function classifyTier(files, config) {
  const order = config.tierOrder
  const perFile = []
  let overallIdx = 0
  let sawUnknown = false

  for (const file of files) {
    let bestIdx = -1
    let bestLabel = null
    for (let i = 0; i < order.length; i++) {
      const tier = order[i]
      if (matches(file, config.tiers[tier].globs)) {
        bestIdx = i
        bestLabel = config.tiers[tier].label
      }
    }
    if (bestIdx === -1) {
      // Unknown path. Fail safe UP to T1, never down to T0.
      sawUnknown = true
      bestIdx = order.indexOf('T1')
      bestLabel = 'unmatched path — fail-safe default'
    }
    perFile.push({ file, tier: order[bestIdx], label: bestLabel })
    if (bestIdx > overallIdx) overallIdx = bestIdx
  }

  const tier = files.length === 0 ? order[0] : order[overallIdx]
  const reasons = []
  if (files.length === 0) {
    reasons.push('no changed files relative to base — treated as T0')
  } else {
    for (const pf of perFile) {
      if (pf.tier === tier) reasons.push(`${pf.file} → ${pf.tier} (${pf.label})`)
    }
    if (sawUnknown) {
      reasons.push('at least one changed path matched no tier glob; unmatched paths default to T1')
    }
  }

  return { tier, perFile, reasons }
}

export function classify({ files, config, cliFull, eventName, ref }) {
  const { tier, reasons: tierReasons } = classifyTier(files, config)
  const { full, reason: fullReason } = computeFull({ cliFull, eventName, ref, config })

  const images = globEntries(config.images)
    .filter(([, globs]) => matchesAny(files, globs))
    .map(([name]) => name)

  const webChanged = matchesAny(files, config.appPaths.web)
  const apiChanged = matchesAny(files, config.appPaths.api)
  const workerChanged = matchesAny(files, config.appPaths.worker)

  const order = config.tierOrder
  const idx = order.indexOf(tier)
  const t1 = order.indexOf('T1')
  const t2 = order.indexOf('T2')

  const runDbSuites = full || idx >= t2
  const runFinancial = full || tier === 'T3'
  const runE2e = full || (idx >= t1 && (webChanged || apiChanged || workerChanged))
  const runWebPreview = !full && webChanged
  const runCodeql = full || idx >= t2

  // NON_NEGOTIABLES.md §3, LEVEL 0: "A dedicated test suite that runs on
  // EVERY PR, not nightly." A risk tier cannot waive this — it is not part
  // of the tiering at all. It runs whether the change is a one-line docs
  // fix or a posting-engine rewrite. T3's own `financial` job additionally
  // runs the REST of the financial gate (full test:accounting, reconciliation,
  // golden scenarios) — this flag is only about the invariant suite itself,
  // which the `invariants` job runs unconditionally in ci.yml.
  const runInvariants = true

  const suites = ['unit', 'invariants']
  if (runDbSuites) suites.push('db-suites')
  if (runFinancial) suites.push('financial')
  if (runE2e) suites.push('e2e')
  if (runWebPreview) suites.push('web-preview')
  if (runCodeql) suites.push('codeql')

  const reasons = [
    `tier ${tier}`,
    `full: ${full} (${fullReason})`,
    `context: event=${eventName ?? '(none)'} ref=${ref ?? '(none)'}`,
    ...tierReasons,
    `images to (re)build: ${images.length ? images.join(', ') : 'none'}`,
    `webChanged=${webChanged} apiChanged=${apiChanged} workerChanged=${workerChanged}`,
    'FinancialInvariantSuite runs on every PR regardless of tier (NON_NEGOTIABLES.md §3, LEVEL 0)',
  ]

  return {
    tier,
    full,
    images,
    suites,
    webChanged,
    apiChanged,
    workerChanged,
    runDbSuites,
    runFinancial,
    runE2e,
    runWebPreview,
    runCodeql,
    runInvariants,
    filesCount: files.length,
    reasons,
  }
}

function parseArgs(argv) {
  const args = { files: null, filesFile: null, base: null, full: null, githubOutput: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--files') args.files = argv[++i]
    else if (a === '--files-file') args.filesFile = argv[++i]
    else if (a === '--base') args.base = argv[++i]
    else if (a === '--full') args.full = true
    else if (a === '--no-full') args.full = false
    else if (a === '--github-output') args.githubOutput = true
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`unrecognised argument: ${a}`)
  }
  return args
}

function writeGithubOutput(result) {
  const path = process.env.GITHUB_OUTPUT
  const lines = [
    `tier=${result.tier}`,
    `full=${result.full}`,
    `web_changed=${result.webChanged}`,
    `api_changed=${result.apiChanged}`,
    `worker_changed=${result.workerChanged}`,
    `run_invariants=${result.runInvariants}`,
    `run_db_suites=${result.runDbSuites}`,
    `run_financial=${result.runFinancial}`,
    `run_e2e=${result.runE2e}`,
    `run_web_preview=${result.runWebPreview}`,
    `run_codeql=${result.runCodeql}`,
    `images_json=${JSON.stringify(result.images)}`,
    `suites_json=${JSON.stringify(result.suites)}`,
  ]
  if (!path) {
    console.log(lines.join('\n'))
    return
  }
  appendFileSync(path, lines.join('\n') + '\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'Usage: classify.mjs [--base <ref>] [--files a,b,c] [--files-file path] ' +
        '[--full|--no-full] [--github-output]',
    )
    return
  }

  const config = loadConfig()

  let files
  if (args.files !== null) {
    files = args.files
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
      .map(normalise)
  } else if (args.filesFile !== null) {
    files = readFileSync(args.filesFile, 'utf8')
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      .map(normalise)
  } else {
    const base = resolveBase(args.base)
    files = changedFilesFromGit(base)
  }

  const result = classify({
    files,
    config,
    cliFull: args.full,
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
  })

  if (args.githubOutput) {
    writeGithubOutput(result)
  }
  console.log(JSON.stringify(result, null, 2))
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(err.stack || err.message)
    process.exit(1)
  })
}
