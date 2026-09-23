#!/usr/bin/env node
/*
 * Defect injection: prove each control FAILS when its mechanism is removed.
 *
 * ── Why ────────────────────────────────────────────────────────────────
 *
 * A green suite proves the tests pass. It does not prove they would notice
 * the thing they were written to notice. Twice in this repository a rule
 * looked correct, passed CI every day and enforced nothing — and the second
 * time it survived the review that found the first, because the fix was
 * verified by reading the config rather than by asking what the rule had
 * ever matched.
 *
 * Graph sizes are not evidence either. "295 modules became 303" says
 * something changed; it does not say which named rule can now fire. This
 * script produces the only evidence that settles it: remove the mechanism,
 * watch the NAMED test go red, put it back.
 *
 * ── How ────────────────────────────────────────────────────────────────
 *
 * For each control: patch one file in place, run one test file, assert the
 * expected test name appears among the failures, restore the file. The
 * original bytes are held in memory and rewritten in `finally`, and the run
 * ends by asserting `git diff` is clean — if it is not, the exit code says
 * so loudly rather than leaving a half-patched tree.
 *
 * Read-only on success. Run it before accepting any change to a boundary
 * rule, a redaction path or a money primitive.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Each entry names the finding it belongs to, the exact mechanism to remove,
 * the test file that should notice, and the test name that should fail.
 *
 * `expect` is matched as a SUBSTRING of a failed test's name. It is stated
 * per entry rather than "any failure", because a patch that breaks the suite
 * for an unrelated reason — a syntax error, say — would otherwise read as
 * proof.
 */
const CONTROLS = [
  {
    id: 'R1',
    what: 'options.exclude lists node_modules, so no ^node_modules/ rule can match',
    file: '.dependency-cruiser.cjs',
    find: /path: '\^\(ui-prototype\|tools\/parity\).*',\n/,
    replace:
      "path: '(^|/)(\\\\.next|dist|coverage|node_modules|ui-prototype|tools/parity)(/|$)',\n",
    test: 'tests/security/depcruise-negative-control.spec.ts',
    expect: ['pg-driver-is-database-package-only', 'kysely-is-allowlisted', 'one-decimal-library'],
  },
  {
    id: 'R11',
    what: 'options.exclude lists dist unanchored, which matches node_modules/kysely/dist',
    file: '.dependency-cruiser.cjs',
    find: /path: '\^\(ui-prototype\|tools\/parity\).*',\n/,
    replace: "path: '(^|/)(\\\\.next|dist|coverage|ui-prototype|tools/parity)(/|$)',\n",
    test: 'tests/security/depcruise-negative-control.spec.ts',
    expect: ['kysely-is-allowlisted'],
  },
  {
    id: 'R15',
    what: 'the importer side of the logger boundary is removed',
    file: '.dependency-cruiser.cjs',
    find: /name: 'observability-importers-are-allowlisted',/,
    replace: "name: 'observability-importers-are-allowlisted-DISABLED',",
    test: 'tests/security/depcruise-negative-control.spec.ts',
    expect: ['observability-importers'], // shortened: vitest truncates long test names
  },
  {
    id: 'R13a',
    what: 'the sql.raw selector is removed',
    file: 'eslint.config.mjs',
    find: /selector: "CallExpression\[callee\.object\.name='sql'\]\[callee\.property\.name='raw'\]",/,
    replace: 'selector: "CallExpression[callee.object.name=\'__never__\']",',
    test: 'tests/security/lint-boundaries.spec.ts',
    expect: ['catches sql.raw'],
  },
  {
    id: 'R13b',
    what: 'the Kysely Migrator selector is removed',
    file: 'eslint.config.mjs',
    find: /selector: "NewExpression\[callee\.name='Migrator'\]",/,
    replace: 'selector: "NewExpression[callee.name=\'__never__\']",',
    test: 'tests/security/lint-boundaries.spec.ts',
    expect: ["catches Kysely's Migrator"],
  },
  {
    id: 'R16',
    what: 'no-console is not extended to the packages ADR-0016 rules on',
    file: 'eslint.config.mjs',
    find: /'packages\/database\/src\/\*\*\/\*\.ts',\n\s*'packages\/auth\/src\/\*\*\/\*\.ts',\n/,
    replace: "'packages/__none__/src/**/*.ts',\n",
    test: 'tests/security/lint-boundaries.spec.ts',
    expect: ['bans console.error in packages/database/src/pool.ts'],
  },
  {
    id: 'R2',
    what: 'the app.tenant_id selector matches a plain Literal only, missing the sql tag form',
    file: 'eslint.config.mjs',
    find: /TemplateElement\[value\.raw=/,
    replace: 'TemplateElement[value.__never__=',
    test: 'tests/security/lint-boundaries.spec.ts',
    expect: ['TEMPLATE LITERAL'],
  },
  {
    id: 'R9',
    what: 'the pg driver error message is printed without redaction',
    file: 'packages/database/src/pool.ts',
    find: /redactValueShapes\(error\.message\),/,
    replace: 'error.message,',
    test: 'packages/database/src/guards.test.ts',
    expect: ['redacts the credentials out of the driver message'],
  },
  {
    id: 'R5',
    what: 'Amount accepts non-finite values again',
    file: 'packages/validation/src/money.ts',
    find: /if \(!value\.isFinite\(\)\) \{/,
    replace: 'if (false as boolean) {',
    test: 'packages/validation/src/money.test.ts',
    expect: ['NaN', 'Infinity', 'finite'],
  },
  {
    id: 'R17',
    what: 'toFixed is left writable on the prototype',
    file: 'packages/validation/src/decimal.ts',
    find: /writable: false,\n\s*configurable: false,/,
    replace: 'writable: true,\n  configurable: true,',
    test: 'packages/validation/src/money.test.ts',
    expect: ['pins toFixed'],
  },
]

/*
 * Run one test file and return the names of the tests that failed.
 *
 * Via `--outputFile` rather than stdout: vitest's JSON reporter interleaves
 * with worker output, and `--outputFile=-` writes a file literally named `-`
 * rather than to stdout.
 */
const REPORT = join(tmpdir(), `finsoft-verify-controls-${process.pid}.json`)

function failingTestNames(testFile) {
  rmSync(REPORT, { force: true })
  try {
    /*
     * vitest's JS entry through node, not `npx`. On Windows `npx.cmd` needs
     * `shell: true`, and a shell here would mean interpolating paths into a
     * command line — the injection surface this script exists to avoid
     * needing to think about.
     */
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        testFile,
        '--reporter=json',
        `--outputFile=${REPORT}`,
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: 'ignore' },
    )
  } catch {
    /* A non-zero exit is the expected case here — the report is what matters. */
  }

  if (!existsSync(REPORT)) return ['(vitest wrote no report — treat as inconclusive)']

  try {
    const report = JSON.parse(readFileSync(REPORT, 'utf8'))
    return report.testResults
      .flatMap((f) => f.assertionResults ?? [])
      .filter((a) => a.status === 'failed')
      .map((a) => a.fullName ?? a.title)
  } catch {
    return ['(unparseable vitest report — treat as inconclusive)']
  } finally {
    rmSync(REPORT, { force: true })
  }
}

