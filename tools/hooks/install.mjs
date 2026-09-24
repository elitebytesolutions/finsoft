#!/usr/bin/env node
/*
 * Point git at the tracked hooks directory.
 *
 * Git hooks live in .git/hooks, which is not cloned — so a hook committed to
 * the repository does nothing until each clone opts in. core.hooksPath moves
 * the lookup to a tracked directory, and this runs from the `prepare` script
 * so `npm install` wires it up on every fresh clone.
 *
 * core.hooksPath is repository-level config and worktrees share it with the
 * main repository, so a new worktree inherits the hook without another step.
 *
 * Silent when there is no .git — a tarball, or a Docker build context.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

try {
  git(['rev-parse', '--git-dir'])
} catch {
  process.exit(0) // not a git checkout; nothing to install
}

if (!existsSync('.githooks/pre-push')) {
  console.error('  .githooks/pre-push is missing — hooks not installed')
  process.exit(1)
}

git(['config', 'core.hooksPath', '.githooks'])
console.log('  git hooks: core.hooksPath -> .githooks')
