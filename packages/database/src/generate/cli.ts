#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Regenerate packages/database/src/generated/schema.d.ts from the live
 * schema. ADR-0013: types flow database -> TypeScript, never the reverse.
 *
 * This is a wrapper around kysely-codegen rather than a line in package.json
 * for two reasons, and both are the point of the task:
 *
 *   1. The type mapping below is not a flag you can skim past. It is the
 *      control that stops a JS number reaching a money column, and it needs
 *      the comment that explains why the obvious-looking flag is not enough.
 *   2. Arguments are passed as an argv array, so the JSON never goes through
 *      a shell. The same command works from PowerShell, cmd and bash, which
 *      an inline `--type-mapping '{"numeric":...}'` does not.
 *
 * After generating, it re-reads the output and fails if a `number` has
 * appeared in a numeric- or int8-derived type. ADR-0013:130 flags this
 * configuration as non-default and silent when it breaks — so it is checked,
 * not trusted.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..', '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
const OUT_FILE = join(PACKAGE_ROOT, 'src', 'generated', 'schema.d.ts')

/**
 * What kysely-codegen must emit for `numeric` and `int8`.
 *
 * VERIFIED AGAINST kysely-codegen@0.20.0, not assumed. Left to itself the
 * generator emits:
 *
 *   export type Numeric = ColumnType<string, number | string, number | string>
 *   export type Int8    = ColumnType<string, bigint | number | string, bigint | number | string>
 *
 * The READ side is already correct. The INSERT and UPDATE sides are not, and
 * that is the hole ADR-0013:70 exists to close:
 *
 *   insertInto('journal_lines').values({ debit_amount: 0.1 + 0.2 })
 *
 * compiles against the default types and writes 0.30000000000000004. It
 * passes lint. It passes a read-side round-trip test, because what comes back
 * is a faithful string of the wrong number.
 *
 * `--numeric-parser string` does NOT fix this. It is the generator's default
 * already in 0.20.0, and it governs only the read side — a reviewer who sets
 * that flag and stops has changed nothing. `--type-mapping` is the flag that
 * replaces the whole ColumnType, so the write side narrows to `string` too.
 *
 * int8 is here for the same reason in a different currency: 2^53 + 1 is
 * 9007199254740993, and through a JS number it comes back 9007199254740992
 * with no error raised anywhere.
 */
const TYPE_MAPPING = {
  numeric: 'ColumnType<string, string, string>',
  int8: 'ColumnType<string, string, string>',
} as const

function codegenBin(): string {
  const bin = join(REPO_ROOT, 'node_modules', 'kysely-codegen', 'dist', 'cli', 'bin.js')
  if (!existsSync(bin)) {
    throw new Error(
      `kysely-codegen is not installed at ${bin}. It is a devDependency of @finsoft/database; ` +
        'run `npm install`. ADR-0013:128 accepts that regeneration needs a live database and ' +
        'a local install — the committed schema.d.ts is what keeps a fresh clone typechecking offline.',
    )
  }
  return bin
}

/**
 * The generated file is checked, not trusted.
 *
 * Fails on: a `number` or `bigint` anywhere in a numeric/int8 column type, a
 * float column that should never have passed migration review (rule 6), and
 * an empty or missing output.
 */
export function assertGeneratedTypesAreExact(source: string): string[] {
  const problems: string[] = []

  if (!source.includes('export interface DB')) {
    problems.push('no DB interface was emitted — the generator produced nothing usable.')
  }

  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue

    // Any ColumnType carrying a JS number or bigint. The only reason one can
    // appear on this side of the driver is that the type mapping stopped
    // being applied.
    if (/ColumnType<[^>]*\b(number|bigint)\b/.test(trimmed)) {
      problems.push(
        `a ColumnType admits a JS number or bigint: "${trimmed}". ` +
          'ADR-0011: numeric and int8 are strings in both directions.',
      )
    }

    /*
     * A named floating-point type in the output.
     *
     * Be clear about how weak this check is, because it looks stronger than
     * it is: with the current generator a `float8` column renders as a bare
     * `number`, indistinguishable from an `int4` — so a float column can
     * reach this file leaving no trace for a text scan to find. The control
     * for rule 6 is the `has no floating-point or money column anywhere`
     * assertion in database/tests/schema.spec.ts, which reads pg_catalog and
     * sees the actual column type.
     *
     * This stays as a second net for the case where a future generator
     * version does emit a named alias, and it is case-insensitive because the
     * generator PascalCases its aliases (`Float8`, not `float8`).
     */
    if (/\b(float4|float8|real|double\s*precision)\b/i.test(trimmed)) {
      problems.push(
        `a floating-point type reached the generated schema: "${trimmed}". ` +
          'Rule 6: float, double precision, real and money are forbidden in the schema.',
      )
    }
  }

  return problems
}

function main(): number {
  const args = [
    codegenBin(),
    '--dialect',
    'postgres',
    // Regeneration introspects the catalog, which needs the role that can
    // see every table. This is a developer/CI step, never the application.
    '--env-file',
    join(REPO_ROOT, '.env'),
    '--url',
    'env(MIGRATION_DATABASE_URL)',
    '--out-file',
    OUT_FILE,
    '--type-mapping',
    JSON.stringify(TYPE_MAPPING),
    // snake_case stays snake_case. ADR-0013:112 — mapping to camelCase
    // happens in module mappers, not as a process-wide plugin.
    '--log-level',
    'warn',
  ]

  execFileSync(process.execPath, args, { stdio: 'inherit', cwd: REPO_ROOT })

  const generated = readFileSync(OUT_FILE, 'utf8')
  const problems = assertGeneratedTypesAreExact(generated)

  if (problems.length > 0) {
    console.error('\n  Generated schema failed its own checks:')
    for (const problem of problems) console.error(`    - ${problem}`)
    console.error(
      '\n  This is the silent failure ADR-0013:130 warns about. Do not edit ' +
        'schema.d.ts — fix the mapping in this file, or the migration that created the column.\n',
    )
    return 1
  }

  console.log(`  wrote ${OUT_FILE}`)
  console.log('  numeric and int8 render as ColumnType<string, string, string> — verified.')
  return 0
}

// Only run when invoked directly; importing this module for its assertion
// helper must not shell out to the generator.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main())
}