let failures = 0
const rows = []

/** file -> its bytes before any patch, for the restoration check at the end. */
const snapshots = new Map()

for (const control of CONTROLS) {
  const path = join(ROOT, control.file)
  const original = readFileSync(path, 'utf8')
  if (!snapshots.has(control.file)) snapshots.set(control.file, original)

  if (!control.find.test(original)) {
    rows.push([control.id, 'NOT FOUND', control.what])
    console.error(`  ${control.id}: pattern did not match in ${control.file} — control not tested`)
    failures += 1
    continue
  }

  try {
    writeFileSync(path, original.replace(control.find, control.replace), 'utf8')
    const failed = failingTestNames(control.test)
    const hit = control.expect.filter((name) => failed.some((f) => f.includes(name)))

    if (hit.length === 0) {
      rows.push([control.id, 'DID NOT FAIL', control.what])
      console.error(
        `  ${control.id}: removing the mechanism did NOT fail ${control.test}.\n` +
          `      expected a failure naming one of: ${control.expect.join(', ')}\n` +
          `      actually failed: ${failed.length ? failed.join(' | ') : '(nothing)'}`,
      )
      failures += 1
    } else {
      rows.push([control.id, `caught (${hit.length}/${control.expect.length})`, control.what])
      console.log(`  ${control.id}: caught by — ${hit.join(', ')}`)
    }
  } finally {
    writeFileSync(path, original, 'utf8')
  }
}

/*
 * The files this script touched must be exactly as it found them. A patch
 * left behind would be a change nobody made deliberately, in a boundary rule
 * or a money primitive.
 *
 * Compared against the bytes read at the start, not against `git status`:
 * the script is expected to run on a tree with other work in progress, and a
 * whole-tree check would report that as damage and teach the reader to
 * ignore this line.
 */
const dirty = [...snapshots]
  .filter(([file, bytes]) => readFileSync(join(ROOT, file), 'utf8') !== bytes)
  .map(([file]) => `  ${file}`)
  .join('\n')

console.log(
  `\n  ${CONTROLS.length - failures}/${CONTROLS.length} controls proved to fail when removed`,
)

if (dirty) {
  console.error(`\n  WORKING TREE NOT RESTORED:\n${dirty}`)
  process.exit(2)
}

process.exit(failures === 0 ? 0 : 1)
