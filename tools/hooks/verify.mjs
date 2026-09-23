#!/usr/bin/env node
/*
 * Confirm the pre-push hook is actually active.
 *
 * A hook that is present but not wired up is worse than no hook, because it
 * looks like protection. This asserts the thing that matters — that git will
 * run it — rather than that a file exists.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'

const problems = []

let hooksPath = ''
try {
  hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch {
  /* unset */
}

if (hooksPath !== '.githooks') {
  problems.push(
    `core.hooksPath is "${hooksPath || '(unset)'}", expected ".githooks". Run: npm run hooks:install`,
  )
}

if (!existsSync('.githooks/pre-push')) {
  problems.push('.githooks/pre-push does not exist')
} else if (process.platform !== 'win32') {
  // Git for Windows ignores the executable bit, so checking it there would
  // fail on a correctly configured clone.
  try {
    accessSync('.githooks/pre-push', constants.X_OK)
  } catch {
    problems.push('.githooks/pre-push is not executable: chmod +x .githooks/pre-push')
  }
}

if (problems.length > 0) {
  console.error('\n  pre-push hook is NOT active:')
  for (const p of problems) console.error(`    - ${p}`)
  console.error(
    '\n  Without it nothing local stops a direct push to main or develop, and\n' +
      '  GitHub branch protection is unavailable on this plan.\n',
  )
  process.exit(1)
}

console.log('  pre-push hook active: direct pushes to main and develop are refused')
