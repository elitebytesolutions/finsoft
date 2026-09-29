import type { RoleSeed } from '@finsoft/database'
import { PERMISSION_CODES, type PermissionCode } from './catalog.ts'

/*
 * System role templates. ARCHITECTURE §8, brief M1-R.
 *
 * Three roles, seeded once per tenant by seedSystemRoles() at provisioning:
 *
 *   Owner        every MVP permission
 *   Accountant   books, not the ability to manage who has access to them,
 *                and not the power to reopen a closed period
 *   Viewer       read-only: can see customers, vouchers, accounts, periods
 *                and the financial report, cannot post or manage anything
 *
 * A tenant may create additional custom roles later (an application feature,
 * not a schema concern); these three are is_system = true and are what a
 * freshly provisioned tenant has before anyone touches Settings.
 *
 * database/migrations/014_add_account_and_period_permissions.sql backfills
 * the four M2-B-ruling codes below into every EXISTING tenant's system
 * roles, so a tenant provisioned before or after that migration ends up
 * with identical grants — see that migration's header and
 * tests/integration/permission-backfill.spec.ts.
 */

const ALL_PERMISSIONS: readonly PermissionCode[] = PERMISSION_CODES

/*
 * EXPLICIT, not "every permission except admin.user_manage" (M2-B Council
 * ruling, 2026-09-29): an exclusion list silently grants a new catalogue
 * code to Accountant the moment it is added to PERMISSION_CODES, with no
 * review of whether Accountant should actually hold it. `period.reopen` is
 * the concrete reason — Accountant gets `period.close` but not
 * `period.reopen` (periods.md §8, ADR-0012: reopening is the narrower,
 * more privileged path). An exhaustiveness test in system-roles.spec.ts
 * keeps this list from silently drifting out of sync with the catalogue
 * instead.
 */
const ACCOUNTANT_PERMISSIONS: readonly PermissionCode[] = [
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
]

const VIEWER_PERMISSIONS: readonly PermissionCode[] = [
  'customer.view',
  'voucher.view',
  'report.financial',
  'account.view',
  'period.view',
]

export const SYSTEM_ROLE_SEEDS: readonly RoleSeed[] = [
  { code: 'owner', name: 'Owner', isSystem: true, permissions: ALL_PERMISSIONS },
  { code: 'accountant', name: 'Accountant', isSystem: true, permissions: ACCOUNTANT_PERMISSIONS },
  { code: 'viewer', name: 'Viewer', isSystem: true, permissions: VIEWER_PERMISSIONS },
]
