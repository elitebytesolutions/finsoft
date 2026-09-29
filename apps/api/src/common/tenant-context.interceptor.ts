import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable } from 'rxjs'
import { TenantContext } from '@finsoft/database'
import type { Request } from 'express'

/**
 * Establishes `TenantContext` (the `AsyncLocalStorage` layer, ADR-0004) for
 * the whole rest of the request, from the verified `req.auth` `TenantGuard`
 * set — and from nothing else. M1-X, Council condition C5.
 *
 * WHY AN INTERCEPTOR, AND WHY NOT THE GUARD ITSELF. `TenantGuard`'s own
 * header comment already explains why a `CanActivate` guard cannot do this:
 * a guard returns a value to Nest's own dispatcher, which THEN runs the rest
 * of the pipeline as a separate continuation — not a descendant of any
 * `AsyncLocalStorage.run()` the guard invoked, so a context entered inside
 * `canActivate` does not survive past it. An interceptor's `intercept()`
 * method is handed the actual continuation (`next: CallHandler`), which
 * makes it the first point in Nest's own lifecycle where establishing a
 * scope around "the rest of this request" is possible at all.
 *
 * WHY RETURNING `TenantContext.run(principal, () => next.handle())` IS NOT
 * ENOUGH EITHER. `next.handle()` returns an RxJS `Observable` that Nest
 * composes lazily (`defer`) and does not SUBSCRIBE to until its own router
 * execution context does so, after `intercept()` has already returned — by
 * which point `TenantContext.run`'s synchronous callback has already
 * finished and the AsyncLocalStorage scope is gone. Merely calling
 * `next.handle()` inside the callback constructs the Observable; it does not
 * run the handler.
 *
 * THE FIX mirrors the one already proven in this codebase for Express
 * middleware (see `tests/integration/audit-api.spec.ts`'s header comment):
 * force the actual work to happen — by subscribing — synchronously, from
 * inside `TenantContext.run`'s own callback, so the handler's execution (and
 * every `await` it schedules) is a causal descendant of THIS call, not of
 * some later, unscoped subscription performed by Nest's own internals.
 *
 * A route with no `req.auth` (a `@Public()` route, or one whose guard chain
 * never set it) runs with no tenant context — exactly as it does today. That
 * is correct: `withTenant`/`withGlobal` already enforce, at the database
 * layer, which code may run with no tenant set, and a public route has no
 * verified principal to establish one from in the first place.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>()
    const auth = request.auth

    if (!auth) {
      return next.handle()
    }

    const principal = { tenantId: auth.tenantId, userId: auth.userId }

    return new Observable((subscriber) => {
      // The explicit `return` matters: TenantContext.run(principal, fn)
      // returns fn()'s own return value, and the Observable executor's
      // return value is what RxJS calls to tear down the subscription. A
      // block body with no `return` here would discard the teardown
      // function and leak the inner subscription on unsubscribe/cancel.
      return TenantContext.run(principal, () => {
        const subscription = next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        })
        return () => subscription.unsubscribe()
      })
    })
  }
}
