import { TenantContext, TenantContextError, type TenantPrincipal } from './tenant-context.ts'
import { withTenant, type TenantTx } from './transaction.ts'

/*
 * `@finsoft/database/request-scope` — a separate, narrow entrypoint.
 * M1-X, Council T1 (Architecture R1 / Security 1 / Database C1).
 *
 * Not exported from the package root, and not importable from anywhere but
 * `apps/api/src/common/permission.guard.ts` (ESLint rule in
 * `eslint.config.mjs`, with a case in `tests/security/lint-boundaries.spec.ts`).
 * Exporting `withTenantAsPrincipal` from the same surface as `withTenant`
 * invites it to be reached for "just this once" from a handler or a service
 * — which would reopen exactly the door C5 closed: `apps/api` establishing
 * tenant scope on its own, from wherever it likes, instead of through the
 * one interceptor that does it for the whole request.
 */

/**
 * Establish `TenantContext` from an already-verified `principal` and run
 * `fn` inside a tenant transaction, in one call.
 *
 * WHY THIS EXISTS: the request-wide `TenantContext` is normally established
 * once, by `apps/api/src/common/tenant-context.interceptor.ts`, for the
 * whole request. But NestJS runs every GUARD before any interceptor — there
 * is no way to interleave them — so a guard that itself needs a
 * `TenantTx` (as `PermissionGuard` does, to resolve the caller's permission
 * set) cannot rely on that interceptor: it has not run yet. `PermissionGuard`
 * calls this instead of `TenantContext.run` directly.
 *
 * `principal` MUST already be verified — this performs no verification of
 * its own, exactly like `TenantContext.run`. The only legitimate source is
 * `req.auth`, set by `TenantGuard` from a signature-checked JWT claim.
 *
 * THROWS if a DIFFERENT principal is already in scope. This function exists
 * for exactly one caller running at exactly one point in the request
 * lifecycle (before the interceptor has had a chance to run) — a call that
 * finds an ambient context already active, and disagreeing with the one it
 * was asked to establish, means either a caller this function was not
 * designed for, or two guards racing to scope the same request differently.
 * Either way, silently switching tenants mid-request is the failure mode
 * rule 8 exists to prevent; refusing loudly is the correct response. A call
 * that finds the SAME principal already active (or none at all) proceeds
 * normally — re-entrant, and harmless.
 */
export async function withTenantAsPrincipal<T>(
  principal: TenantPrincipal,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const current = TenantContext.current()
  if (current && (current.tenantId !== principal.tenantId || current.userId !== principal.userId)) {
    throw new TenantContextError(
      'withTenantAsPrincipal: a different principal is already in scope ' +
        `(tenantId=${current.tenantId}, userId=${current.userId ?? 'null'}) than the one requested ` +
        `(tenantId=${principal.tenantId}, userId=${principal.userId ?? 'null'}). This function ` +
        'establishes a narrow, guard-scoped context for exactly one caller and refuses to ' +
        'override an ambient one rather than silently switching tenants mid-request (rule 8).',
    )
  }
  return TenantContext.run(principal, () => withTenant(fn))
}
