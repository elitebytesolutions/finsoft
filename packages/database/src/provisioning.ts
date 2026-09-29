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
 *
 * `seedChartOfAccounts` and `createFiscalYear` (M2-A) join this surface for
 * the same reason: coa-standard.md §6 and periods.md §3 both require the
 * template and the fiscal year to be created "in the same transaction that
 * creates the tenant" — provisioning-time operations, not something an
 * ordinary request handler calls. Unlike `createAuditChainAnchor` they are
 * NOT privileged in the RLS sense (no advisory lock, no BYPASSRLS
 * consideration) — they are ordinary tenant-scoped inserts under
 * `withTenant`, kept on this narrow surface purely to keep "what tenant
 * provisioning does" in one place rather than scattering it across the
 * general-purpose root export.
 */
export { createAuditChainAnchor } from './audit/anchor.ts'
export { hasChartOfAccounts, seedChartOfAccounts } from './accounting/accounts.ts'
export { createFiscalYear, hasFiscalYear } from './accounting/periods.ts'
