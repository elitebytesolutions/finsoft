import { TenantContext } from '../tenant-context.ts'
import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'

/*
 * The acting principal for a kernel operation. Council ruling (Architecture
 * + Security seats, M2-A T3 final review): `TenantContext` stays importable
 * only inside packages/database (and packages/auth) — M1-X T2's rule is
 * correct and does not change. What changes is that the kernel gets a
 * narrow, read-only accessor here instead of importing `TenantContext`
 * itself.
 *
 * `postingPrincipalOf` is the ONLY way `packages/accounting-kernel` learns
 * the acting tenant/user. It:
 *
 *   1. Requires an issued `TenantTx` (`assertIssuedTenantTx`) — the same
 *      proof of a real, package-issued transaction handle every other
 *      accounting query in this package requires.
 *   2. Reads `TenantContext.require()` — this file is inside
 *      packages/database, where that import is allowed.
 *   3. Returns a FROZEN COPY, never the live `AsyncLocalStorage` store
 *      object `TenantContext.require()` itself hands back. `TenantPrincipal`
 *      marks its fields `readonly` at the type level only; nothing stops a
 *      caller from casting past that and mutating the object TypeScript
 *      handed it. Freezing a fresh copy here means that even a caller that
 *      does cast past `readonly` gets a `TypeError` (strict mode) or a
 *      silent no-op, and can never reach — let alone mutate — the ambient
 *      principal the rest of the request still relies on.
 *
 * Not a general-purpose "give me the tenant" accessor: it exists because the
 * kernel's own commands (`PostCommand`, `ReverseCommand`, `periodEngine`'s
 * methods) deliberately carry no `tenantId`/`actorUserId` field (ADR-0013:88
 * — a parameter threaded through is a parameter a caller can eventually
 * substitute). The acting principal comes from the transaction's own
 * ambient scope, the same way `withTenant` itself does, not from anything a
 * caller passes in.
 */
export interface PostingPrincipal {
  readonly tenantId: string
  readonly userId: string | null
}

export function postingPrincipalOf(tx: TenantTx): Readonly<PostingPrincipal> {
  assertIssuedTenantTx(tx)
  const { tenantId, userId } = TenantContext.require()
  return Object.freeze({ tenantId, userId })
}
