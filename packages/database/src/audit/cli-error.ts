/*
 * S7 (Security review), rule 20. A connection failure from `pg` can carry
 * the connection string — host, port, database, and sometimes credentials —
 * in `error.message` or in properties `console.error(error)` would print via
 * the default Error formatter (stack included). `describeCliError` prints
 * ONLY `error.message` and, if present, `error.code` (a SQLSTATE or a Node
 * network error code such as ECONNREFUSED — never a value that itself
 * contains a credential), with any URL-shaped substring stripped from the
 * message as a second line of defence.
 *
 * A separate file, not inlined in cli.ts: cli.ts calls `main()`
 * unconditionally on import (this repository's CLI entrypoints are mixed on
 * whether they guard that — migrate/cli.ts does not either), so importing it
 * from a test would run the whole CLI. This function has no such side
 * effect and can be unit-tested directly.
 */
export function describeCliError(error: unknown): string {
  if (!(error instanceof Error)) return String(error).replace(/\b\w+:\/\/\S+/g, '(url redacted)')

  const code = (error as { code?: string }).code
  const message = error.message.replace(/\b\w+:\/\/\S+/g, '(url redacted)')
  return code ? `${message} (${code})` : message
}
