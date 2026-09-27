import type { RoleSeed } from '@finsoft/database'
import { PERMISSION_CODES, type PermissionCode } from './catalog.ts'

/*
 * System role templates. ARCHITECTURE §8, brief M1-R.
 *
 * Three roles, seeded once per tenant by seedSystemRoles() at provisioning:
 *
 *   Owner        every MVP permission
 *   Accountant   every MVP permission except admin.user_manage — books, not
 *                the ability to manage who has access to them
 *   Viewer       read-only: can see customers, vouchers and the financial
 *                report, cannot post or manage anything
 *
 * A tenant may create additional custom roles later (an application feature,
 * not a schema concern); these three are is_system = true and are what a
 * freshly provisioned tenant has before anyone touches Settings.
 */

const ALL_PERMISSIONS: readonly PermissionCode[] = PERMISSION_CODES

const ACCOUNTANT_PERMISSIONS: readonly PermissionCode[] = PERMISSION_CODES.filter(
  (code) => code !== 'admin.user_manage',
)

const VIEWER_PERMISSIONS: readonly PermissionCode[] = [
  'customer.view',
  'voucher.view',
  'report.financial',
]

export const SYSTEM_ROLE_SEEDS: readonly RoleSeed[] = [
  { code: 'owner', name: 'Owner', isSystem: true, permissions: ALL_PERMISSIONS },
  { code: 'accountant', name: 'Accountant', isSystem: true, permissions: ACCOUNTANT_PERMISSIONS },
  { code: 'viewer', name: 'Viewer', isSystem: true, permissions: VIEWER_PERMISSIONS },
]
