import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import {
  AccountInactiveError,
  PermissionVersionStaleError,
  SessionInactiveError,
  TokenVerificationError,
  verifyBearerToken,
} from '@finsoft/auth'
import type { AuthContext } from '@finsoft/shared-types'
import type { Request } from 'express'

/*
 * Marks a route as reachable without a tenant context. ADR-0004:77's test:
 * does this operate purely on global tables (or, for login/refresh/jwks, on
 * the one pre-tenant resolver ADR-0023 sanctions)?
 */
export const PUBLIC_ROUTE = 'finsoft:public-route'
export const Public = () => SetMetadata(PUBLIC_ROUTE, true)

declare module 'express' {
  interface Request {
    /**
     * The verified, server-asserted caller. Set ONLY here, from a
     * signature-checked JWT claim — never from a header, body, query string
     * or path parameter (rule 8, ADR-0009:84). Every handler that needs the
     * tenant or the acting user reads this, and nothing else.
     */
    auth?: AuthContext
  }
}

/**
 * The global authentication guard. ADR-0009, ADR-0023, M1-X.
 *
 * Verifies the bearer token (algorithm pinned to RS256 — `@finsoft/auth`'s
 * `verifyAccessToken`, never trusting the token's own `alg` header),
 * confirms the session is `ACTIVE` (Redis-cached, PostgreSQL is the source
 * of truth), and attaches the verified `AuthContext` to `req.auth`. Despite
 * the file/class name, this is where authentication is decided — not where
 * `TenantContext` (the AsyncLocalStorage layer, ADR-0004) gets established;
 * see below.
 *
 * WHY THIS GUARD DOES NOT ITSELF ESTABLISH `TenantContext` FOR THE REST OF
 * THE REQUEST: a NestJS `CanActivate` guard cannot causally wrap Nest's
 * downstream interceptor/handler execution in an `AsyncLocalStorage.run()`
 * call — the guard returns a value, and Nest's own continuation that follows
 * is not a descendant of any `run()` this guard invokes, so a context
 * entered here would not survive past this function.
 *
 * THE ACTUAL MECHANISM, as of M1-X Council condition C5:
 * `TenantContextInterceptor` (`tenant-context.interceptor.ts`) runs after
 * this guard (Nest's own guards-before-interceptors ordering) and
 * establishes `TenantContext` from `req.auth` for the whole rest of the
 * request — see that file's header comment for why an interceptor, and not
 * a guard or Express middleware, is where that becomes possible. The one
 * exception is `PermissionGuard`, which runs as a guard (before
 * `TenantContextInterceptor` has had a chance to run) and therefore needs
 * its own narrow, request-scoped principal to resolve permissions with —
 * see `permission.guard.ts` and `@finsoft/database/request-scope`'s
 * `withTenantAsPrincipal`. Every other handler, and `@finsoft/auth`'s own
 * `logout.ts`/`session-cache.ts` callers, run inside the ambient
 * `TenantContext` the interceptor already established; none of them need to
 * open their own. Header, body, query and path values never influence any
 * of it: the only inputs to `TenantContext.run` anywhere in this codebase
 * are `req.auth`'s fields.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ])

    if (isPublic) return true

    const request = context.switchToHttp().getRequest<Request>()
    const header = request.headers['authorization']

    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'unauthenticated',
        message: 'A bearer access token is required.',
      })
    }

    const token = header.slice('Bearer '.length).trim()

    try {
      request.auth = await verifyBearerToken(token)
      return true
    } catch (error) {
      if (
        error instanceof TokenVerificationError ||
        error instanceof SessionInactiveError ||
        // M1-X, L1: an inactive user/tenant or a stale perm_ver claim are
        // both, from the caller's point of view, an invalid credential —
        // the identical 401 as every other rejection on this path. Neither
        // is disclosed more specifically: "your account is suspended" would
        // be exactly the enumeration/DoS-confirmation oracle ADR-0023 §4
        // item 4 forbids at login, and the access-token path must not leak
        // what login already refuses to.
        error instanceof AccountInactiveError ||
        error instanceof PermissionVersionStaleError
      ) {
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'unauthenticated',
          message: 'The access token is missing, invalid, expired or revoked.',
        })
      }
      throw error
    }
  }
}
