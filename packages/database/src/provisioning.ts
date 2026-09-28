/*
 * `@finsoft/database/provisioning` — a separate, narrow entrypoint.
 *
 * `createAuditChainAnchor` is not exported from the package root
 * (`@finsoft/database`, index.ts). It is a privileged, one-time-per-tenant
 * operation — the seq=0 anchor, written under the terminal advisory lock
 * (LOCK_REGISTRY.md position 6), in the SAME transaction as the tenant's own
 * `tenants` row, before that tenant is generally visible (ADR-0020 §5). It
 * has exactly one legitimate caller: whatever creates a tenant. Exporting it
 * from the same surface as `recordAudit`/`withTenant`/`listAuditEvents`
 * invites it to be called from an ordinary request handler "just to be
 * safe" — which would take the terminal lock and write a row outside the
 * one place ADR-0020 §5 sanctions it.
 *
 * `packages/database/src/testing/harness.ts`'s `createTenantFixture` imports
 * directly from `./audit/anchor.ts`, not through this file — it is inside
 * the package, not a consumer of its public surface. Real tenant
 * provisioning code, wherever it is eventually built, imports from
 * `@finsoft/database/provisioning`.
 */
export { createAuditChainAnchor } from './audit/anchor.ts'
