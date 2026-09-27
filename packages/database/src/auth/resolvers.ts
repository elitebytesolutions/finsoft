import { brandResolvedTenantId, type PreTenantTx, type Resolved } from '../transaction.ts'

/*
 * The two pre-tenant resolvers ADR-0023 sanctions. Nothing else in this
 * package, or outside it, may construct a `ResolvedTenantId` — see
 * `brandResolvedTenantId`'s own comment in transaction.ts. Not exported from
 * `index.ts`: `packages/auth` calls `findLoginCandidate` and
 * `spendRefreshToken` in `./login.ts` / `./refresh.ts`, never a resolver
 * directly.
 */

export interface ResolvedTenantRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly status: string
}

/**
 * ADR-0023 §1. Login's resolver: the global `tenants` table, by exact code.
 * `tenants` carries no RLS at all (ADR-0004:77), so an ordinary read is the
 * whole mechanism — this is not the SECURITY DEFINER path.
 *
 * The caller normalises the code (upper-cased — `tenants.code` is
 * upper-case-only by its own CHECK) before this is called; this function
 * does not normalise, so that normalisation stays visible at one call site
 * (the login DTO) rather than being duplicated here.
 */
export function tenantByCodeResolver(
  code: string,
): (tx: PreTenantTx) => Promise<Resolved<{ tenant: ResolvedTenantRow }> | null> {
  return async (tx) => {
    const tenant = await tx
      .selectFrom('tenants')
      .select(['id', 'code', 'name', 'status'])
      .where('code', '=', code)
      .executeTakeFirst()

    if (!tenant) return null
    return { tenantId: brandResolvedTenantId(tenant.id), extra: { tenant } }
  }
}

/**
 * ADR-0023 §2. Refresh's resolver: migration 006's
 * `auth_lookup.resolve_refresh`, a `SECURITY DEFINER` function owned by
 * `finsoft_refresh` (`NOLOGIN`, `NOBYPASSRLS`), crossing the tenant boundary
 * through a named policy rather than a role attribute. Returns
 * `(tenant_id, token_id)` and no state — the resolver decides WHERE;
 * migration 005's atomic spend (ADR-0022) decides WHETHER.
 *
 * A raw call, not a typed one: this is a function, not a table on
 * `GlobalDatabase`, and it is the one case `PreTenantTx.raw` exists for.
 */
export function refreshTokenResolver(
  tokenHash: string,
): (tx: PreTenantTx) => Promise<Resolved<{ tokenId: string }> | null> {
  return async (tx) => {
    const rows = await tx.raw<{ tenant_id: string; token_id: string }>(
      'select tenant_id, token_id from auth_lookup.resolve_refresh($1)',
      [tokenHash],
    )
    const row = rows[0]
    if (!row) return null
    return { tenantId: brandResolvedTenantId(row.tenant_id), extra: { tokenId: row.token_id } }
  }
}
