import { SetMetadata } from '@nestjs/common'
import type { PermissionCode } from '@finsoft/permissions'

/**
 * `@RequirePermission('voucher.post')` — declares the atomic permission(s) a
 * route needs. Rule 18: every endpoint declares and checks its permission
 * server-side.
 *
 * Explicit opt-in, not a global deny. A route with no `@RequirePermission` is
 * not touched by `PermissionGuard` at all — it is left to whatever
 * authentication/tenancy guard runs ahead of it (`TenantGuard`,
 * `packages/auth`). That is a deliberate choice, recorded in
 * docs/briefs/M1-R-rbac.md: `TenantGuard` already inverts the default for
 * *tenancy* ("protected unless @Public()"), and stacking a second,
 * differently-shaped default for *permissions* on top of it — "denied unless
 * @RequirePermission()" — would make a route's authorization depend on two
 * independent implicit defaults agreeing, rather than on one declared
 * decorator meaning one checked thing. A route that moves money or reads
 * something sensitive states which permission it needs; a route that needs
 * none states nothing, and is reviewed on that basis.
 *
 * More than one code means the caller needs ALL of them.
 */
export const REQUIRE_PERMISSION = 'finsoft:require-permission'

export const RequirePermission = (...codes: PermissionCode[]) =>
  SetMetadata(REQUIRE_PERMISSION, codes)
