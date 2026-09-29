import { Injectable, OnModuleInit } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import { AUTHENTICATED_ONLY } from './authenticated-only.decorator'
import { REQUIRE_PERMISSION } from './permission.decorator'
import { PUBLIC_ROUTE } from './tenant.guard'

/**
 * The startup authorization check. M1-X, Council SEC-C1/C2, and Council
 * re-review R4/R5 (exactly one marker; an empty `@RequirePermission()` is
 * a boot-time failure, not a request-time one).
 *
 * A route that carries none of `@Public()`, `@RequirePermission(...)` or
 * `@AuthenticatedOnly()` is not "unauthenticated by omission" and not
 * "authenticated by omission" either — it is a route nobody made a decision
 * about, and rule 18 does not tolerate that ambiguity existing in a running
 * process. Equally, a route carrying MORE than one of the three markers is
 * not a stronger decision, it is two contradictory ones stacked on the same
 * handler (is it public, or does it require a permission?) — the check
 * treats that the same as carrying none: a decision that was never actually
 * made cleanly. This check runs once, at boot (`OnModuleInit`, so it fires
 * during `app.init()`), walks every controller method NestJS registered as
 * an HTTP route, and aborts the process if any of them carries zero or more
 * than one of the three markers, or an `@RequirePermission()` with an empty
 * code list (previously only `PermissionGuard` caught that, at request time,
 * per SEC-C3 — this check catches it before the process ever accepts a
 * request). A route added later without a clean decision does not silently
 * run unauthorized or ambiguously authorized — the application refuses to
 * start at all.
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

export class AmbiguouslyDecoratedRouteError extends Error {
  constructor(routes: readonly string[]) {
    super(
      'The following routes carry MORE THAN ONE of @Public(), @RequirePermission(...) and ' +
        '@AuthenticatedOnly() — a route must declare exactly one, never two contradictory ' +
        `authorization decisions stacked on the same handler (rule 18): ${routes.join(', ')}`,
    )
    this.name = 'AmbiguouslyDecoratedRouteError'
  }
}

export class EmptyRequirePermissionError extends Error {
  constructor(routes: readonly string[]) {
    super(
      'The following routes carry @RequirePermission() with no codes named — an empty list is a ' +
        'configuration mistake, never "no requirement" (SEC-C3), and is now caught at boot rather ' +
        `than at request time: ${routes.join(', ')}`,
    )
    this.name = 'EmptyRequirePermissionError'
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
    const { undecorated, ambiguous, emptyPermission } = this.scanRoutes()
    // Order matters only for which error surfaces first when a route
    // manages to trip more than one category (it cannot: zero markers and
    // more-than-one markers are mutually exclusive, and the empty-codes
    // check only applies to a route that DOES carry @RequirePermission).
    if (undecorated.length > 0) {
      throw new UndecoratedRouteError(undecorated)
    }
    if (ambiguous.length > 0) {
      throw new AmbiguouslyDecoratedRouteError(ambiguous)
    }
    if (emptyPermission.length > 0) {
      throw new EmptyRequirePermissionError(emptyPermission)
    }
  }

  private scanRoutes(): {
    undecorated: string[]
    ambiguous: string[]
    emptyPermission: string[]
  } {
    const undecorated: string[] = []
    const ambiguous: string[] = []
    const emptyPermission: string[] = []

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

        const permissionCodes =
          this.reflector.get<unknown[] | undefined>(REQUIRE_PERMISSION, handler) ??
          this.reflector.get<unknown[] | undefined>(REQUIRE_PERMISSION, metatype)
        const requiresPermission = permissionCodes !== undefined

        const authenticatedOnly =
          this.reflector.get<boolean | undefined>(AUTHENTICATED_ONLY, handler) === true ||
          this.reflector.get<boolean | undefined>(AUTHENTICATED_ONLY, metatype) === true

        const markerCount =
          Number(isPublic) + Number(requiresPermission) + Number(authenticatedOnly)
        const label = `${metatype.name}.${methodName}`

        if (markerCount === 0) {
          undecorated.push(label)
          continue
        }
        if (markerCount > 1) {
          ambiguous.push(label)
          continue
        }
        if (requiresPermission && permissionCodes?.length === 0) {
          emptyPermission.push(label)
        }
      }
    }

    return { undecorated, ambiguous, emptyPermission }
  }
}
