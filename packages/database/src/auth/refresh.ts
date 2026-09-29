import { sql } from 'kysely'
import { withResolvedTenant, type TenantTx } from '../transaction.ts'
import { refreshTokenResolver } from './resolvers.ts'

/*
 * The refresh persistence boundary. ADR-0022 (no grace window), ADR-0023 §2,
 * §6. Security re-review findings B1, B2, B5, C4 (2026-09-27) folded in.
 *
 * `packages/auth` computes the presented token's SHA-256 hash and mints the
 * successor's raw value and hash (crypto only, no clock) — the EXPIRY is
 * computed by PostgreSQL, not by the application (B5): the migration's
 * `rt_lifetime_ceiling` CHECK compares `expires_at` against `issued_at`,
 * both of which must come from the same clock or a skewed app clock turns
 * into a `23514` that surfaces as an uncaught 500. `now() + interval
 * '14 days'` is computed server-side and returned via RETURNING; the caller
 * sets the cookie's Max-Age from that value, never from a value it minted
 * itself.
 *
 * No grace window exists as a concept here, in these words: a spent token
 * presented at any interval, by anyone, revokes the family AND the session
 * (B2, ADR-0009's session-is-the-revocation-handle claim) — not the family
 * alone. There is no branch on time and no branch on who presented it.
 */

export type RefreshOutcome =
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'inactive' }
  | {
      readonly outcome: 'reused'
      readonly tenantId: string
      readonly familyId: string
      readonly sessionId: string
    }
  | {
      readonly outcome: 'success'
      readonly tenant: { readonly id: string; readonly code: string; readonly name: string }
      readonly user: { readonly id: string; readonly email: string; readonly fullName: string }
      readonly sessionId: string
      readonly permissionVersion: number
      readonly refreshTokenExpiresAt: Date
    }

export interface SpendRefreshTokenParams {
  readonly presentedTokenHash: string
  readonly newTokenHash: string
  readonly deviceId: string | null
}

export interface RefreshTestHooks {
  /**
   * TEST ONLY. Called after the candidate row is read and before the atomic
   * spend UPDATE is attempted — the exact window a concurrent logout (or a
   * concurrent reuse-triggered revocation) races against. Production code
   * never sets this.
   */
  readonly beforeSpend?: () => Promise<void>
}

/**
 * Revokes a family AND its session in the SAME transaction (B2). Migration
 * 005's `sessions_cascade_revocation` trigger only fires the other
 * direction (session -> its families); revoking a family does not, by
 * itself, revoke the session that opened it, so a session left ACTIVE after
 * its refresh chain is killed would still pass the guard's session-active
 * check on whatever access token the thief also holds.
 */
