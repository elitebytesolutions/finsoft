import { withGlobal } from './transaction.ts'

/*
 * The database-side of a readiness probe.
 *
 * This lives here rather than in apps/api because ADR-0013 confines query
 * construction to packages/database, the kernels, packages/reporting and
 * module infrastructure layers — and `apps/*` is not on that list.
 *
 * The first version of this WAS in apps/api, and neither enforcement config
 * caught it: dependency-cruiser watches imports, and a transaction handle
 * arrives through a callback rather than an import, so `tx.selectFrom(...)`
 * inside a controller reads as ordinary application code. The rule was about
 * the import path, and the import path was never the only way in.
 *
 * It matters beyond tidiness. A health check is the most copied file in any
 * codebase — it is the first thing that works, so it becomes the template.
 * Had it stayed, every Wave 1 controller would have had a worked example of
 * building queries in the HTTP layer, and the boundary would have been lost
 * one reasonable-looking commit at a time.
 */

export interface SchemaHealth {
  /** Highest applied migration version, or 0 if none have run. */
  readonly appliedVersion: number
  /** Whether an ordinary table could actually be read. */
  readonly readable: boolean
}

/**
 * Read the schema's health in one round trip.
 *
 * Reads `schema_migrations` for the applied version and then reads a real
 * table — the second query is the point. A catalog with rows in it proves the
 * migration runner ran at some time in the past; it does not prove this
 * process can read application data now. A revoked grant, an exhausted pool
 * or a broken RLS policy shows up on the second query and not the first.
 *
 * Runs through `withGlobal`: no tenant is involved and only global tables are
 * touched, which is exactly what that wrapper is for (ADR-0004:77).
 *
 * Throws on failure rather than returning a status. The caller decides what a
 * failure means for readiness and what may be said about it in an
 * unauthenticated response.
 */
export function readSchemaHealth(): Promise<SchemaHealth> {
  return withGlobal(async (tx) => {
    const version = await tx
      .selectFrom('schema_migrations')
      .select(({ fn }) => fn.max('version').as('applied'))
      .executeTakeFirst()

    await tx.selectFrom('tenants').select('id').limit(1).execute()

    return { appliedVersion: Number(version?.applied ?? 0), readable: true }
  })
}
