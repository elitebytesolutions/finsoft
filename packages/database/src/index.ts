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
 *   withTenantAsPrincipal         @finsoft/database/request-scope, its own
 *                                 narrow subpath, importable only from
 *                                 apps/api/src/common/permission.guard.ts
 *                                 (M1-X, Council T1). Exporting it from this
 *                                 same surface as withTenant would invite it
 *                                 to be reached from anywhere in apps/api.
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

/*
 * RBAC queries. ARCHITECTURE §8, migration 008_create_rbac.sql.
 *
 * Exported because packages/permissions is not on depcruise's
 * kysely-is-allowlisted allow-list and so must not build these queries
 * itself (Architecture seat ruling, docs/briefs/M1-R-rbac.md). What is
 * exported is row access and nothing else: this package does not know what a
 * permission code means, which ones are privileged, or what a system role
 * template contains.
 */
export { selectEffectivePermissionCodes } from './rbac/resolve-permissions.ts'
export { insertSeededRoles } from './rbac/seed-roles.ts'
export type { RoleSeed } from './rbac/seed-roles.ts'

/*
 * Accounting query surface. M2-A.
 *
 * THE RULE (Council T3, Arch 1/2/5): this package holds READS of the
 * accounting tables, plus only those WRITES that ADR-0013:31 permits a
 * non-kernel package on its query-construction allowlist — i.e. none to a
 * kernel-owned register. journal_entries / journal_lines (ADR-0005), parties
 * (ADR-0026 statement 5) and fiscal_periods transitions (Council T3) are
 * written only by packages/accounting-kernel/src/queries/**; ESLint's
 * financialTruthWriteSyntax fails the build if any of them is written here,
 * because modules/*\/infrastructure may import this package and an export
 * here would be a path around the kernel.
 *
 * NOT the rule: an earlier version of this comment cited ADR-0023 A1 ("all
 * query construction lives in packages/database") as the licence. That
 * widening moved query bodies out of packages/auth and packages/permissions,
 * which are NOT on the ADR-0013 allowlist. It never licensed this package to
 * write tables the kernel owns — the kernel IS on the allowlist, and
 * ADR-0026's Architecture-seat signature says so explicitly.
 *
 * Two kinds of export below are kernel-only by lint rather than by location:
 * assignDocumentNumber / assignTenantDocumentNumber (numbering, LOCK_REGISTRY
 * 5c) and lockEntryForReversal (LOCK_REGISTRY 5a) — ESLint
 * kernelOnlyCallSyntax confines their callers to packages/accounting-kernel
 * and the database test suites. Period transitions (close / reopen / lock)
 * are not here at all: they are periodEngine in packages/accounting-kernel.
 *
 * Nothing below carries a posting rule, rounding or account-role policy.
 * `seedChartOfAccounts`/`createFiscalYear` are deliberately NOT re-exported
 * here a second time; they live only on `@finsoft/database/provisioning`
 * (see that file's header for why).
 */
export {
  findAccountsByIds,
  listAllAccounts,
  listPostableAccounts,
  resolveAccountsByRole,
} from './accounting/accounts.ts'
export type { AccountRow } from './accounting/accounts.ts'

export { findPeriodById, findPeriodForDate, listPeriods } from './accounting/periods.ts'
export type { FiscalPeriodRow, PeriodStatus } from './accounting/periods.ts'

export { assignDocumentNumber, assignTenantDocumentNumber } from './accounting/sequences.ts'

export {
  constraintName as journalConstraintName,
  findEntryById,
  findEntryByIdempotencyKey,
  findEntryBySource,
  findLinesByEntryId,
  JOURNAL_REGISTER_PAGE_MAX,
  listJournalEntries,
  lockEntryForReversal,
  sqlstate as journalSqlstate,
  UNIQUE_VIOLATION,
} from './accounting/journal.ts'
export type {
  JournalEntryCursor,
  JournalEntryFilter,
  JournalEntryPage,
  JournalEntryRow,
  JournalLineRow,
  NewJournalEntry,
  NewJournalLine,
} from './accounting/journal.ts'

export {
  accountLedgerBalanceThrough,
  accountLedgerLines,
  LEDGER_PAGE_MAX,
  accountOpeningBalance,
  partyControlBalance,
  trialBalanceRawSums,
} from './accounting/ledger.ts'
export type {
  LedgerCursor,
  LedgerLineRow,
  LedgerPage,
  TrialBalanceRow,
} from './accounting/ledger.ts'

export { COA_TEMPLATE_ID, STANDARD_V1 } from './accounting/coa-standard-v1.ts'
export type { AccountTemplateEntry, ControlKind } from './accounting/coa-standard-v1.ts'

export {
  DEFAULT_FISCAL_YEAR_START_MONTH,
  findTenantTimezone,
} from './accounting/tenant-settings.ts'

/*
 * The kernel's acting-principal accessor. Council ruling (Architecture +
 * Security seats, M2-A T3 final review): TenantContext stays importable
 * only inside packages/database and packages/auth (M1-X T2); the kernel
 * gets this narrow, read-only, frozen-copy accessor instead of importing
 * TenantContext itself. See accounting/principal.ts's own header.
 */
export { postingPrincipalOf, type PostingPrincipal } from './accounting/principal.ts'

/*
 * computeRequestFingerprint lives here, not in packages/accounting-kernel,
 * because it needs node:crypto — dependency-cruiser's kernel-imports-only-
 * allowed rule confines a kernel to packages/database, packages/validation
 * and packages/shared-types, with NO node builtin escape hatch (ADR-0001,
 * ARCHITECTURE §5). The canonicalisation itself has no SQL and no tenant
 * concern; it lives on this package's surface purely so the kernel can reach
 * it at all.
 */
export { computeRequestFingerprint, type FingerprintInput } from './accounting/fingerprint.ts'
