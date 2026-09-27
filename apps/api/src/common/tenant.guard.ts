import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { SessionInactiveError, TokenVerificationError, verifyBearerToken } from '@finsoft/auth'
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
 * The global tenant/authentication guard. ADR-0009, ADR-0023, W1-003.
 *
 * Verifies the bearer token (algorithm pinned to RS256 — `@finsoft/auth`'s
 * `verifyAccessToken`, never trusting the token's own `alg` header),
 * confirms the session is `ACTIVE` (Redis-cached, PostgreSQL is the source
 * of truth), and attaches the verified `AuthContext` to `req.auth`.
 *
 * WHY THIS DOES NOT ITSELF ESTABLISH `TenantContext` (the AsyncLocalStorage
 * layer) FOR THE REST OF THE REQUEST: a NestJS `CanActivate` guard cannot
 * causally wrap Nest's downstream interceptor/handler execution in an
 * `AsyncLocalStorage.run()` call — the guard returns a value, and Nest's own
 * continuation that follows is not a descendant of any `run()` this guard
 * invokes, so a context entered here would not survive past this function
 * (only Express middleware calling `next()` *inside* `run()`'s callback can
 * do that, because everything Express then does IS a causal descendant of
 * that call). Introducing global request-scoped middleware for this was
 * judged out of scope for M1-A — see the delivery report's DECISIONS.
 *
 * Instead: `req.auth` carries the verified `{tenantId, userId, sessionId,
 * permissionVersion, mfa}`, and each handler that needs the database
 * establishes `TenantContext.run({tenantId, userId}, …)` itself, scoped to
 * its own operation — exactly the pattern `AuthService.me`/`.logout` and
 * `@finsoft/auth`'s own `logout.ts`/`session-cache.ts` already use. Header,
 * body, query and path values never influence any of it: the only inputs to
 * `TenantContext.run` anywhere in this codebase are `req.auth`'s fields.
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
      if (error instanceof TokenVerificationError || error instanceof SessionInactiveError) {
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
