import { UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'

/*
 * The caller's tenant, from the verified req.auth TenantGuard set.
 * TenantContext (@finsoft/database) is lint-fenced (eslint.config.mjs,
 * no-restricted-imports) to the request-scoping interceptor, packages/database
 * and packages/auth — a controller reads req.auth instead, same as
 * apps/api/src/audit/audit.controller.ts.
 *
 * Never a 404/403 here: PermissionGuard has already required req.auth to be
 * present (it 401s otherwise) before any @RequirePermission-decorated
 * handler runs, so this is a defensive backstop, not the real gate.
 */
export function callerTenantId(req: Request): string {
  const auth = req.auth
  if (!auth) throw new UnauthorizedException()
  return auth.tenantId
}
