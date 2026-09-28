/*
 * ADR-0023 §6: "On /auth/login and /auth/refresh, a driver error is caught
 * at the boundary and rethrown carrying only a code. No detail, hint,
 * where, internalQuery, internalPosition, schema, table or constraint is
 * logged or serialised."
 *
 * General redaction (`@finsoft/observability`'s `redactError`) denies by key
 * NAME or by VALUE SHAPE (a JWT, a bearer token, a connection string) — it
 * does not know that `pg`'s `detail` field on a `23505` can read
 * `Key (token_hash)=(<64 hex characters>) already exists.` A bare hex digest
 * inside free text matches neither pattern, so `detail` survives ordinary
 * redaction untouched. This is the auth-path-specific tightening: anything
 * that looks like a PostgreSQL driver error (a SQLSTATE-shaped `code`) is
 * replaced entirely — not merely stripped of a few fields — before it can
 * reach a logger or a caller. An application-thrown `Error` (a real bug, an
 * invariant violation) has no SQLSTATE-shaped code and passes through
 * unchanged, because THAT diagnostic detail is safe and worth keeping.
 */

const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/

export class SanitisedDatabaseError extends Error {
  readonly code: string | undefined

  constructor(code: string | undefined) {
    super('A database error occurred.')
    this.name = 'SanitisedDatabaseError'
    this.code = code
  }
}

function sqlstateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && SQLSTATE_SHAPE.test(code) ? code : undefined
}

/**
 * Runs `fn`, and if it rejects with something carrying a SQLSTATE-shaped
 * `code`, rethrows a `SanitisedDatabaseError` carrying only that code —
 * never the original error's message, detail, hint, table or constraint.
 * Anything else (an application-thrown `Error`, a `ThrottleUnavailableError`,
 * a `TokenVerificationError`) passes through unchanged.
 */
export async function atAuthBoundary<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const code = sqlstateOf(error)
    if (code !== undefined) {
      throw new SanitisedDatabaseError(code)
    }
    throw error
  }
}
