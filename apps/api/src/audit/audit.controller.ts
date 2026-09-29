import {
  Controller,
  Get,
  HttpException,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger'
import type { Request, Response } from 'express'
import type { ZodSchema } from 'zod'
import { checkLayers, ThrottleUnavailableError, type ThrottleLayer } from '@finsoft/auth'
import { listAuditEvents, withTenant } from '@finsoft/database'
import { logCommittedBusinessEvent } from '@finsoft/observability'
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
 * M1-X: a per-(tenant, user) rate limit on audit reads, reusing
 * packages/auth's throttle primitive rather than inventing a second one.
 * The audit chain is the one place in the system a compromised or careless
 * caller could exfiltrate an entire tenant's history a page at a time; a
 * generous but real bound (120/minute — several times what any legitimate
 * UI polling this page would need) costs nothing for ordinary use and
 * bounds the worst case. Keyed on (tenantId, userId), never on IP alone:
 * this is an AUTHENTICATED endpoint, so the caller's identity is the
 * meaningful key, exactly as login/refresh key on the account rather than
 * only on the network address.
 */
const AUDIT_VIEW_LIMIT = 120
const AUDIT_VIEW_WINDOW_SECONDS = 60

function auditViewLayers(tenantId: string, userId: string): readonly ThrottleLayer[] {
  return [
    { key: `audit:view:${tenantId}:${userId}`, limit: AUDIT_VIEW_LIMIT, windowSeconds: AUDIT_VIEW_WINDOW_SECONDS },
  ]
}

/*
 * GET /api/audit. ADR-0020 §6 / rule 9: read access to the tamper-evident
 * chain, filtered and paginated, scoped to the caller's own tenant.
 *
 * `@RequirePermission('audit.view')` is effective as of M1-X: PermissionGuard
 * is now a global APP_GUARD registered after TenantGuard (app.module.ts,
 * SEC-C1/C2) — a missing or insufficient permission 401s/403s here exactly
 * as it does on every other decorated route, with no special case for this
 * one.
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
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks audit.view.' })
  @ApiTooManyRequestsResponse({ description: 'Per-(tenant, user) audit-read rate limit exceeded.' })
  @ApiServiceUnavailableResponse({ description: 'The rate limiter is unreachable.' })
  async list(
    @Query(auditQueryPipe()) query: AuditQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // PermissionGuard has already run and required req.auth to be present
    // (it 401s otherwise) — always defined here.
    const auth = req.auth as NonNullable<typeof req.auth>

    let throttle
    try {
      throttle = await checkLayers(auditViewLayers(auth.tenantId, auth.userId))
    } catch (error) {
      if (error instanceof ThrottleUnavailableError) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          error: 'rate_limiter_unavailable',
          message: 'Try again shortly.',
        })
      }
      throw error
    }

    if (throttle.throttled) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(throttle.retryAfterSeconds))))
      throw new HttpException(
        { statusCode: 429, error: 'rate_limited', message: 'Too many audit reads. Try again later.' },
        429,
      )
    }

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

    // A business event, not the audit trail itself (rule 9's audit_log is
    // the authority) — an operational record that someone read the audit
    // log, for the same reason a filing cabinet's sign-out sheet is useful
    // even though it isn't the file.
    logCommittedBusinessEvent({
      event: 'AUDIT_LOG_VIEWED',
      entityType: 'audit_log',
      detail: { itemCount: page.items.length },
    })

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
