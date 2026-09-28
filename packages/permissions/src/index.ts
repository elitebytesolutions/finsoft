export {
  PERMISSION_CODES,
  PRIVILEGED_PERMISSIONS,
  isPermissionCode,
  isPrivileged,
  type PermissionCode,
} from './catalog.ts'

export { SYSTEM_ROLE_SEEDS } from './system-roles.ts'

export { resolvePermissions } from './resolve.ts'
export { seedSystemRoles } from './seed.ts'

export { permissionsForUi, type PermissionUiEntry } from './ui.ts'

export type { RequestAuth } from './types.ts'
