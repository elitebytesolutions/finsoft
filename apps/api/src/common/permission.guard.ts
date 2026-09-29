import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { withTenantAsPrincipal } from '@finsoft/database'
import { resolvePermissions, type PermissionCode, type RequestAuth } from '@finsoft/permissions'
import { REQUIRE_PERMISSION } from './permission.decorator'

/**
 * Enforces `@RequirePermission(...)`. Rule 18: every permission is checked
 * server-side, from the database — never trusted from the token.
 *
 * **Runs after `TenantGuard`, as a second global `APP_GUARD`** (M1-X,
 * SEC-C1/C2 — see `app.module.ts`, and `tests/integration/guard-order.spec.ts`
 * for the assertion that the order holds). It reads `req.auth`, which that
 * guard is the only thing that sets, from a verified JWT — never from a
 * body, query string, path parameter or header (rule 8).
 *
 * A route with NEITHER its handler NOR its controller class carrying
 * `@RequirePermission` metadata is unaffected: this guard returns `true`
 * immediately and defers entirely to whatever ran before it. See
 * permission.decorator.ts for why that is opt-in rather than a second,
 * stacked default-deny — the startup check that every route is one of
 * `@Public`/`@RequirePermission`/`@AuthenticatedOnly` (`route-decoration.check.ts`)
 * is what closes that gap instead.
 *
 * `@RequirePermission()` called with NO codes is a caller mistake, not "no
 * requirement" — SEC-C3. It throws rather than silently passing every
 * request, which is what treating an empty array the same as "absent" would
 * do. Handler- and class-level decorators COMBINE (`getAllAndMerge`) rather
 * than the closer one overriding the other, so a permission required at the
 * controller level cannot be silently dropped by a method-level decorator
 * that names a different, narrower permission.
 *
 * **C5 ordering, and why this guard does not read an ambient `TenantContext`.**
 * NestJS runs every GUARD before any INTERCEPTOR, with no way to interleave
 * them. `TenantContextInterceptor` establishes `TenantContext` for the whole
 * request — but it is an interceptor, so it has not run yet by the time THIS
 * guard executes. Waiting for it, or checking `TenantContext.current()`
 * against `req.auth` (the previous SEC-C6 shape), would 401 every legitimate
 * request under the new architecture, not just unauthorized ones. Instead
 * this guard establishes its OWN narrow, guard-scoped tenant context for
 * exactly the one query it needs — via `withTenantAsPrincipal`, sourced
 * `req.auth` and nothing else — which keeps `TenantContext.run`'s call sites
 * confined to `packages/database`, `packages/auth`, provisioning and the job
 * runner (never `apps/api` directly; see the ESLint rule in
 * `eslint.config.mjs`). The rest of the request (the handler, and anything
 * it calls) still runs inside the interceptor's own, separately-established
 * context — the two scopes agree because both are minted from the same
 * verified `req.auth`, never compared against each other, because after C5
 * there is nothing meaningful left to compare: minting is verification here.
 *
 * Responses:
 *   no @RequirePermission anywhere on the route         -> handler runs
 *   @RequirePermission() with no codes                  -> throws (config bug)
 *   no `req.auth`                                        -> 401
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

    const granted = await withTenantAsPrincipal({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      resolvePermissions(tx, auth.userId),
    )
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
