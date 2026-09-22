import type { DB } from './generated/schema.js'

/*
 * The schema as TypeScript sees it, plus the one distinction the type system
 * has to carry: which tables are global and which are tenant-owned.
 *
 * ADR-0013: types flow database -> TypeScript. `generated/schema.d.ts` is a
 * derived artefact produced by `npm run db:codegen` and committed so a fresh
 * clone typechecks offline. Nothing here or anywhere else edits it by hand.
 */

/** Every table in the database. Reachable only inside `withTenant`. */
export type Database = DB

/**
 * The global-table allowlist (ADR-0003:30).
 *
 * A table belongs here only if it has no tenant_id and no RLS *by design*:
 *
 *   tenants             read by login and provisioning, before any tenant
 *                       context exists (ADR-0004:77)
 *   schema_migrations   the migration runner's own bookkeeping (ADR-0013:57)
 *
 * This constant is the single source of truth for the distinction. The
 * `GlobalDatabase` type below is derived from it, and
 * database/tests/schema.spec.ts asserts against it that every *other* table
 * in the live database carries tenant_id and has RLS enabled and forced.
 * Adding a name here is therefore how a table is excused from tenant
 * isolation — which is exactly the decision that should require an edit to a
 * short, obvious list under review, rather than an omission nobody notices.
 *
 * Global reference data that ADR-0003 anticipates — currency codes, country
 * codes, unit-of-measure catalogue, chart-of-accounts templates — joins this
 * list when those migrations land.
 */
export const GLOBAL_TABLES = ['tenants', 'schema_migrations'] as const

export type GlobalTableName = (typeof GLOBAL_TABLES)[number]

/**
 * The narrow view `withGlobal` runs against.
 *
 * This is why `withGlobal` is not a general-purpose escape hatch: a handle
 * typed `Transaction<GlobalDatabase>` cannot name `users` at all, so
 * "I'll just use withGlobal for this one query" does not compile. The
 * restriction is structural, not a convention in a comment.
 */
export type GlobalDatabase = Pick<Database, GlobalTableName>

/** Every table that is not on the allowlist — i.e. every tenant-owned table. */
export type TenantTableName = Exclude<keyof Database, GlobalTableName> & string

export function isGlobalTable(name: string): name is GlobalTableName {
  return (GLOBAL_TABLES as readonly string[]).includes(name)
}
