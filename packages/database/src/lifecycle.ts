import { releaseKysely } from './kysely.ts'
import { closePool, configurePoolTarget, getPool, type PoolTarget } from './pool.ts'

/*
 * Opening and closing the database, in one place.
 *
 * Both exist so that the pool's construction-time assertions (ADR-0011's
 * type-parser check, the connection string being present) fail during
 * startup, where a process manager sees them, rather than on the first
 * request an actual user makes.
 */

/**
 * Open the pool eagerly and prove the connection works.
 *
 * Call it from application bootstrap. The `select 1` is not ceremony: a
 * connection string that points at the wrong host, or credentials the secret
 * store rotated, should stop a deploy rather than produce a healthy-looking
 * process that fails every request.
 */
export async function openDatabase(target?: PoolTarget): Promise<void> {
  if (target) configurePoolTarget(target)
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('select 1')
    await assertRoleIsSubjectToRls(client)
  } finally {
    client.release()
  }
}

/**
 * Refuse to start as a role that can see every tenant's rows.
 *
 * ADR-0004's isolation rests on the application connecting as a role that RLS
 * actually applies to. `SUPERUSER` and `BYPASSRLS` each disable every policy
 * in the database for that connection — silently, with no error and no log
 * line, because bypassing RLS is what those attributes are *for*.
 *
 * So a `DATABASE_URL` pointed at the wrong role is not a misconfiguration
 * that degrades something. It is a total loss of tenant isolation that
 * presents as a perfectly healthy system: every request succeeds, every query
 * returns rows, and each tenant sees all of them. Nothing downstream can
 * detect it, because from the application's side nothing is wrong.
 *
 * The check costs one query at startup, once. It runs here rather than in a
 * test because a test proves the test's configuration; this proves the
 * running process's.
 *
 * ── It is NECESSARY, NOT SUFFICIENT ─────────────────────────────────────
 *
 * Passing this does not mean tenant isolation holds. It means one specific,
 * catastrophic misconfiguration is absent. Isolation additionally requires
 * that the app role does not OWN the tenant-owned tables, that it has no
 * membership of a role which does, that every such table has RLS both
 * ENABLED and FORCED, and that each policy carries a non-null WITH CHECK —
 * none of which this function looks at.
 *
 * Those are asserted where they can be asserted properly, against a live
 * schema, and they are not replaced by this:
 *
 *   database/tests/roles.spec.ts                 role attributes, ownership
 *   database/tests/rls.spec.ts                   ENABLE + FORCE + policies
 *   tests/security/tenant-isolation*.spec.ts     behaviour, adversarially,
 *                                                serial and concurrent
 *
 * Do not let this guard's presence justify weakening any of them.
 *
 * Deliberately NOT applied to the migration runner: `finsoft_migration` holds
 * `BYPASSRLS` by design (ADR-0004:59, NON_NEGOTIABLES rule 21) and owns the
 * tables. It uses its own client and never this pool.
 */
async function assertRoleIsSubjectToRls(client: {
  query: (text: string) => Promise<{ rows: unknown[] }>
}): Promise<void> {
  const result = await client.query(
    'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  )

  const row = result.rows[0] as
    { role: string; rolsuper: boolean; rolbypassrls: boolean } | undefined

  if (!row) {
    throw new Error(
      'Could not determine the connecting role from pg_roles. Refusing to start: ' +
        'an unverifiable identity is treated exactly as a prohibited one.',
    )
  }

  const prohibited: string[] = []
  if (row.rolsuper) prohibited.push('SUPERUSER')
  if (row.rolbypassrls) prohibited.push('BYPASSRLS')

  if (prohibited.length > 0) {
    throw new Error(
      `Refusing to start: the application connected as "${row.role}", which has ` +
        `${prohibited.join(' and ')}. Either attribute disables every row level ` +
        'security policy for this connection, so tenant isolation would be absent ' +
        'while the system looked healthy (ADR-0004). Point DATABASE_URL at ' +
        'finsoft_app.',
    )
  }
}

/**
 * Close the pool. Shutdown only — and idempotent, because a shutdown path
 * that throws on the second call turns a clean exit into a stack trace.
 */
export async function closeDatabase(): Promise<void> {
  releaseKysely()
  await closePool()
}
