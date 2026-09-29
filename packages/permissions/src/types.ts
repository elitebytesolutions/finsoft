/*
 * The auth contract this package depends on, pending packages/auth.
 *
 * The real shape — `AuthContext { userId, tenantId, sessionId,
 * permissionVersion, mfa }` — is exported from `@finsoft/shared-types` once
 * the m1-auth lane lands it, and the real guard puts it on the request as
 * `req.auth`. Until then this package (and apps/api/src/common/permission.guard.ts)
 * depends on nothing more than the two fields it actually needs, declared
 * locally rather than by reaching into packages/shared-types or packages/auth
 * ahead of that lane — both are FORBIDDEN paths for this brief.
 *
 * `RequestAuth` is a structural subset of the eventual `AuthContext`, so the
 * guard keeps working unmodified once the real type replaces this one at the
 * call site.
 */
export interface RequestAuth {
  readonly userId: string
  readonly tenantId: string
}