async function revokeFamilyAndSession(
  tx: TenantTx,
  tenantId: string,
  familyId: string,
  sessionId: string,
  actorUserId: string,
): Promise<void> {
  await tx
    .updateTable('refresh_token_families')
    .set({
      revoked_at: sql`now()`,
      revoked_reason: 'REUSE_DETECTED',
      updated_by: actorUserId,
      version: sql`version + 1`,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', familyId)
    .where('revoked_at', 'is', null)
    .execute()

  await tx
    .updateTable('sessions')
    .set({
      revoked_at: sql`now()`,
      revoked_reason: 'REFRESH_REUSE_DETECTED',
      status: 'REVOKED',
      updated_by: actorUserId,
      version: sql`version + 1`,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute()
}

export async function spendRefreshToken(
  params: SpendRefreshTokenParams,
  testHooks?: RefreshTestHooks,
): Promise<RefreshOutcome> {
  const result = await withResolvedTenant(
    refreshTokenResolver(params.presentedTokenHash),
    async (tx, { tokenId }, tenantId) => {
      // The full chain, read once, under RLS, additionally pinned to the
      // resolver's own answer. A resolver bug that named the wrong token
      // becomes zero rows here, not a wrong-tenant write. is_expired is
      // computed by PostgreSQL (`expires_at <= now()`), not by comparing
      // against `new Date()` in the application — a skewed app clock must
      // never disagree with the clock the atomic UPDATE below itself uses.
      const candidate = await tx
        .selectFrom('refresh_tokens as rt')
        .innerJoin('refresh_token_families as f', (join) =>
          join.onRef('f.id', '=', 'rt.family_id').onRef('f.tenant_id', '=', 'rt.tenant_id'),
        )
        .innerJoin('sessions as s', (join) =>
          join.onRef('s.id', '=', 'f.session_id').onRef('s.tenant_id', '=', 'f.tenant_id'),
        )
        .innerJoin('users as u', (join) =>
          join.onRef('u.id', '=', 's.user_id').onRef('u.tenant_id', '=', 's.tenant_id'),
        )
        .innerJoin('tenants as t', 't.id', 'rt.tenant_id')
        .select([
          'rt.id as token_id',
          'rt.used_at',
          'rt.family_id',
          'f.revoked_at as family_revoked_at',
          's.id as session_id',
          's.revoked_at as session_revoked_at',
          'u.id as user_id',
          'u.email',
          'u.full_name',
          'u.status as user_status',
          // M1-X, L1: users.version (not sessions.permission_version, which
          // nothing bumps) is the current permission version — see
          // packages/database/src/auth/login.ts's LoginSuccess.permissionVersion
          // doc comment and packages/auth/src/guard.ts for the guard-side
          // comparison this feeds.
          'u.version as permission_version',
          't.code as tenant_code',
          't.name as tenant_name',
          't.status as tenant_status',
          sql<boolean>`rt.expires_at <= now()`.as('is_expired'),
        ])
        .where('rt.tenant_id', '=', tenantId)
        .where('rt.id', '=', tokenId)
        .executeTakeFirst()

      if (!candidate) {
        // The resolver found a row; this join found none. Only reachable if
        // the chain (family/session/user) is inconsistent, which the FKs
        // and RESTRICT deletes make impossible in practice. Treat as unknown
        // rather than throw: this is still an unauthenticated request.
        return { outcome: 'unknown' } satisfies RefreshOutcome
      }

      if (candidate.used_at !== null || candidate.family_revoked_at !== null) {
        // REUSE — the presented token was already spent, or its family was
        // already revoked by an earlier reuse detection. No grace window at
        // any delay (ADR-0022): revoke the whole family AND the session
        // (B2), whoever presented it, and stop.
        await revokeFamilyAndSession(
          tx,
          tenantId,
          candidate.family_id,
          candidate.session_id,
          candidate.user_id,
        )
        return {
          outcome: 'reused',
          tenantId,
          familyId: candidate.family_id,
          sessionId: candidate.session_id,
        } satisfies RefreshOutcome
      }

      if (candidate.is_expired) {
        return { outcome: 'expired' } satisfies RefreshOutcome
      }

      // C4 / ADR-0009: a refresh must not succeed for a non-ACTIVE user or a
      // non-ACTIVE tenant, and must fail immediately rather than rotate the
      // token first and find out. Checked, deliberately, BEFORE the spend:
      // the token is left unspent, so a since-reactivated account is not
      // punished for a suspension that has already been lifted.
      if (candidate.user_status !== 'ACTIVE' || candidate.tenant_status !== 'ACTIVE') {
        return { outcome: 'inactive' } satisfies RefreshOutcome
      }

      if (testHooks?.beforeSpend) await testHooks.beforeSpend()

      // The atomic spend. `used_at IS NULL AND expires_at > now()` re-checked
      // in the WHERE even though both were just read: this is the fence that
      // actually matters under concurrency — a second caller racing on the
      // same token blocks on the row lock and re-evaluates against the
      // committed row, never both winning (ADR-0022's row-lock serialisation).
      //
      // migration 005's `refresh_tokens_enforce_transition` additionally
      // takes a FOR SHARE lock on the family and RAISES (23514) if it was
      // revoked between our read above and this statement.
      //
      // DB F2 / N3, security/database re-review: a RAISE from a trigger
      // aborts the CURRENT transaction in Postgres, not just the statement —
      // every statement issued afterward on the same transaction fails with
      // 25P02 ("current transaction is aborted") until a ROLLBACK. The
      // earlier version of this catch block called revokeFamilyAndSession
      // immediately after catching the 23514, inside the now-aborted
      // transaction, which raised 25P02 and surfaced as an uncaught 500 —
      // exactly when a logout races a refresh on the same family. A
      // SAVEPOINT taken before the attempt gives this one statement its own
      // rollback boundary: ROLLBACK TO SAVEPOINT undoes only the failed
      // UPDATE and returns the transaction to a usable state, so the revoke
      // that follows runs normally.
      let spend: { numUpdatedRows: bigint }
      await sql`SAVEPOINT spend_attempt`.execute(tx)
      try {
        spend = await tx
          .updateTable('refresh_tokens')
          .set({ used_at: sql`now()`, updated_by: candidate.user_id, version: sql`version + 1` })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', tokenId)
          .where('used_at', 'is', null)
          .where(sql<boolean>`expires_at > now()`)
          .executeTakeFirst()
        await sql`RELEASE SAVEPOINT spend_attempt`.execute(tx)
      } catch (error) {
        if ((error as { code?: string }).code === '23514') {
          await sql`ROLLBACK TO SAVEPOINT spend_attempt`.execute(tx)
          await revokeFamilyAndSession(
            tx,
            tenantId,
            candidate.family_id,
            candidate.session_id,
            candidate.user_id,
          )
          return {
            outcome: 'reused',
            tenantId,
            familyId: candidate.family_id,
            sessionId: candidate.session_id,
          } satisfies RefreshOutcome
        }
        throw error
      }

      if (spend.numUpdatedRows === 0n) {
        // B1: lost the race to a CONCURRENT spend of the SAME token — our
        // pre-read above saw `used_at IS NULL`, but a sibling request's
        // UPDATE committed first and this one's WHERE no longer matches.
        // ADR-0022 makes no distinction by who arrives second: whoever
        // presents a token that turns out to already be spent is in the
        // reuse branch, and the earlier draft of this function reported
        // 'reused' here WITHOUT actually revoking anything — a caller who
        // lost this exact race left the family (and the winner's brand-new
        // session) untouched. Re-read to confirm, under the row lock the
        // failed UPDATE still released cleanly, then revoke for real.
        const after = await tx
          .selectFrom('refresh_tokens')
          .select(['family_id'])
          .where('tenant_id', '=', tenantId)
          .where('id', '=', tokenId)
          .executeTakeFirst()

        if (!after) return { outcome: 'unknown' } satisfies RefreshOutcome

        await revokeFamilyAndSession(
          tx,
          tenantId,
          after.family_id,
          candidate.session_id,
          candidate.user_id,
        )
        return {
          outcome: 'reused',
          tenantId,
          familyId: after.family_id,
          sessionId: candidate.session_id,
        } satisfies RefreshOutcome
      }

      // B5: the successor's expiry is computed by PostgreSQL and returned,
      // never minted by the application — the ONLY place a 14-day ceiling
      // and a 14-day grant can never disagree is the same clock computing
      // both. `rt_lifetime_ceiling` compares against `issued_at`'s own
      // DEFAULT now(), so `now() + interval '14 days'` here is the same
      // statement's own snapshot of "now", not a value that can drift.
      const successor = await tx
        .insertInto('refresh_tokens')
        .values({
          tenant_id: tenantId,
          family_id: candidate.family_id,
          token_hash: params.newTokenHash,
          expires_at: sql`now() + interval '14 days'`,
          created_by: candidate.user_id,
          updated_by: candidate.user_id,
        })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow()

      await tx
        .updateTable('refresh_tokens')
        .set({
          replaced_by: successor.id,
          updated_by: candidate.user_id,
          version: sql`version + 1`,
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', tokenId)
        .execute()

      // sessions_enforce_transition (migration 005) requires version to
      // increase on EVERY update, unconditionally — last_seen_at is no
      // exception. Not throttled here: refresh already happens at most
      // every ~11 minutes per session (75% of the 15-minute access token
      // life, per ADR-0022's proactive-refresh mitigation), so this is
      // nowhere near the per-request write migration 005's header warns
      // about — that throttling obligation belongs to whatever eventually
      // calls touchSessionLastSeen() on ordinary authenticated requests, not
      // to this already-infrequent path.
      await tx
        .updateTable('sessions')
        .set({ last_seen_at: sql`now()`, version: sql`version + 1` })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', candidate.session_id)
        .execute()

      return {
        outcome: 'success',
        tenant: { id: tenantId, code: candidate.tenant_code, name: candidate.tenant_name },
        user: { id: candidate.user_id, email: candidate.email, fullName: candidate.full_name },
        sessionId: candidate.session_id,
        permissionVersion: candidate.permission_version,
        refreshTokenExpiresAt: successor.expires_at,
      } satisfies RefreshOutcome
    },
  )

  // withResolvedTenant returns null only when the resolver itself found
  // nothing — an unknown token hash.
  return result ?? { outcome: 'unknown' }
}
