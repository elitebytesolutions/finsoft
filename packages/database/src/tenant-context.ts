import { AsyncLocalStorage } from 'node:async_hooks'

/*
 * TenantContext. ARCHITECTURE §6, ADR-0003, ADR-0004.
 *
 * Layer two of four:
 *
 *   JWT / session          tenant_id is a signed claim (ADR-0009)
 *   TenantContext          <- this file
 *   Repository layer       every query filtered (repository.ts)
 *   PostgreSQL RLS         policy per table (database/migrations/*.sql)
 *
 * AsyncLocalStorage rather than a parameter threaded through every signature,
 * because a parameter that is threaded everywhere is a parameter that will
 * eventually be passed the wrong value by someone in a hurry. The context is
 * established once, by the guard, from the verified token — and nothing
 * downstream can choose a different tenant, because nothing downstream is
 * offered the choice: `withTenant` takes no tenant argument (ADR-0013:88).
 *
 * Rule 8: the tenant is never read from a request body, query string, path
 * parameter, header, cookie or job payload. The only caller of `run` is the
 * authentication guard (FND-009) and the job runner, each from a value that
 * was verified or persisted, never received.
 */

/** Shape of a uuid as PostgreSQL will accept it. Not version-specific. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantContextError'
  }
}

export interface TenantPrincipal {
  /** From the signed `tenant_id` claim. Never from request input. */
  readonly tenantId: string

  /**
   * The acting user, for created_by / updated_by and the audit record.
   *
   * Null only where no user acts: tenant provisioning creates the first user
   * of a tenant, and there is nobody to name as its author. Populated by the
   * auth guard in FND-009.
   */
  readonly userId: string | null
}

const storage = new AsyncLocalStorage<TenantPrincipal>()

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new TenantContextError(
      `${field} is not a uuid. The tenant context is established from a verified token claim ` +
        '(ADR-0009); a value that is not a uuid means something unverified reached it.',
    )
  }
}

export const TenantContext = {
  /**
   * Run `fn` with this principal in scope.
   *
   * Validation happens here, at the boundary, rather than at the point of
   * use. `set_config` passes the value as a bind parameter so there is no
   * injection surface either way, but a malformed tenant should be rejected
   * where the caller can still be identified — not five frames later as a
   * PostgreSQL cast error.
   */
  run<T>(principal: TenantPrincipal, fn: () => T): T {
    assertUuid(principal.tenantId, 'tenantId')
    if (principal.userId !== null) assertUuid(principal.userId, 'userId')
    return storage.run(principal, fn)
  },

  /** The current principal, or undefined outside any tenant scope. */
  current(): TenantPrincipal | undefined {
    return storage.getStore()
  },

  /**
   * The current principal, or an error.
   *
   * Deliberately loud, for the same reason ADR-0004:77 leaves
   * `app.tenant_id` with no cluster default: work that has lost its tenant
   * must stop, not fall back to something permissive.
   */
  require(): TenantPrincipal {
    const principal = storage.getStore()
    if (!principal) {
      throw new TenantContextError(
        'No tenant context. Tenant-scoped work runs inside TenantContext.run(), established by ' +
          'the auth guard from the verified JWT claim. Work that legitimately has no tenant — ' +
          'login, tenant provisioning, the outbox dispatcher enumerating tenants — uses ' +
          'withGlobal() and can only reach global tables.',
      )
    }
    return principal
  },

  isSet(): boolean {
    return storage.getStore() !== undefined
  },
} as const
