/*
 * @finsoft/database — the only place in the repository that owns a database
 * connection. ADR-0013.
 *
 * The public surface is deliberately small. Everything that reaches a
 * tenant-owned table goes through `withTenant`; the short, named list of
 * things that legitimately have no tenant goes through `withGlobal`; and
 * neither the Pool nor the Kysely instances are exported, because handing
 * those out is handing out the ability to run a query with no tenant set.
 *
 * Not exported, on purpose:
 *   getPool / fullDb / globalDb   a connection outside a scoped transaction
 *   the migration runner          a separate CLI entrypoint, never imported
 *                                 by application code (ADR-0013:51)
 */

export { withGlobal, withTenant, TransactionScopeError } from './transaction.ts'
export type { GlobalTx, TenantTx } from './transaction.ts'

/*
 * The registry checks, exported.
 *
 * withTenant records the handles it issues in a WeakSet and BaseRepository
 * verifies membership — but only inside its own three methods, and the check
 * was not exported. A kernel or a modules/*-/infrastructure repository that
 * receives a TenantTx and builds a query directly had no way to opt in.
 *
 * Lint catches a forged handle at build time; this catches one at the point
 * of use, which is the half that survives a disabled rule.
 */
export { assertIssuedGlobalTx, assertIssuedTenantTx } from './transaction.ts'

export { TenantContext, TenantContextError } from './tenant-context.ts'
export type { TenantPrincipal } from './tenant-context.ts'

export { BaseRepository } from './repository.ts'

export { GLOBAL_TABLES, isGlobalTable } from './schema.ts'
export type { Database, GlobalDatabase, GlobalTableName, TenantTableName } from './schema.ts'

export { assertExactNumericParsing } from './pool.ts'
export { closeDatabase, openDatabase } from './lifecycle.ts'
export { readSchemaHealth } from './health.ts'
export type { SchemaHealth } from './health.ts'
export { DatabaseConfigError } from './env.ts'
