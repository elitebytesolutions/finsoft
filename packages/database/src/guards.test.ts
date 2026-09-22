import { describe, expect, it } from 'vitest'
import { assertGeneratedTypesAreExact } from './generate/cli.ts'
import { assertExactNumericParsing } from './pool.ts'
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
