import { describe, expect, it } from 'vitest'
import { assertGeneratedTypesAreExact } from './generate/cli.ts'
import { assertExactNumericParsing, closePool, getPool } from './pool.ts'
import { TenantContext, TenantContextError } from './tenant-context.ts'

/*
 * The guards that fail silently if nobody checks them. No database required.
 *
 * ADR-0013:130 says of the numeric type mapping: "A CI assertion guards it,
 * because the failure mode is silent." The same is true of the driver's type
 * parsers and of the tenant context. A guard nobody tests is a guard that
 * stops working without anyone noticing — which is the exact shape of the bug
 * it was written to prevent.
 */

describe('driver type parsing (ADR-0011)', () => {
  it('passes against the stock pg configuration', () => {
    expect(() => assertExactNumericParsing()).not.toThrow()
  })

  it('is checking something a JS number would actually get wrong', () => {
    /*
     * The probe value is 2^53 + 1. This is the whole reason the assertion
     * exists: through a JS number it comes back one less, with no error, no
     * warning and no way to notice downstream.
     */
    expect(Number('9007199254740993').toString()).toBe('9007199254740992')
  })
})

describe('generated schema check (ADR-0013:155)', () => {
  const ok = `
    export interface Probe {
      amount: ColumnType<string, string, string>;
      big_col: ColumnType<string, string, string>;
      line_no: number;
    }
    export interface DB { probe: Probe; }
  `

  it('accepts a correctly mapped schema', () => {
    expect(assertGeneratedTypesAreExact(ok)).toEqual([])
  })

  it('rejects what kysely-codegen emits by default', () => {
    /*
     * Verbatim from kysely-codegen@0.20.0 with no --type-mapping. The read
     * side is right and the write side is not, so a read-side round-trip test
     * would pass while `values({ amount: 0.1 + 0.2 })` still compiled.
     */
    const problems = assertGeneratedTypesAreExact(`
      export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;
      export type Numeric = ColumnType<string, number | string, number | string>;
      export interface DB { probe: unknown; }
    `)

    expect(problems).toHaveLength(2)
    expect(problems.join(' ')).toContain('ADR-0011')
  })

  it('rejects a named floating-point alias if one ever appears', () => {
    const problems = assertGeneratedTypesAreExact(`
      export type Float8 = number;
      export interface DB { probe: unknown; }
    `)
    expect(problems.join(' ')).toContain('Rule 6')
  })

  it('cannot see an unnamed float column, which is why schema.spec.ts exists', () => {
    /*
     * Verbatim from kysely-codegen@0.20.0 against a table with `real` and
     * `double precision` columns: both render as a bare `number`, identical
     * to an int4. Nothing in the generated text distinguishes them, so this
     * checker is blind here and says so rather than pretending otherwise.
     * The real control is the pg_catalog assertion in
     * database/tests/schema.spec.ts, which is proven by adding a float column
     * and watching it go red.
     */
    const floatsInDisguise = `
      export interface Probe {
        f4: number | null;
        f8: number | null;
      }
      export interface DB { probe: Probe; }
    `
    expect(assertGeneratedTypesAreExact(floatsInDisguise)).toEqual([])
  })

  it('rejects an empty or truncated generation', () => {
    expect(assertGeneratedTypesAreExact('')).toHaveLength(1)
  })

  it('does not trip over the word "number" in a doc comment', () => {
    const withComment = `
      export interface Probe {
        /**
         * The migration number. Not a money column.
         */
        version: number;
      }
      export interface DB { probe: Probe; }
    `
    expect(assertGeneratedTypesAreExact(withComment)).toEqual([])
  })
})

