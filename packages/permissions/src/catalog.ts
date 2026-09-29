/*
 * The atomic permission catalogue. ARCHITECTURE §8.
 *
 * "A permission that is not in the catalogue does not exist." This is the
 * single source of truth: the database's role_permissions.permission_code is
 * shape-checked only (see migration 008's header for why it is not a mirror
 * of this list), and every other consumer — the guard, the UI capability map
 * — is generated from this file.
 *
 * MVP SUBSET, NOT THE FULL FUTURE CATALOGUE. ARCHITECTURE §8's worked example
 * lists a larger set (voucher.approve, bank.*, cheque.*, period.*,
 * customer.credit_override, sale.discount_override, price.override,
 * inventory.adjust, inventory.negative_allow, report.export,
 * admin.role_manage — among others). M1-R's brief scopes this catalogue to
 * exactly the permissions the MVP slice in OPERATING_MODEL.md §9 needs:
 *
 *   login -> tenant membership -> permission check -> customer ->
 *   service invoice -> payment -> journal entry -> customer ledger ->
 *   trial balance -> reversal -> audit trail
 *
 * Widening this list to the full catalogue is a later task, not a silent
 * addition here.
 */

export const PERMISSION_CODES = [
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
  'admin.user_manage',
  // Added by the M2-B Council ruling, 2026-09-29 (docs/design/M2/api-contract.md
  // §6/§9): the chart-of-accounts view and the fiscal-period lifecycle. There
  // is deliberately NO 'period.lock' — M2 builds view/close/reopen only, per
  // the ruling; a lock route and its permission are out of scope here.
  'account.view',
  'period.view',
  'period.close',
  'period.reopen',
  // Added by the M2-C Council ruling, 2026-09-29 (coa-standard.md §8.5,
  // Security seat APPROVED WITH CONDITIONS): create and edit a chart-of-
  // accounts account. One code for both acts — the MVP treats them as the
  // same act of shaping the chart, and deactivate (Wave 2 remainder) earns
  // its own code when it is built.
  'account.manage',
] as const

export type PermissionCode = (typeof PERMISSION_CODES)[number]

const PERMISSION_CODE_SET: ReadonlySet<string> = new Set(PERMISSION_CODES)

/** True for any string that is currently a real, catalogued permission. */
export function isPermissionCode(value: string): value is PermissionCode {
  return PERMISSION_CODE_SET.has(value)
}

/**
 * Privileged permissions. ADR-0009:130 (as-accepted numbering — see the
 * notice at the head of ADR-0009): a role holding one of these requires MFA
 * before the grant becomes effective.
 *
 * MFA ENFORCEMENT ITSELF IS NOT IMPLEMENTED HERE. There is no MFA state to
 * check yet — `packages/auth` and `sessions.mfa_at` are m1-auth's territory,
 * and GAP-003 tracks the gap. This flag exists so the guard, and whatever
 * later enforces ADR-0009's MFA gate, both read the same answer to "is this
 * permission privileged" rather than each keeping their own list.
 *
 * `period.close` / `period.reopen` added by the M2-B Council ruling,
 * 2026-09-29 — ADR-0012:136 names step-up MFA for both period transitions.
 * Enforcement is the same GAP-003 gap as every other privileged permission
 * today; this only records that the answer to "is this privileged" is yes.
 */
export const PRIVILEGED_PERMISSIONS: ReadonlySet<PermissionCode> = new Set<PermissionCode>([
  'voucher.reverse',
  'audit.view',
  'admin.user_manage',
  'period.close',
  'period.reopen',
])

export function isPrivileged(code: PermissionCode): boolean {
  return PRIVILEGED_PERMISSIONS.has(code)
}
