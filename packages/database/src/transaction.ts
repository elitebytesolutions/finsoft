import { CompiledQuery, sql, type Transaction } from 'kysely'
import { fullDb, globalDb } from './kysely.ts'
import type { Database, GlobalDatabase } from './schema.ts'
import { TenantContext, type TenantPrincipal } from './tenant-context.ts'

/*
 * withTenant and withGlobal. ADR-0013:80-104, ADR-0004:63-79.
 *
 * These two functions are the only places in the repository that open a
 * transaction or call set_config. Everything that touches a tenant-owned
 * table goes through the first; the short, named list of things that
 * legitimately have no tenant goes through the second.
 */

/* ------------------------------------------------------------------ *
 * Branded handles
 *
 * The brand symbols are declared, not exported, so no code outside this
 * file can name the key — `{ ...trx, [TENANT_TX]: 'tenant' }` is not
 * writable elsewhere.
 *
 * A type brand alone is forgeable with `as`, and ADR-0013:98 answers that
 * with three mechanisms: the brand, a rule confining `.transaction()` to
 * packages/database, and a lint rule forbidding assertions to TenantTx.
 * The third does not exist yet (reported, not silently worked around), so
 * this file adds a fourth that does not depend on lint at all: a runtime
 * registry of handles this module actually issued. `assertIssuedTenantTx`
 * in the base repository rejects a forged handle even if it typechecks.
 * ------------------------------------------------------------------ */

declare const TENANT_TX: unique symbol
declare const GLOBAL_TX: unique symbol

/** A transaction with `app.tenant_id` set. Constructible only by `withTenant`. */
export type TenantTx = Transaction<Database> & { readonly [TENANT_TX]: 'tenant' }

/** A transaction that can address global tables only. Constructible only by `withGlobal`. */
export type GlobalTx = Transaction<GlobalDatabase> & { readonly [GLOBAL_TX]: 'global' }

const issuedTenant = new WeakSet<object>()
const issuedGlobal = new WeakSet<object>()

export class TransactionScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransactionScopeError'
  }
}

/**
 * Reject a handle this module did not issue.
 *
 * The case this catches is `trx as unknown as TenantTx` — a cast that
 * compiles, passes review as "just a type assertion", and hands unscoped
 * database access to code that is supposed to have a tenant. Here it throws.
 */
export function assertIssuedTenantTx(tx: TenantTx): void {
  if (!issuedTenant.has(tx)) {
    throw new TransactionScopeError(
      'This is not a transaction handle issued by withTenant(). A TenantTx exists only inside ' +
        'withTenant, where app.tenant_id has been set for the transaction (ADR-0004:67). ' +
        'A cast does not make one.',
    )
  }
}

export function assertIssuedGlobalTx(tx: GlobalTx): void {
  if (!issuedGlobal.has(tx)) {
    throw new TransactionScopeError('This is not a transaction handle issued by withGlobal().')
  }
}

/* ------------------------------------------------------------------ *
 * withTenant
 * ------------------------------------------------------------------ */

/**
 * Run `fn` in a transaction with `app.tenant_id` set from TenantContext.
 *
 * **It takes no tenant argument, and it never will.** That is the whole
 * design (ADR-0013:88): there is no parameter into which `req.body.tenantId`
 * could be passed, so rule 8's "tenant comes from the authenticated session
 * only" is a property of the signature rather than a convention someone has
 * to remember. Adding a tenant parameter here would silently undo the
 * guarantee for every caller in the system.
 *
 * The transaction is the unit of correctness (ARCHITECTURE §7): journal,
 * numbering, audit, stock and outbox all commit together or not at all. If
 * `fn` throws, the whole transaction rolls back — including the audit rows,
 * which is correct, because nothing happened.
 */
export async function withTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const { tenantId } = TenantContext.require()

  return fullDb()
    .transaction()
    .execute(async (trx) => {
      /*
       * Parameterised, exactly as ADR-0004:67 specifies, and set_config
       * rather than SET LOCAL for a specific reason: SET LOCAL takes no bind
       * parameters, so writing it that way would mean interpolating the
       * tenant id into SQL text — an injection surface on the single value
       * that decides tenancy.
       *
       * The third argument, `true`, makes the setting transaction-scoped. It
       * is what stops a pooled connection carrying this tenant to whoever
       * borrows it next; ADR-0004:129 rejected session scope for exactly
       * that failure, and tests/security/tenant-isolation.spec.ts asserts
       * the connection comes back clean.
       */
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx)

      issuedTenant.add(trx)
      return fn(trx as TenantTx)
    })
}

