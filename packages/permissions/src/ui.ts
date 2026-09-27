import { PERMISSION_CODES, isPrivileged, type PermissionCode } from './catalog.ts'

/*
 * The UI capability map. ARCHITECTURE §8: the catalogue is "code-generated
 * into both the API guards and the UI's capability checks". This is that
 * generation for the UI half — a plain, serialisable data export apps/web
 * can use to decide what to show, never what to allow: the frontend hiding a
 * button is a UX affordance, not a control (rule 18), and every one of these
 * codes is re-checked server-side by PermissionGuard regardless of what the
 * UI rendered.
 *
 * apps/web cannot import this yet. depcruise's `web-is-ui-only` rule does
 * not currently list packages/permissions among apps/web's allowed imports —
 * that is an existing, unrelated rule this brief does not own, flagged under
 * OBSERVED rather than changed here.
 */
export interface PermissionUiEntry {
  readonly code: PermissionCode
  readonly privileged: boolean
}

export const permissionsForUi: readonly PermissionUiEntry[] = PERMISSION_CODES.map((code) => ({
  code,
  privileged: isPrivileged(code),
}))
