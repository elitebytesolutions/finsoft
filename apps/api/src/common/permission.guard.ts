import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { withTenant } from '@finsoft/database'
import { resolvePermissions, type PermissionCode, type RequestAuth } from '@finsoft/permissions'
import { REQUIRE_PERMISSION } from './permission.decorator.ts'

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
 * A route with no `@RequirePermission` metadata is unaffected: this guard
 * returns `true` immediately and defers entirely to whatever ran before it.
 * See permission.decorator.ts for why that is opt-in rather than a second,
 * stacked default-deny.
 *
 * Responses:
 *   no `req.auth`                          -> 401
 *   `req.auth` present, permission missing -> 403 {statusCode, error, message}
 *   permission present                     -> the handler runs
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionCode[] | undefined>(
      REQUIRE_PERMISSION,
      [context.getHandler(), context.getClass()],
    )

    if (!required || required.length === 0) return true

    const request = context.switchToHttp().getRequest<{ auth?: RequestAuth }>()
    const auth = request.auth

    if (!auth) {
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
