import { sql } from 'kysely'
import { recordAudit } from '../audit/writer.ts'
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
 *
 * M1-X (audit wiring). Writes `USER_SIGNED_OUT` inside this SAME
 * transaction, not after it. This is the one auth audit write that does not
 * go through `packages/auth`'s `AuthAuditSink`: `TenantContext` is already
 * established by the time this function runs (`packages/auth/src/logout.ts`
 * calls it from inside its own `TenantContext.run`), and unlike login.ts/
 * refresh.ts, this file carries no restriction against calling `recordAudit`
 * directly — there is exactly one caller today (an authenticated user
 * ending their own session), so the action name is not a business decision
 * this function is guessing at. If `revokeSession` ever grows a second
 * caller (an admin ending someone else's session, say), the action should
 * become a parameter at that point rather than staying hardcoded.
 */
export async function revokeSession(
  sessionId: string,
  actorUserId: string,
  reason: string,
  ip: string | null = null,
): Promise<void> {
  await withTenant(async (tx) => {
    const updated = await tx
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
      .executeTakeFirst()

    // Idempotent by design (a second logout on an already-revoked session is
    // a no-op, not an error) — but a no-op is not a fresh sign-out, so it is
    // not audited a second time.
    if (updated.numUpdatedRows > 0n) {
      await recordAudit(tx, {
        actorUserId,
        action: 'USER_SIGNED_OUT',
        entityType: 'session',
        entityId: sessionId,
        beforeJson: null,
        afterJson: null,
        ip,
        requestId: null,
      })
    }
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

export interface AccountState {
  readonly userStatus: string
  readonly tenantStatus: string
  /** `users.version` — see login.ts's `LoginSuccess.permissionVersion` doc comment. */
  readonly permissionVersion: number
}

/**
 * M1-X, L1. The CURRENT account state for a user already carrying a
 * verified access-token claim — read fresh, under the tenant's own RLS, so
 * that a status flip or a permission change is visible on the very next
 * request rather than only after the access token expires. Cached with a
 * short TTL by `packages/auth`'s guard; PostgreSQL stays the source of
 * truth. Returns `null` only if the user row itself is gone, which does not
 * happen in this system (rule 4: no hard delete) but is handled rather than
 * assumed impossible.
 */
export async function getAccountState(userId: string): Promise<AccountState | null> {
  return withTenant(async (tx) => {
    const row = await tx
      .selectFrom('users as u')
      .innerJoin('tenants as t', 't.id', 'u.tenant_id')
      .select(['u.status as user_status', 'u.version as user_version', 't.status as tenant_status'])
      .where('u.id', '=', userId)
      .executeTakeFirst()

    if (!row) return null
    return {
      userStatus: row.user_status,
      tenantStatus: row.tenant_status,
      permissionVersion: row.user_version,
    }
  })
}

export interface AuthenticatedProfile {
  /**
   * `version`: M1-X, Council DB C3. The client's optimistic-concurrency
   * token for PATCH /api/auth/me — read it here, send it back unchanged.
   */
  readonly user: {
    readonly id: string
    readonly email: string
    readonly fullName: string
    readonly version: number
  }
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
      .select([
        'u.id',
        'u.email',
        'u.full_name',
        'u.version',
        't.id as tenant_id',
        't.code',
        't.name',
      ])
      .where('u.id', '=', userId)
      .executeTakeFirst()

    if (!row) return null
    return {
      user: { id: row.id, email: row.email, fullName: row.full_name, version: row.version },
      tenant: { id: row.tenant_id, code: row.code, name: row.name },
    }
  })
}

export interface UpdatedProfile {
  readonly id: string
  readonly email: string
  readonly fullName: string
  readonly version: number
}

export type UpdateOwnFullNameOutcome =
  | { readonly outcome: 'success'; readonly profile: UpdatedProfile }
  | { readonly outcome: 'not_found' }
  /** The caller's `version` did not match the row's current version. Nothing was written; no audit row. */
  | { readonly outcome: 'version_conflict'; readonly currentVersion: number }

/**
 * PATCH /api/auth/me. M1-X, W1-006 exit criterion 1: the minimal authorised
 * write "tenant A can read AND update its own record" needs — updates only
 * `full_name`, nothing financial and nothing that touches a kernel.
 *
 * M1-X, Council DB C3: reads with `SELECT ... FOR UPDATE` (so the version
 * check and the write are atomic against a concurrent update of the SAME
 * row, not just against a REQUEST validated separately from the write —
 * the row lock is held for the rest of this transaction), requires the
 * caller's `expectedVersion` to match, and reports a mismatch as
 * `version_conflict` WITHOUT writing anything — not the row, and not an
 * audit record: an attempted update that did not happen is not an event to
 * audit. `before_json` is the value read under the SAME lock the write
 * commits against, so it is never stale by the time it is hashed into the
 * chain.
 *
 * Audited directly, the same shape `revokeSession` above already
 * establishes: this file carries no restriction against calling
 * `recordAudit` (unlike login.ts/refresh.ts), `TenantContext` is already
 * established by the caller (the request-wide interceptor, for this route),
 * and there is exactly one caller — a user changing their own display name —
 * so the action is not a business decision this function is guessing at.
 */
export async function updateOwnFullName(
  userId: string,
  fullName: string,
  expectedVersion: number,
): Promise<UpdateOwnFullNameOutcome> {
  return withTenant(async (tx) => {
    const before = await tx
      .selectFrom('users')
      .select(['id', 'email', 'full_name', 'created_by', 'version'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst()
    if (!before) return { outcome: 'not_found' }

    if (before.version !== expectedVersion) {
      return { outcome: 'version_conflict', currentVersion: before.version }
    }

    const updated = await tx
      .updateTable('users')
      .set({
        full_name: fullName,
        // See LoginCandidateUser.createdBy's comment (login.ts): the
        // provisioned owner's updated_by must stay NULL, or
        // users_authorship_pair_or_neither fails. Every other user updates
        // their own row as themselves.
        updated_by: before.created_by === null ? null : userId,
        version: sql`version + 1`,
      })
      .where('id', '=', userId)
      // Redundant under the FOR UPDATE lock already held in this same
      // transaction (no concurrent writer can have changed it), but this
      // codebase's own doctrine (login.ts, refresh.ts) is that the WRITE
      // statement is the point of truth, never a read taken moments earlier
      // — so the predicate is restated here rather than trusted from above.
      .where('version', '=', expectedVersion)
      .returning(['id', 'email', 'full_name', 'version'])
      .executeTakeFirst()

    if (!updated) {
      return { outcome: 'version_conflict', currentVersion: before.version }
    }

    await recordAudit(tx, {
      actorUserId: userId,
      action: 'USER_PROFILE_UPDATED',
      entityType: 'user',
      entityId: userId,
      beforeJson: { fullName: before.full_name },
      afterJson: { fullName: updated.full_name },
      ip: null,
      requestId: null,
    })

    return {
      outcome: 'success',
      profile: {
        id: updated.id,
        email: updated.email,
        fullName: updated.full_name,
        version: updated.version,
      },
    }
  })
}
