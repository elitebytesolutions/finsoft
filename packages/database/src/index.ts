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
/*
 * The outbox repository. ADR-0019.
 *
 * Exported because apps/worker runs the dispatcher and ADR-0013's second
 * import boundary forbids it building the SQL itself. What is exported is
 * row movement and nothing else: this package does not know what a side
 * effect is, what a consumer is, or that Redis exists.
 */
export {
  ackDispatched,
  attemptsExhausted,
  backoffSeconds,
  claimBatch,
  listTenantIdsForDispatch,
  oldestPendingAgeSeconds,
  reclaimExpired,
  reclaimsExhausted,
  recordFailure,
  ATTEMPT_CAP,
  LeaseLostError,
  RECLAIM_CAP,
} from './outbox.ts'
export type { ClaimedOutboxRow, FailureRecord, ReclaimResult } from './outbox.ts'

export { readSchemaHealth } from './health.ts'
export type { SchemaHealth } from './health.ts'
export { DatabaseConfigError } from './env.ts'

/*
 * The audit hash chain. ADR-0020, NON_NEGOTIABLES rule 9.
 *
 * `recordAudit` and `auditSink` run inside the CALLER's transaction — the
 * caller passes its own TenantTx, exactly like inventoryKernel.postMovement
 * and postingEngine.post. `verifyAuditChain` opens its own readonly_support
 * connection and is not part of any request path — it is the CLI's
 * (`npm run audit:verify`).
 *
 * `createAuditChainAnchor` is deliberately NOT exported here. It is
 * provisioning-only, imported from `@finsoft/database/provisioning` — see
 * that file's own comment for why it does not belong on the same surface as
 * `recordAudit`.
 */
export {
  AuditCanonicalizationError,
  assertJcsSafe,
  computeAuditHash,
  GENESIS_HASH,
  HASH_VERSION,
  jcsSerialize,
} from './audit/canonical.ts'
export type { CanonicalAuditRecord, JsonObject, JsonValue } from './audit/canonical.ts'
export { normalizeIp } from './audit/ip.ts'
export { buildCanonicalRecord, toMicrosecondIso } from './audit/record.ts'
export { AuditChainError, auditSink, recordAudit } from './audit/writer.ts'
export type { AuditAppendResult, AuditEventInput, AuditSink } from './audit/writer.ts'
export { verifyAuditChain } from './audit/verify.ts'
export type { ChainBreak, StructuralIssue, VerifyResult } from './audit/verify.ts'
export { SupportConnectionRoleError } from './audit/support-connection.ts'
export { AuditSecretKeyError, assertNoSecretLikeKeys } from './audit/secret-keys.ts'
export { AuditLockTimeoutError } from './audit/writer.ts'
export { listAuditEvents } from './audit/query.ts'
export type { AuditEventFilter, AuditEventPage, AuditEventRow } from './audit/query.ts'
