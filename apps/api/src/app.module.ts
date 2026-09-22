import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { TenantGuard } from './common/tenant.guard'
import { HealthModule } from './health/health.module'

/*
 * The API composition root.
 *
 * TenantGuard is registered globally rather than per-controller. A guard that
 * has to be remembered on each new controller is a guard that will eventually
 * be forgotten on one, and the forgotten one is an endpoint serving data with
 * no tenant established. Global registration inverts the default: a route is
 * protected unless it explicitly opts out with @Public().
 */
@Module({
  imports: [HealthModule],
  providers: [{ provide: APP_GUARD, useClass: TenantGuard }],
})
export class AppModule {}
