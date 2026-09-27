import { Controller, Get, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { ZodSchema } from 'zod'
import { listAuditEvents, withTenant } from '@finsoft/database'
import { ZodValidationPipe } from '../common/zod-validation.pipe.ts'
import { auditQuerySchema, type AuditQuery } from './audit-query.dto.ts'

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
 * Permission checkpoint, not yet wired: this route sits behind the global
 * TenantGuard only (apps/api/src/common/tenant.guard.ts), which today fails
 * closed for every non-@Public() route because Wave 1 authentication has not
 * landed on this branch. ARCHITECTURE §12 catalogues `audit.view` as the
 * permission this endpoint needs; packages/permissions (the RBAC lane,
 * M1-X) is what defines `@RequirePermission`. Nothing here should be read as
 * "this endpoint has no access control" — it has none of its OWN, by
 * design, because this module does not build a second permission system.
 * The integration note for whoever wires RBAC: add
 * `@RequirePermission('audit.view')` to `list()` below; nothing else in this
 * file needs to change for that to take effect.
 */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  @Get()
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
