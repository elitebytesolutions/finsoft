/*
 * `GET /api/audit` — apps/api/src/audit/audit.controller.ts. Permission: `audit.view`
 * (privileged, catalog.ts). Cursor-paginated, newest first.
 */
import { apiFetch } from './client'
import type { AuditPage, AuditQuery } from './audit-types'

function toQueryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export function listAuditEvents(query: AuditQuery = {}): Promise<AuditPage> {
  const qs = toQueryString({
    from: query.from,
    to: query.to,
    action: query.action,
    entityType: query.entityType,
    entityId: query.entityId,
    actor: query.actor,
    cursor: query.cursor,
    limit: query.limit,
  })
  return apiFetch<AuditPage>(`/api/audit${qs}`)
}
