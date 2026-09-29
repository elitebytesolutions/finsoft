import { Module } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core'
import { AccountingModule } from './accounting/accounting.module'
import { AuditModule } from './audit/audit.module'
import { PermissionGuard } from './common/permission.guard'
import { RouteDecorationCheck } from './common/route-decoration.check'
import { TenantContextInterceptor } from './common/tenant-context.interceptor'
import { TenantGuard } from './common/tenant.guard'
import { HealthModule } from './health/health.module'
import { AuthModule } from './auth/auth.module'

/*
 * The API composition root.
 *
 * TenantGuard is registered globally rather than per-controller. A guard that
 * has to be remembered on each new controller is a guard that will eventually
 * be forgotten on one, and the forgotten one is an endpoint serving data with
 * no tenant established. Global registration inverts the default: a route is
 * protected unless it explicitly opts out with @Public().
 *
 * M1-X, SEC-C1/C2: PermissionGuard is registered as a SECOND global
 * APP_GUARD, listed AFTER TenantGuard — Nest runs global guards in
 * registration order, so TenantGuard's `req.auth` is always set (or the
 * request has already been rejected) by the time PermissionGuard runs.
 * `tests/integration/guard-order.spec.ts` asserts this ordering holds.
 *
 * M1-X, C5: TenantContextInterceptor is registered as a global
 * APP_INTERCEPTOR. Guards always run before interceptors in Nest's own
 * request lifecycle, which is why PermissionGuard does not depend on it (see
 * that guard's own header comment) — the interceptor's job is establishing
 * `TenantContext` for the HANDLER and everything it calls, for the rest of
 * the request.
 *
 * DiscoveryModule + RouteDecorationCheck: the startup check that every route
 * declares @Public(), @RequirePermission(...) or @AuthenticatedOnly() — see
 * that provider's own header. It runs once, in OnModuleInit, so a violation
 * aborts `app.init()` rather than serving a single request.
 */
@Module({
  imports: [DiscoveryModule, HealthModule, AuthModule, AuditModule, AccountingModule],
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    RouteDecorationCheck,
  ],
})
export class AppModule {}