describe('tenant context (rule 8)', () => {
  const tenantId = '11111111-2222-3333-4444-555555555555'

  it('raises rather than defaulting when no tenant is in scope', () => {
    expect(() => TenantContext.require()).toThrow(TenantContextError)
    expect(TenantContext.current()).toBeUndefined()
    expect(TenantContext.isSet()).toBe(false)
  })

  it('carries the principal through async boundaries', async () => {
    const seen = await TenantContext.run({ tenantId, userId: null }, async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 1))
      return TenantContext.require().tenantId
    })
    expect(seen).toBe(tenantId)
  })

  it('does not leak out of its scope', async () => {
    await TenantContext.run({ tenantId, userId: null }, async () => undefined)
    expect(TenantContext.current()).toBeUndefined()
  })

  it('rejects a tenant id that is not a uuid, at the boundary', () => {
    /*
     * set_config binds the value as a parameter, so this is not an injection
     * defence — it is a diagnostics one. A non-uuid here means something
     * unverified reached the context, and the caller should hear about it
     * where it can still be identified, not five frames later as a
     * PostgreSQL cast error.
     */
    for (const bad of ['', 'not-a-uuid', "' or '1'='1", '11111111-2222-3333-4444']) {
      expect(() =>
        TenantContext.run({ tenantId: bad, userId: null }, async () => undefined),
      ).toThrow(TenantContextError)
    }
  })

  it('rejects a malformed acting user id too', () => {
    expect(() => TenantContext.run({ tenantId, userId: 'root' }, async () => undefined)).toThrow(
      TenantContextError,
    )
  })
})

describe('the COMMITTED generated types, not a synthetic string', () => {
  /*
   * assertGeneratedTypesAreExact was exercised only against strings written
   * inside this file. That proves the function works; it proves nothing about
   * the file that actually ships.
   *
   * A hand-edited or stale `generated/schema.d.ts` — a float slipped in, a
   * numeric loosened to `number`, a column dropped during a merge — passed
   * every gate in the repository. ADR-0013 rests on those types being an
   * exact reflection of the schema, and nothing was checking the artefact
   * itself.
   */
  it('passes its own exactness check', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')

    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, 'generated', 'schema.d.ts'), 'utf8')

    expect(
      assertGeneratedTypesAreExact(source),
      'the committed generated/schema.d.ts violates the exactness rules it exists to carry',
    ).toEqual([])
  })

  it('is not empty, so the assertion above is not vacuous', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')

    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, 'generated', 'schema.d.ts'), 'utf8')

    expect(source.length).toBeGreaterThan(200)
    expect(source).toContain('tenants')
  })
})

describe('the idle-client error listener does not print the password (rule 20)', () => {
  /*
   * The leak this closes: a `pg` connection failure puts the DSN it tried —
   * password included — into its MESSAGE. The listener interpolated that
   * message into `console.error` verbatim, so the password reached stdout on
   * a path the observability redactor never sees.
   *
   * Exercised through the REAL listener, not through `redactValueShapes`
   * alone: the pool is an EventEmitter, so emitting 'error' on it runs the
   * exact closure `getPool` registered. A unit test of the regex would still
   * pass if someone removed the call.
   */
  const DSN = 'postgresql://finsoft_app:hunter2@db.internal:5432/finsoft'

  it('redacts the credentials out of the driver message', async () => {
    const previous = process.env.DATABASE_URL
    process.env.DATABASE_URL = DSN

    const lines: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '))
    }

    try {
      const pool = getPool()
      pool.emit('error', new Error(`connection terminated: could not connect to ${DSN}`))
    } finally {
      console.error = realError
      await closePool()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }

    expect(lines).toHaveLength(1)
    const line = lines[0] ?? ''

    expect(line, 'the password must not reach stdout').not.toContain('hunter2')
    expect(line, 'nor the role it authenticated as').not.toContain('finsoft_app')

    /*
     * And the line is still diagnosable. A redaction that destroys the
     * diagnosis is one that gets switched off — the host, port and database
     * come from `describeTarget`, which never had the credentials, and the
     * driver's own wording survives.
     */
    expect(line).toContain('db.internal:5432/finsoft')
    expect(line).toContain('connection terminated')
  })
})
