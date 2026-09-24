#!/usr/bin/env node
/*
 * Runtime smoke check.
 *
 * Loads every package entrypoint in a fresh `node` process, with no
 * transpiler and no test runner, using the pinned Node from .nvmrc.
 *
 * This exists because of a specific failure. `BaseRepository` used a
 * TypeScript parameter property, which Node's strip-only mode cannot load.
 * It compiled, it linted, and it passed 200-odd tests — because Vitest
 * transpiles — while the module was unloadable by the runtime that actually
 * ships. It surfaced only when apps/api first required the package.
 *
 * `erasableSyntaxOnly` now catches that class of problem at compile time.
 * This catches the rest: a bad import specifier, a missing export, a top-level
 * await, a circular import that only deadlocks at runtime. The compiler
 * proves the syntax is erasable; only running it proves the module loads.
 *
 * Nothing here needs a database. Importing a module must not open a
 * connection, and if that ever changes this check is where it shows up.
 */

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const ENTRYPOINTS = [
  ['@finsoft/validation', 'packages/validation/src/index.ts'],
  ['@finsoft/database', 'packages/database/src/index.ts'],
  ['@finsoft/database/testing', 'packages/database/src/testing/harness.ts'],
  ['migration runner', 'packages/database/src/migrate/apply.ts'],
  ['migration verifier', 'packages/database/src/migrate/verify.ts'],
  ['codegen guard', 'packages/database/src/generate/cli.ts'],
  ['@finsoft/observability', 'packages/observability/src/index.ts'],
  /*
   * The worker's side-effect-free modules. NOT main.ts: importing it starts
   * the worker and connects to Redis, and this check must never need a
   * dependency. `runner.ts` transitively pulls in queue.ts and config.ts.
   */
  ['worker: runner', 'apps/worker/src/runner.ts'],
  ['worker: health', 'apps/worker/src/health.ts'],
]

/** CLIs, executed rather than imported: their argument handling counts too. */
const COMMANDS = [['migrate cli: verify', ['packages/database/src/migrate/cli.ts', 'verify']]]

let failed = 0

for (const [label, file] of ENTRYPOINTS) {
  const url = pathToFileURL(resolve(process.cwd(), file)).href
  try {
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', `await import(${JSON.stringify(url)})`],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000 },
    )
    console.log(`  ✓ loads under plain node   ${label}`)
  } catch (error) {
    failed++
    const detail = String(error.stderr || error.message)
      .split('\n')
      .find((l) => /Error|error/.test(l))
    console.log(`  ✗ FAILS under plain node   ${label}`)
    console.log(`      ${detail?.trim() ?? 'unknown failure'}`)
  }
}

for (const [label, args] of COMMANDS) {
  try {
    execFileSync(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
    })
    console.log(`  ✓ runs under plain node    ${label}`)
  } catch (error) {
    failed++
    console.log(`  ✗ FAILS under plain node   ${label}`)
    console.log(`      ${String(error.stderr || error.message).split('\n')[0]}`)
  }
}

console.log(
  `\n  ${ENTRYPOINTS.length + COMMANDS.length - failed}/${ENTRYPOINTS.length + COMMANDS.length} entrypoints load on node ${process.version}`,
)

if (failed > 0) {
  console.error(
    '\n  A module that compiles and passes its tests but cannot be loaded by Node\n' +
      '  is not shippable. Vitest transpiles; production does not.\n',
  )
}

process.exit(failed === 0 ? 0 : 1)
