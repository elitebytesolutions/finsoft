import { Injectable, OnModuleInit } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import { AUTHENTICATED_ONLY } from './authenticated-only.decorator'
import { REQUIRE_PERMISSION } from './permission.decorator'
import { PUBLIC_ROUTE } from './tenant.guard'

/**
 * The startup authorization check. M1-X, Council SEC-C1/C2.
 *
 * A route that carries none of `@Public()`, `@RequirePermission(...)` or
 * `@AuthenticatedOnly()` is not "unauthenticated by omission" and not
 * "authenticated by omission" either — it is a route nobody made a decision
 * about, and rule 18 does not tolerate that ambiguity existing in a running
 * process. This check runs once, at boot (`OnModuleInit`, so it fires during
 * `app.init()`), walks every controller method NestJS registered as an HTTP
 * route, and aborts the process if any of them carries none of the three
 * markers. A route added later without a decision does not silently run
 * unauthorized — the application refuses to start at all.
 */
export class UndecoratedRouteError extends Error {
  constructor(routes: readonly string[]) {
    super(
      'The following routes carry none of @Public(), @RequirePermission(...) or ' +
        '@AuthenticatedOnly() — every route must declare exactly one, so that authorization is a ' +
        `decision made and reviewed, never an omission (rule 18): ${routes.join(', ')}`,
    )
    this.name = 'UndecoratedRouteError'
  }
}

@Injectable()
export class RouteDecorationCheck implements OnModuleInit {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const undecorated = this.findUndecoratedRoutes()
    if (undecorated.length > 0) {
      throw new UndecoratedRouteError(undecorated)
    }
  }

  private findUndecoratedRoutes(): string[] {
    const undecorated: string[] = []

    for (const wrapper of this.discoveryService.getControllers()) {
      const { instance, metatype } = wrapper
      if (!instance || !metatype) continue

      const prototype = Object.getPrototypeOf(instance) as object
      const methodNames = this.metadataScanner.getAllMethodNames(prototype)

      for (const methodName of methodNames) {
        const handler = (prototype as Record<string, unknown>)[methodName]
        if (typeof handler !== 'function') continue

        // Only an actual route handler carries Nest's own PATH_METADATA
        // (set by @Get/@Post/@Put/@Patch/@Delete/...). A plain method with
        // no HTTP verb decorator is not a route and is not this check's
        // concern.
        const routePath: unknown = Reflect.getMetadata(PATH_METADATA, handler)
        if (routePath === undefined) continue

        const isPublic =
          this.reflector.get<boolean | undefined>(PUBLIC_ROUTE, handler) === true ||
          this.reflector.get<boolean | undefined>(PUBLIC_ROUTE, metatype) === true

        const requiresPermission =
          this.reflector.get(REQUIRE_PERMISSION, handler) !== undefined ||
          this.reflector.get(REQUIRE_PERMISSION, metatype) !== undefined

        const authenticatedOnly =
          this.reflector.get<boolean | undefined>(AUTHENTICATED_ONLY, handler) === true ||
          this.reflector.get<boolean | undefined>(AUTHENTICATED_ONLY, metatype) === true

        if (!isPublic && !requiresPermission && !authenticatedOnly) {
          undecorated.push(`${metatype.name}.${methodName}`)
        }
      }
    }

    return undecorated
  }
}
