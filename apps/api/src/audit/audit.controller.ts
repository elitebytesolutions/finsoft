import { Controller, Get, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { ZodSchema } from 'zod'
import { listAuditEvents, withTenant } from '@finsoft/database'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { auditQuerySchema, type AuditQuery } from './audit-query.dto'

/*
 * ZodValidationPipe<T> is declared over `ZodSchema<T>`, which defaults to
 * requiring the schema's INPUT type to equal T as well as its output —
 * true of every other schema this pipe is used with today, and not true
 * here: auditQuerySchema coerces and transforms (query strings -> Date,
 * "50" -> 50), so its input and output types genuinely differ. The pipe
 * itself only calls `.safeParse` and returns `.data`, whose runtime shape is
 * exactly AuditQuery regardless of this generic mismatch — the cast is a
 * TypeScript-only adjustment for a pipe signature that was not written with
 * a transforming schema in mind, not a runtime behaviour change.
 */
function auditQueryPipe(): ZodValidationPipe<AuditQuery> {
  return new ZodValidationPipe(auditQuerySchema as unknown as ZodSchema<AuditQuery>)
}

/*
 * GET /api/audit. ADR-0020 §6 / rule 9: read access to the tamper-evident
 * chain, filtered and paginated, scoped to the caller's own tenant.
 *
 * M1-INT-1 (Database seat condition, migration 009): now that migration 008
 * (RBAC) is present, this route carries `@RequirePermission('audit.view')` —
 * ARCHITECTURE §12 catalogues that code as the one this endpoint needs.
 *
 * The decorator alone does not yet enforce anything: `PermissionGuard` is
 * not registered as a global guard (see the BLOCKED note in M1-INT-1's
 * report — TenantGuard does not establish `TenantContext` for the guard
 * chain, only within each handler's own `TenantContext.run(...)`, so
 * `PermissionGuard`'s SEC-C6 check would 401 every real request today, not
 * just unauthorized ones). Wiring PermissionGuard in globally needs that gap
 * closed first; until then this decorator documents intent and is ready to
 * take effect the moment the guard is registered, per PermissionGuard's own
 * contract of being a no-op for undecorated routes and vice versa.
 */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  @Get()
  @RequirePermission('audit.view')
  @ApiOperation({
    summary: "List the caller's tenant's audit events, newest first.",
    description:
      'Filters: from/to (occurred_at range), action, entityType, entityId, actor. Cursor pagination via seq.',
  })
  @ApiOkResponse({ description: 'A page of audit events.' })
  async list(@Query(auditQueryPipe()) query: AuditQuery) {
    const page = await withTenant((tx) =>
      listAuditEvents(tx, {
        from: query.from,
        to: query.to,
        action: query.action,
        entityType: query.entityType,
        entityId: query.entityId,
        actorUserId: query.actor,
        cursor: query.cursor,
        limit: query.limit,
      }),
    )

    return {
      items: page.items.map((item) => ({
        id: item.id,
        seq: item.seq,
        occurredAt: item.occurredAt.toISOString(),
        actorUserId: item.actorUserId,
        action: item.action,
        entityType: item.entityType,
        entityId: item.entityId,
        beforeJson: item.beforeJson,
        afterJson: item.afterJson,
        ip: item.ip,
        requestId: item.requestId,
        hash: item.hash,
      })),
      nextCursor: page.nextCursor,
    }
  }
}
