import { Kysely, PostgresDialect } from 'kysely'
import { getPool } from './pool.ts'
import type { Database, GlobalDatabase } from './schema.ts'

/*
 * The Kysely instances. ADR-0013.
 *
 * Two instances, one pool. The second is not a second connection source — it
 * is the same pool seen through a narrower type, so that `withGlobal` is
 * structurally unable to name a tenant-owned table. Everything else about
 * them is identical.
 *
 * Nothing here uses `db.schema` (DDL lives in database/migrations/*.sql) or
 * Kysely's Migrator; both are lint-forbidden repository-wide.
 */

interface Instances {
  readonly full: Kysely<Database>
  readonly global: Kysely<GlobalDatabase>
}

let instances: Instances | undefined

function build(): Instances {
  const pool = getPool()
  return {
    full: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
    global: new Kysely<GlobalDatabase>({ dialect: new PostgresDialect({ pool }) }),
  }
}

function get(): Instances {
  instances ??= build()
  return instances
}

/**
 * The full-schema instance. Not exported from the package: reaching a
 * tenant-owned table goes through `withTenant`, which is the only thing that
 * sets `app.tenant_id`. A bare `db.selectFrom('users')` outside a transaction
 * would hit the RLS policy with no setting and raise — loudly, which is
 * correct — but it should not be constructible in the first place.
 */
export function fullDb(): Kysely<Database> {
  return get().full
}

/** The global-tables-only instance. Used only by `withGlobal`. */
export function globalDb(): Kysely<GlobalDatabase> {
  return get().global
}

/**
 * Drop the instances. Called by `closeDatabase`.
 *
 * Deliberately does NOT call `Kysely.destroy()`. Kysely's destroy ends the
 * underlying pool, and both instances share one — the second call would
 * throw "Called end on pool more than once". The pool is owned by pool.ts and
 * ended exactly once, there.
 */
export function releaseKysely(): void {
  instances = undefined
}
