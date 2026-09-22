/*
 * Environment reading for packages/database.
 *
 * Every value the pool depends on is read here, once, with a message that
 * says what to do when it is missing. A connection string assembled three
 * different ways in three different files is how a process ends up talking to
 * the wrong database.
 *
 * Rule 20: nothing in this file prints, logs or returns a credential. The
 * connection strings are handled as opaque strings and never echoed — see
 * `describeTarget` for what is safe to show a human.
 */

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseConfigError'
  }
}

export function requireEnv(name: string, why: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new DatabaseConfigError(
      `${name} is not set. ${why} Copy .env.example to .env for local work; ` +
        'production values come from the secret store, never from the repository (rule 20).',
    )
  }
  return value
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? fallback : value
}

/**
 * A positive integer from the environment, or the fallback.
 *
 * Rejects rather than coerces: `DATABASE_POOL_MAX=ten` silently becoming NaN
 * and then becoming pg's own default is the kind of misconfiguration that is
 * only discovered under load.
 */
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new DatabaseConfigError(
      `${name} must be a positive integer, got "${raw}". It configures the connection pool, ` +
        'and a pool misconfiguration is the one way RLS can be defeated by configuration (ADR-0004:118).',
    )
  }
  return value
}

/**
 * Host, port and database name from a connection string — never the password,
 * never the user's credentials. This is what an error message or a startup
 * line may contain.
 */
export function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`
  } catch {
    return '(unparseable connection string)'
  }
}
