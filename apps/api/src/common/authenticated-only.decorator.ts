import { SetMetadata } from '@nestjs/common'

/**
 * Marks a route as intentionally requiring only authentication — no
 * `@RequirePermission`, and not `@Public()` either. M1-X / SEC-C1/C2.
 *
 * Without a third marker, the startup route-decoration check (see
 * `route-decoration.check.ts`) cannot tell "nobody decided what this route
 * needs" from "this route needs authentication and nothing more" — both look
 * identical (no metadata at all). `GET /api/auth/me` and
 * `POST /api/auth/logout` are the two routes that are genuinely in the
 * second category: every authenticated caller may read their own profile or
 * end their own session, and neither checks an atomic permission. Every
 * OTHER route must declare `@Public()` or `@RequirePermission(...)`; one
 * lacking any of the three fails the startup check rather than silently
 * running unauthorized.
 */
export const AUTHENTICATED_ONLY = 'finsoft:authenticated-only'

export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY, true)
