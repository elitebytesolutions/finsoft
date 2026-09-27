import { sql } from 'kysely'
import { withTenant } from '../transaction.ts'

/*
 * Session reads and writes for the AUTHENTICATED path — TenantContext is
 * already established from a verified JWT claim by the time any of these
 * run, so they use the ordinary `withTenant`, not `withResolvedTenant`.
 */

/**
 * ADR-0009: "the guard checks the session is ACTIVE". Called from the
 * short-TTL Redis cache's miss path in packages/auth; PostgreSQL stays the
 * source of truth.
 */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  return withTenant(async (tx) => {
    const row = await tx
      .selectFrom('sessions')
      .select('revoked_at')
      .where('id', '=', sessionId)
      .executeTakeFirst()
    return row !== undefined && row.revoked_at === null
  })
}

/**
 * Logout. Cascades to every family opened under this session via migration
 * 005's `sessions_cascade_revocation` trigger — this call does not touch
 * `refresh_token_families` itself.
 */
export async function revokeSession(
  sessionId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  await withTenant(async (tx) => {
    await tx
      .updateTable('sessions')
      .set({
        revoked_at: new Date(),
        revoked_reason: reason,
        status: 'REVOKED',
        updated_by: actorUserId,
        version: sql`version + 1`,
      })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute()
  })
}

/**
 * Throttled per migration 005's own header: `last_seen_at` is the hottest
 * write in the system, so this is skipped by the caller when the existing
 * value is recent rather than written on every request. This function does
 * the unconditional write; the throttling decision belongs to the caller,
 * which already holds the previous value from its Redis session cache.
 */
export async function touchSessionLastSeen(sessionId: string): Promise<void> {
  await withTenant(async (tx) => {
    await tx
      .updateTable('sessions')
      // sessions_enforce_transition (migration 005) requires version to
      // increase on every update, unconditionally — including this one.
      .set({ last_seen_at: new Date(), version: sql`version + 1` })
      .where('id', '=', sessionId)
      .execute()
  })
}

export interface AuthenticatedProfile {
  readonly user: { readonly id: string; readonly email: string; readonly fullName: string }
  readonly tenant: { readonly id: string; readonly code: string; readonly name: string }
}

/** GET /api/auth/me. */
export async function getAuthenticatedProfile(
  userId: string,
): Promise<AuthenticatedProfile | null> {
  return withTenant(async (tx) => {
    const row = await tx
      .selectFrom('users as u')
      .innerJoin('tenants as t', 't.id', 'u.tenant_id')
      .select(['u.id', 'u.email', 'u.full_name', 't.id as tenant_id', 't.code', 't.name'])
      .where('u.id', '=', userId)
      .executeTakeFirst()

    if (!row) return null
    return {
      user: { id: row.id, email: row.email, fullName: row.full_name },
      tenant: { id: row.tenant_id, code: row.code, name: row.name },
    }
  })
}
