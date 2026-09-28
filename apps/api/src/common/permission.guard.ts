import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { TenantContext, withTenant } from '@finsoft/database'
import { resolvePermissions, type PermissionCode, type RequestAuth } from '@finsoft/permissions'
import { REQUIRE_PERMISSION } from './permission.decorator'

/**
 * Enforces `@RequirePermission(...)`. Rule 18: every permission is checked
 * server-side, from the database — never trusted from the token.
 *
 * **Runs after the authentication/tenancy guard.** It reads `req.auth`,
 * which that guard is the only thing that sets, from a verified JWT — never
 * from a body, query string, path parameter or header (rule 8). Until
 * `packages/auth` lands the real `AuthContext` and its guard, `req.auth` is
 * typed here as the minimal local `RequestAuth` (`{ userId, tenantId }`)
 * declared in `packages/permissions`, per this brief's contract with the
 * auth lane — not by reaching into `packages/shared-types` or
 * `packages/auth` ahead of that lane, both FORBIDDEN paths here.
 *
 * A route with NEITHER its handler NOR its controller class carrying
 * `@RequirePermission` metadata is unaffected: this guard returns `true`
 * immediately and defers entirely to whatever ran before it. See
 * permission.decorator.ts for why that is opt-in rather than a second,
 * stacked default-deny — the startup check that every route is one of
 * `@Public`/`@RequirePermission`/`@AuthenticatedOnly` is a separate,
 * deferred piece of work (M1-X).
 *
 * `@RequirePermission()` called with NO codes is a caller mistake, not "no
 * requirement" — SEC-C3. It throws rather than silently passing every
 * request, which is what treating an empty array the same as "absent" would
 * do. Handler- and class-level decorators COMBINE (`getAllAndMerge`) rather
 * than the closer one overriding the other, so a permission required at the
 * controller level cannot be silently dropped by a method-level decorator
 * that names a different, narrower permission.
 *
 * Responses:
 *   no @RequirePermission anywhere on the route         -> handler runs
 *   @RequirePermission() with no codes                  -> throws (config bug)
 *   no `req.auth`                                        -> 401
 *   `req.auth` present but TenantContext missing/mismatched -> 401 (SEC-C6,
 *     never a 500 from a context that withTenant would otherwise reject)
 *   `req.auth` present, permission missing               -> 403 {statusCode, error, message}
 *   permission present                                   -> the handler runs
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler()
    const klass = context.getClass()

    /*
     * Presence and content are two different questions, and getAllAndMerge
     * alone cannot answer the first: a route with no decorator at all and a
     * route decorated with `@RequirePermission()` (zero codes) both merge to
     * `[]`. `get` per target, checked before merging, is what tells them
     * apart.
     */
    const handlerMeta = this.reflector.get<PermissionCode[] | undefined>(
      REQUIRE_PERMISSION,
      handler,
    )
    const classMeta = this.reflector.get<PermissionCode[] | undefined>(REQUIRE_PERMISSION, klass)

    if (handlerMeta === undefined && classMeta === undefined) {
      return true
    }

    const required = this.reflector.getAllAndMerge<PermissionCode[]>(REQUIRE_PERMISSION, [
      handler,
      klass,
    ])

    if (required.length === 0) {
      throw new Error(
        '@RequirePermission() was called with no codes. Name at least one permission, or ' +
          'remove the decorator — an empty list is a configuration mistake, never "no ' +
          'requirement" (SEC-C3).',
      )
    }

    const request = context.switchToHttp().getRequest<{ auth?: RequestAuth }>()
    const auth = request.auth

    if (!auth) {
      throw new UnauthorizedException()
    }

    /*
     * SEC-C6. TenantContext is established by the authentication guard from
     * the verified JWT (ADR-0004, ADR-0009) — the same source req.auth comes
     * from. If it is missing, or names a different tenant or user than
     * req.auth claims, something upstream is broken or being tampered with;
     * either way `withTenant` below would throw a TenantContextError that
     * propagates as an uncaught 500. Checking here turns that into the
     * correct response for an authorization failure: 401, never a 500.
     */
    const principal = TenantContext.current()
    if (!principal || principal.tenantId !== auth.tenantId || principal.userId !== auth.userId) {
      throw new UnauthorizedException()
    }

    const granted = await withTenant((tx) => resolvePermissions(tx, auth.userId))
    const missing = required.filter((code) => !granted.has(code))

    if (missing.length > 0) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'forbidden',
        message: 'You do not have permission to do this.',
      })
    }

    return true
  }
}
