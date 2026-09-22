import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

/**
 * Marks a route as reachable without a tenant context.
 *
 * Deliberately sparse. Infrastructure endpoints — health, readiness — and,
 * when Wave 1 builds them, login and tenant provisioning are the only
 * legitimate users. ADR-0004:77 is the test: does this operate purely on
 * global tables?
 */
export const PUBLIC_ROUTE = 'finsoft:public-route'
export const Public = () => SetMetadata(PUBLIC_ROUTE, true)

/**
 * The global tenant guard.
 *
 * **This is a stub, and it fails closed on purpose.** Authentication is Wave 1
 * (`packages/auth`), so there is no verified JWT to read a tenant claim from
 * yet. Until there is, every route that is not explicitly `@Public()` is
 * refused.
 *
 * The alternative — letting requests through untenanted until auth arrives —
 * would mean the first feature endpoint built in Wave 1 runs without tenant
 * isolation and nobody notices, because nothing failed. A 401 on an endpoint
 * that does not exist yet costs nothing; a permissive default costs a
 * cross-tenant read.
 *
 * When Wave 1 lands, this guard reads `tenant_id` from the verified token and
 * establishes `TenantContext` — from the signed claim only, never from a
 * body, query, path, header, cookie or job payload (ADR-0004:75, rule 8).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ])

    if (isPublic) return true

    // No authentication yet, so no request can present a verified tenant.
    // Refusing is the honest answer and the safe one.
    return false
  }
}
