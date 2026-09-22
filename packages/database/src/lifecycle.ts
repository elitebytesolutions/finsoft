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
  } finally {
    client.release()
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
