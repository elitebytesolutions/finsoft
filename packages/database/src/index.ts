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

export { TenantContext, TenantContextError } from './tenant-context.ts'
export type { TenantPrincipal } from './tenant-context.ts'

export { BaseRepository } from './repository.ts'

export { GLOBAL_TABLES, isGlobalTable } from './schema.ts'
export type { Database, GlobalDatabase, GlobalTableName, TenantTableName } from './schema.ts'

export { assertExactNumericParsing } from './pool.ts'
export { closeDatabase, openDatabase } from './lifecycle.ts'
export { DatabaseConfigError } from './env.ts'
