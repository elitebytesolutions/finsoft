/*
 * S1 — `GET /api/me/permissions`. docs/design/M3/api-contract.md §2 row S1.
 * `@AuthenticatedOnly`, not permission-gated (asking for a permission in order to read your
 * own permissions is circular). A UI affordance only: every route it feeds re-checks
 * server-side regardless (CLAUDE.md rule 18) — hiding a button here is a courtesy, never
 * the gate.
 */
import { apiFetch } from './client'

export interface MePermissionsResponse {
  permissionVersion: number
  permissions: string[]
}

export function getMyPermissions(): Promise<MePermissionsResponse> {
  return apiFetch<MePermissionsResponse>('/api/me/permissions')
}
