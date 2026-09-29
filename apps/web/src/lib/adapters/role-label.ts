/*
 * A human role label from the caller's real permission set (`GET /api/me/permissions`),
 * for display only — never a gate. `apps/web` may not import `@finsoft/permissions`
 * (web-is-ui-only, per the M3 API contract's own note on why S1 exists at all), so the
 * three system roles' permission sets are mirrored here from
 * packages/permissions/src/system-roles.ts rather than imported. Keep these two files in
 * sync by hand; a mismatch only ever produces a wrong LABEL, never a wrong permission,
 * since every real gate reads the actual `permissions` array, not this label.
 */

const OWNER_ONLY = ['admin.user_manage', 'period.reopen']
const ACCOUNTANT_PERMISSIONS = new Set([
  'customer.view',
  'customer.create',
  'invoice.create',
  'invoice.post',
  'payment.receive',
  'voucher.view',
  'voucher.post',
  'voucher.reverse',
  'report.financial',
  'audit.view',
  'account.view',
  'period.view',
  'period.close',
])
const VIEWER_PERMISSIONS = new Set([
  'customer.view',
  'voucher.view',
  'report.financial',
  'account.view',
  'period.view',
])

function sameSet(a: readonly string[], b: Set<string>): boolean {
  return a.length === b.size && a.every((code) => b.has(code))
}

/** `null` while permissions haven't loaded yet. A set that matches none of the three
 * system roles exactly (a tenant's custom role) reports "Custom role" rather than
 * guessing — never label someone Owner who only holds most of that set. */
export function roleLabel(permissions: string[] | null): string {
  if (permissions === null) return '…'
  if (permissions.length === 0) return 'No permissions'
  if (OWNER_ONLY.every((code) => permissions.includes(code))) return 'Owner'
  if (sameSet(permissions, ACCOUNTANT_PERMISSIONS)) return 'Accountant'
  if (sameSet(permissions, VIEWER_PERMISSIONS)) return 'Viewer'
  return 'Custom role'
}
