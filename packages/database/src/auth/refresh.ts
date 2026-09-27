import { sql } from 'kysely'
import { withResolvedTenant } from '../transaction.ts'
import { refreshTokenResolver } from './resolvers.ts'

/*
 * The refresh persistence boundary. ADR-0022 (no grace window), ADR-0023 §2.
 *
 * `packages/auth` computes the presented token's SHA-256 hash and mints the
 * successor's raw value and hash — both pure crypto, no database — and calls
 * `spendRefreshToken`. Everything below is the atomic spend: single UPDATE,
 * `WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, plus
 * the two predicates ADR-0023 §2 adds on top of the resolver's answer
 * (`tenant_id = $resolved AND id = $resolved_token_id`), which turns a
 * resolver bug from a wrong-row write into zero rows rather than trusting
 * the resolver's read outright.
 *
 * No grace window exists as a concept here, in these words: a spent token
 * presented at any interval, by anyone, revokes the family. There is no
 * branch on time and no branch on who presented it.
 */

export type RefreshOutcome =
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'reused' }
  | {
      readonly outcome: 'success'
      readonly tenant: { readonly id: string; readonly code: string; readonly name: string }
      readonly user: { readonly id: string; readonly email: string; readonly fullName: string }
      readonly sessionId: string
      readonly permissionVersion: number
    }

export interface SpendRefreshTokenParams {
  readonly presentedTokenHash: string
  readonly newTokenHash: string
  readonly newTokenExpiresAt: Date
  readonly deviceId: string | null
}

export async function spendRefreshToken(params: SpendRefreshTokenParams): Promise<RefreshOutcome> {
  const result = await withResolvedTenant(
    refreshTokenResolver(params.presentedTokenHash),
    async (tx, { tokenId }, tenantId) => {
      // The full chain, read once, under RLS, additionally pinned to the
      // resolver's own answer. A resolver bug that named the wrong token
      // becomes zero rows here, not a wrong-tenant write.
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
          'rt.expires_at',
          'rt.family_id',
          'f.revoked_at as family_revoked_at',
          's.id as session_id',
          's.revoked_at as session_revoked_at',
          'u.id as user_id',
          'u.email',
          'u.full_name',
          's.permission_version',
          't.code as tenant_code',
          't.name as tenant_name',
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

      if (candidate.used_at !== null) {
        // REUSE. No grace window at any delay (ADR-0022) — revoke the whole
        // family, whoever presented it, and stop. The row-level lock this
        // UPDATE takes serialises against a concurrent spend of a sibling.
        await tx
          .updateTable('refresh_token_families')
          .set({
            revoked_at: new Date(),
            revoked_reason: 'REUSE_DETECTED',
            updated_by: candidate.user_id,
            version: sql`version + 1`,
          })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', candidate.family_id)
          .where('revoked_at', 'is', null)
          .execute()

        return { outcome: 'reused' } satisfies RefreshOutcome
      }

      if (candidate.expires_at <= new Date()) {
        return { outcome: 'expired' } satisfies RefreshOutcome
      }

      // The atomic spend. `used_at IS NULL AND expires_at > now()` re-checked
      // in the WHERE even though both were just read: this is the fence that
      // actually matters under concurrency — a second caller racing on the
      // same token blocks on the row lock and re-evaluates against the
      // committed row, never both winning (ADR-0022's row-lock serialisation).
      //
      // migration 005's `refresh_tokens_enforce_transition` additionally
      // takes a FOR SHARE lock on the family and RAISES if it was revoked
      // between our read above and this statement — a race this narrow, not
      // a rowcount-0 case. Mapped to the same outcome as reuse: either way,
      // this token may not be spent.
      let spend: { numUpdatedRows: bigint }
      try {
        spend = await tx
          .updateTable('refresh_tokens')
          .set({ used_at: new Date(), updated_by: candidate.user_id, version: sql`version + 1` })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', tokenId)
          .where('used_at', 'is', null)
          .where('expires_at', '>', new Date())
          .executeTakeFirst()
      } catch (error) {
        if ((error as { code?: string }).code === '23514') {
          return { outcome: 'reused' } satisfies RefreshOutcome
        }
        throw error
      }

      if (spend.numUpdatedRows === 0n) {
        // Lost the race to a concurrent spend of the SAME token. ADR-0022
        // makes no distinction by who arrives second: whoever presents an
        // already-spent token is in the reuse branch.
        return { outcome: 'reused' } satisfies RefreshOutcome
      }

      const successor = await tx
        .insertInto('refresh_tokens')
        .values({
          tenant_id: tenantId,
          family_id: candidate.family_id,
          token_hash: params.newTokenHash,
          expires_at: params.newTokenExpiresAt,
          created_by: candidate.user_id,
          updated_by: candidate.user_id,
        })
        .returning('id')
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
        .set({ last_seen_at: new Date(), version: sql`version + 1` })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', candidate.session_id)
        .execute()

      return {
        outcome: 'success',
        tenant: { id: tenantId, code: candidate.tenant_code, name: candidate.tenant_name },
        user: { id: candidate.user_id, email: candidate.email, fullName: candidate.full_name },
        sessionId: candidate.session_id,
        permissionVersion: candidate.permission_version,
      } satisfies RefreshOutcome
    },
  )

  // withResolvedTenant returns null only when the resolver itself found
  // nothing — an unknown token hash.
  return result ?? { outcome: 'unknown' }
}
