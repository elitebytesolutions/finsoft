import { Client } from 'pg'
import { requireEnv } from '../env.ts'

/*
 * A dedicated, short-lived connection as readonly_support, for the verifier
 * only. ADR-0020 §6: "reads through readonly_support — a verifier needing
 * write access can repair what it is checking."
 *
 * Not the application pool in pool.ts: that pool is one per process for
 * finsoft_app (ADR-0013), and this is a distinct role for a distinct,
 * occasional CLI concern. Precedent: packages/database/src/migrate/apply.ts
 * already opens its own `pg.Client` for finsoft_migration, entirely separate
 * from pool.ts's singleton, for the same reason — a different role, a
 * different process shape (a CLI invocation, not the running application).
 *
 * DERIVED from an existing base URL (DATABASE_URL / TEST_DATABASE_URL) plus
 * POSTGRES_READONLY_PASSWORD, rather than a new SUPPORT_DATABASE_URL /
 * TEST_SUPPORT_DATABASE_URL variable: this task's contract does not extend to
 * root-level .env / .env.example, and POSTGRES_READONLY_PASSWORD already
 * exists there for exactly this role (FND-005). A dedicated URL variable
 * would be more explicit and is a one-line addition for whoever owns root
 * config — flagged in the delivery report rather than added here.
 */

function asReadonlySupport(baseUrl: string): string {
  const password = requireEnv(
    'POSTGRES_READONLY_PASSWORD',
    "The audit verifier connects as readonly_support (ADR-0020 §6); this is that role's password.",
  )
  const url = new URL(baseUrl)
  url.username = 'readonly_support'
  url.password = password
  return url.toString()
}

export class SupportConnectionRoleError extends Error {
  constructor(actual: string) {
    super(
      `The audit verifier's connection reports current_user = "${actual}", not "readonly_support". ` +
        'Refusing to run any query on it. libpq honours a `user` (or `PGUSER`) query parameter in a ' +
        'connection string as an OVERRIDE of the URL userinfo — a connection string carrying one, ' +
        'accidentally or otherwise, would silently reconnect as a different role (potentially ' +
        'finsoft_migration, which holds BYPASSRLS) despite this code setting url.username to ' +
        '"readonly_support". This check is the backstop: it asks PostgreSQL who the connection ' +
        'actually is, rather than trusting the string that asked for it.',
    )
    this.name = 'SupportConnectionRoleError'
  }
}

export interface SupportConnection {
  query<T extends object>(text: string, params?: readonly unknown[]): Promise<T[]>
  close(): Promise<void>
}

/**
 * Open a connection as readonly_support, derived from the connection string
 * in `baseUrlVar` (default DATABASE_URL; tests pass TEST_DATABASE_URL).
 *
 * Verifies `current_user` immediately after connecting and aborts otherwise
 * — see SupportConnectionRoleError for why the connection string's own
 * claimed username cannot be trusted on its own.
 */
export async function openSupportConnection(
  baseUrlVar = 'DATABASE_URL',
): Promise<SupportConnection> {
  const base = requireEnv(
    baseUrlVar,
    'The audit verifier derives its readonly_support connection string from this.',
  )
  const client = new Client({ connectionString: asReadonlySupport(base) })
  await client.connect()

  try {
    const { rows } = await client.query<{ current_user: string }>('SELECT current_user')
    const actual = rows[0]?.current_user
    if (actual !== 'readonly_support') {
      throw new SupportConnectionRoleError(actual ?? '(unknown)')
    }
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }

  return {
    async query<T extends object>(text: string, params: readonly unknown[] = []) {
      const result = await client.query(text, [...params])
      return result.rows as T[]
    },
    close: () => client.end(),
  }
}
