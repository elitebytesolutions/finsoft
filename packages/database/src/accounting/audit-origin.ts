/*
 * Optional provenance for the audit record a provisioning-time write emits
 * (seedChartOfAccounts, createFiscalYear). Omitted, the record is exactly
 * what it was before: requestId null, no `via` key.
 *
 *   requestId  forwarded to audit_log.request_id, which is a `uuid` column
 *              (migration 009) — so it must be a uuid, never a label.
 *   via        a short label naming the originating tool (e.g.
 *              'backfill-accounting'), written into the record's afterJson,
 *              which is hashed into the chain (ADR-0020 §4). This is where a
 *              CLI identifies itself.
 */
export interface AuditOrigin {
  readonly requestId?: string
  readonly via?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VIA = /^[a-z][a-z0-9-]{0,63}$/

export function auditRequestId(origin: AuditOrigin | undefined): string | null {
  const id = origin?.requestId
  if (id === undefined) return null
  if (!UUID.test(id)) {
    throw new Error(`audit origin: requestId must be a uuid (audit_log.request_id), got "${id}".`)
  }
  return id
}

export function auditVia(origin: AuditOrigin | undefined): { via: string } | Record<string, never> {
  const via = origin?.via
  if (via === undefined) return {}
  if (!VIA.test(via)) {
    throw new Error(`audit origin: via must match ${String(VIA)}, got "${via}".`)
  }
  return { via }
}
