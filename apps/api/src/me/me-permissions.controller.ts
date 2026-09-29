import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { withTenant } from '@finsoft/database'
import { resolvePermissions } from '@finsoft/permissions'
import { AuthenticatedOnly } from '../common/authenticated-only.decorator'

/*
 * S1 — GET /api/me/permissions. docs/design/M3/api-contract.md §2 row S1.
 *
 * `@AuthenticatedOnly`, not `@RequirePermission`: asking for a permission in
 * order to read your own permissions is circular. A UI affordance only —
 * every route this feeds re-checks server-side regardless (rule 18).
 *
 * DELIBERATELY NOT under apps/api/src/customers/: this task's own C6
 * addition to eslint.config.mjs bans `withTenant`/`withGlobal` throughout
 * apps/api/src/customers/** (ADR-0028's own text: "withTenant/withGlobal
 * are banned in apps/api/src/customers/**"), and S1 has to open one to call
 * `resolvePermissions` — it cannot be satisfied from inside `modules/customers`
 * either, since a module may never import `@finsoft/permissions` (ADR-0028
 * statement 5). docs/design/M3/README.md §3 and BOARD.md list S1 as an
 * M3-C deliverable but this lane's stated ALLOWED path list names only
 * `apps/api/src/customers/**`, not a `me/` directory — this file is placed
 * at `apps/api/src/me/` (registered from `app.module.ts`, which IS in
 * ALLOWED) as the only location the requirement and the boundary rule can
 * both hold. Flagged as a DECISION in this lane's delivery report for the
 * Architecture seat to confirm or redirect.
 */
@ApiTags('me')
@Controller('me')
export class MePermissionsController {
  @AuthenticatedOnly()
  @Get('permissions')
  @ApiOperation({ summary: "The caller's own effective permission codes." })
  async myPermissions(@Req() req: Request) {
    const auth = req.auth
    if (!auth) throw new UnauthorizedException()

    const granted = await withTenant((tx) => resolvePermissions(tx, auth.userId))
    return {
      permissionVersion: auth.permissionVersion,
      permissions: [...granted].sort(),
    }
  }
}