/**
 * Establish `TenantContext` from an already-verified `principal` and run
 * `fn` inside a tenant transaction, in one call. M1-X / C5.
 *
 * WHY THIS EXISTS: the request-wide `TenantContext` is normally established
 * once, by `apps/api/src/common/tenant-context.interceptor.ts`, for the
 * whole request. But NestJS runs every GUARD before any interceptor — there
 * is no way to interleave them — so a guard that itself needs a
 * `TenantTx` (as `PermissionGuard` does, to resolve the caller's permission
 * set) cannot rely on that interceptor: it has not run yet. `PermissionGuard`
 * calls this instead of `TenantContext.run` directly, which is what keeps
 * `TenantContext.run`'s call sites confined to this package, `packages/auth`,
 * tenant provisioning and the job runner (the ESLint rule in
 * `eslint.config.mjs`) — `apps/api` never calls `TenantContext.run` itself.
 *
 * `principal` MUST already be verified — this performs no verification of
 * its own, exactly like `TenantContext.run`. The only legitimate source is
 * `req.auth`, set by `TenantGuard` from a signature-checked JWT claim.
 */
export async function withTenantAsPrincipal<T>(
  principal: TenantPrincipal,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return TenantContext.run(principal, () => withTenant(fn))
}

/* ------------------------------------------------------------------ *
 * withGlobal
 * ------------------------------------------------------------------ */

/**
 * The narrow exception, for work that legitimately has no tenant
 * (ADR-0013:100):
 *
 *   - login, before the tenant claim exists
 *   - tenant provisioning, before the tenant exists
 *   - global reference data: currency codes, country codes, COA templates
 *   - the outbox dispatcher enumerating tenants, before setting each batch's
 *     tenant id (ADR-0019)
 *   - schema_migrations
 *
 * That list is the whole list. It is named in the ADR precisely so this does
 * not become the general-purpose escape hatch the first agent in a hurry
 * reaches for — and the type makes the point better than the comment does:
 * the handle is a `Transaction<GlobalDatabase>`, so a tenant-owned table is
 * not addressable inside the block. `tx.selectFrom('users')` does not
 * compile.
 *
 * It does not set `app.tenant_id`, and must not. A global block that quietly
 * set a tenant would be `withTenant` with the safety removed.
 */
export async function withGlobal<T>(fn: (tx: GlobalTx) => Promise<T>): Promise<T> {
  return globalDb()
    .transaction()
    .execute(async (trx) => {
      issuedGlobal.add(trx)
      return fn(trx as GlobalTx)
    })
}

/* ------------------------------------------------------------------ *
 * withResolvedTenant — ADR-0023 §3
 *
 * Login and refresh both need a tenant-owned read *before* any tenant is
 * known — establishing the tenant is what the read is for. Neither
 * `withTenant` (needs `TenantContext` already set) nor `withGlobal` (cannot
 * name a tenant-owned table) fits, so this is the third helper ADR-0023 §3
 * calls for, in the one file that already owns the brand pattern and the
 * `set_config` call site.
 *
 * Every requirement in ADR-0023 §3 is structural here, not a convention:
 *
 *   1. This is the ONLY function that may call a resolver. The two resolvers
 *      that exist (`auth/resolvers.ts`, both internal to this package) are
 *      never called from anywhere else, and nothing outside this module can
 *      construct the `PreTenantTx` a resolver requires.
 *   2. `fn` receives a `TenantTx` only after `set_config('app.tenant_id', …)`
 *      has been awaited — no tenant-table statement can run before it.
 *   3. The value passed to `set_config` is `resolved.tenantId`, and nothing
 *      else is in scope in this function that could be substituted for it —
 *      no request body, no header, no argument threaded through from a
 *      caller.
 *   4. `set_config` is called exactly once, at this one call site.
 * ------------------------------------------------------------------ */

