import { describe, expect, it } from 'vitest'
import { atAuthBoundary, SanitisedDatabaseError } from './db-error.ts'

/*
 * ADR-0023 §6's own compliance requirement: "a synthetic driver error
 * carrying a 64-hex digest in its detail produces no log line containing
 * it." This is that test, at the boundary function itself rather than by
 * forcing a real 23505 (astronomically unlikely to reproduce on demand with
 * genuine 256-bit randomness).
 */
describe('atAuthBoundary / SanitisedDatabaseError (ADR-0023 §6)', () => {
  const HEX_64 = 'a'.repeat(64)

  function pgShapedError(): Error {
    // The exact shape node-postgres attaches for a 23505 on rt_token_hash_key.
    return Object.assign(
      new Error('duplicate key value violates unique constraint "rt_token_hash_key"'),
      {
        code: '23505',
        detail: `Key (token_hash)=(${HEX_64}) already exists.`,
        table: 'refresh_tokens',
        constraint: 'rt_token_hash_key',
        schema: 'public',
        severity: 'ERROR',
      },
    )
  }

  it('rethrows a SanitisedDatabaseError carrying only the code', async () => {
    await expect(atAuthBoundary(() => Promise.reject(pgShapedError()))).rejects.toBeInstanceOf(
      SanitisedDatabaseError,
    )

    try {
      await atAuthBoundary(() => Promise.reject(pgShapedError()))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SanitisedDatabaseError)
      expect((error as SanitisedDatabaseError).code).toBe('23505')
    }
  })

  it('carries no detail, hint, table, constraint or schema anywhere on the thrown error', async () => {
    try {
      await atAuthBoundary(() => Promise.reject(pgShapedError()))
      expect.unreachable()
    } catch (error) {
      const serialised = JSON.stringify(
        Object.assign({}, error),
        Object.getOwnPropertyNames(error as object),
      )
      expect(serialised).not.toContain(HEX_64)
      expect(serialised).not.toContain('detail')
      expect(serialised).not.toContain('constraint')
      expect(serialised).not.toContain('table')
      expect(serialised).not.toContain('refresh_tokens')
    }
  })

  it('the message itself contains no trace of the digest', async () => {
    try {
      await atAuthBoundary(() => Promise.reject(pgShapedError()))
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain(HEX_64)
    }
  })

  it('leaves a non-SQLSTATE-shaped error (an application bug) untouched', async () => {
    const bug = new Error('withLoginAttempt: decide() authenticated a candidate with no user row')
    await expect(atAuthBoundary(() => Promise.reject(bug))).rejects.toBe(bug)
  })

  it('leaves a successful call unaffected', async () => {
    await expect(atAuthBoundary(() => Promise.resolve(42))).resolves.toBe(42)
  })
})