declare const RESOLVED_TENANT: unique symbol

/**
 * A tenant id that came from a resolver run inside `withResolvedTenant`.
 *
 * Wrapped in an object and tracked in a `WeakSet`, exactly like `TenantTx`
 * above — a bare branded `string` can always be produced with `as` by
 * anyone who can name the type, which defeats the point of branding a
 * primitive. Wrapping it in an object this module itself allocates means a
 * forged value fails `assertIssuedResolvedTenantId` even though it
 * typechecks.
 */
export type ResolvedTenantId = { readonly value: string } & {
  readonly [RESOLVED_TENANT]: 'resolved-tenant'
}

const issuedResolvedTenantId = new WeakSet<object>()

/**
 * Not exported from the package. The only callers are the two resolvers in
 * `auth/resolvers.ts`, which run *inside* the `PreTenantTx` this module
 * hands them and nowhere else — so a `ResolvedTenantId` can only ever
 * originate from the global `tenants`-by-code read (login) or migration
 * 006's `auth_lookup.resolve_refresh` (refresh).
 */
export function brandResolvedTenantId(value: string): ResolvedTenantId {
  const branded = { value } as ResolvedTenantId
  issuedResolvedTenantId.add(branded)
  return branded
}

function assertIssuedResolvedTenantId(id: ResolvedTenantId): void {
  if (!issuedResolvedTenantId.has(id)) {
    throw new TransactionScopeError(
      'This is not a ResolvedTenantId issued by a resolver running inside withResolvedTenant. ' +
        'A cast does not make one (ADR-0023 §3).',
    )
  }
}

declare const PRE_TENANT_TX: unique symbol

/**
 * What a resolver may do: read the global `tenants` table with the ordinary
 * typed builder, or run a parameterised raw statement — the shape
 * `auth_lookup.resolve_refresh` needs, since it is a function call rather
 * than a table. Nothing else is reachable: a tenant-owned table is not on
 * `GlobalDatabase`, so `tx.selectFrom('users')` does not compile here, and
 * the raw escape hatch is what migration 006's function call requires.
 */
export type PreTenantTx = Transaction<GlobalDatabase> & {
  readonly [PRE_TENANT_TX]: 'pre-tenant'
  raw<R>(text: string, parameters?: readonly unknown[]): Promise<R[]>
}

export interface Resolved<Extra> {
  readonly tenantId: ResolvedTenantId
  readonly extra: Extra
}

/**
 * Run `fn` in a transaction whose tenant is established by `resolve`,
 * rather than read from `TenantContext` (which does not exist yet on this
 * path). Returns `null` when `resolve` finds nothing — an unknown tenant
 * code, or an unknown/expired refresh token hash — without ever setting a
 * tenant.
 */
export async function withResolvedTenant<Extra, T>(
  resolve: (tx: PreTenantTx) => Promise<Resolved<Extra> | null>,
  /**
   * `tenantId` is the resolver's own return value, handed back as a plain
   * string for convenience once it has already done its one job — proving,
   * via the brand check above, that it came from a resolver and not from
   * request input. Callers use it only to re-state the resolved tenant as an
   * explicit predicate alongside the row the resolver named (ADR-0023 §2:
   * "the spend statement additionally carries tenant_id = $resolved AND
   * id = $resolved_token_id"), never to choose a different one.
   */
  fn: (tx: TenantTx, extra: Extra, tenantId: string) => Promise<T>,
): Promise<T | null> {
  return fullDb()
    .transaction()
    .execute(async (trx) => {
      const preTenantTx = Object.assign(trx, {
        raw<R>(text: string, parameters: readonly unknown[] = []): Promise<R[]> {
          return trx
            .executeQuery<R>(CompiledQuery.raw(text, [...parameters]))
            .then((result) => [...result.rows])
        },
      }) as unknown as PreTenantTx

      const resolved = await resolve(preTenantTx)
      if (!resolved) return null

      assertIssuedResolvedTenantId(resolved.tenantId)

      await sql`select set_config('app.tenant_id', ${resolved.tenantId.value}, true)`.execute(trx)

      issuedTenant.add(trx)
      return fn(trx as TenantTx, resolved.extra, resolved.tenantId.value)
    })
}
