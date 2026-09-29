import { sql } from 'kysely'
import { withResolvedTenant, type TenantTx } from '../transaction.ts'
import { tenantByCodeResolver, type ResolvedTenantRow } from './resolvers.ts'

/*
 * The login persistence boundary. ADR-0023 §1, §3, §4. Security/Architecture/
 * Database re-review findings B5, C2, C3 (2026-09-27) and the follow-up
 * TOCTOU findings (Arch F1/F2/F3, DB F1, Security N1, 2026-09-27) folded in.
 *
 * TWO TRANSACTIONS, NOT ONE (C2). ADR-0023 §3 originally asked for a single
 * transaction spanning the read, the argon2id verification and the write.
 * That claim is satisfied by the READ alone — `password_hash` is read under
 * RLS with the tenant established, which is the property that matters.
 * Holding a transaction open across argon2id (tens of milliseconds of pure
 * CPU) means an unauthenticated endpoint under a burst of concurrent
 * attempts holds a pooled connection for the duration of every hash in
 * flight. The Architecture seat will record this split as a partial
 * supersession of ADR-0023 §3 in ADR-0025; it is not this file's job to
 * argue the point further.
 *
 * THE TOCTOU THE SPLIT INTRODUCES, AND HOW IT IS CLOSED. Between
 * transaction one's read and transaction two's write, tens of milliseconds
 * pass — long enough for an admin to disable the user, change the password,
 * or suspend the tenant. An earlier version of this file re-verified only
 * the OPTIMISTIC LOCK (`version`) before writing, which proves nothing about
 * ACCOUNT STATE: a version-only guard lets a disabled user, or a user whose
 * password just changed, still receive a session and a 14-day refresh
 * token, because the retry re-read `version` and nothing else. Fixed by
 * making the WRITE statement itself the point of truth: `writeLoginSuccess`
 * guards its `UPDATE users` on `status = 'ACTIVE' AND password_hash =
 * $verifiedHash` — the row's own lock during that one statement is what
 * decides, atomically, against whatever is true AT THE MOMENT OF THE WRITE,
 * not what was true when transaction one read the row. Zero rows updated is
 * reported as an ordinary authentication failure, never thrown.
 *
 * THE TENANT FOR THE WRITE IS RE-RESOLVED, NOT CARRIED THROUGH
 * TenantContext (ADR-0023 §3/A2). An earlier version threaded
 * `tenant.id` from transaction one into `TenantContext.run` for
 * transaction two — a bare string, not the branded `ResolvedTenantId`
 * `withResolvedTenant` demands, and a shape a future caller copying this
 * file could reattach to genuinely request-derived input without anything
 * failing to compile. This version calls `withResolvedTenant` a SECOND
 * time, by the same tenant code, for the write — the only way a tenant id
 * enters this module — and additionally requires the resolved id to match
 * transaction one's AND the tenant's status to still be ACTIVE, failing
 * identically otherwise.
 */

export interface LoginCandidateUser {
  readonly id: string
  readonly email: string
  readonly fullName: string
  readonly passwordHash: string | null
  readonly status: string
  readonly version: number
  /**
   * NULL only for the one provisioned owner per tenant (migration 002).
   * Carried through so the login write can respect
   * `users_authorship_pair_or_neither` — `(created_by IS NULL) = (updated_by
   * IS NULL)`, enforced at all times, not only at insert. A provisioned
   * owner logging in must therefore leave `updated_by` NULL too; setting it
   * to their own id would violate that CHECK on the very first login.
   */
  readonly createdBy: string | null
}

export interface LoginCandidate {
  readonly tenant: ResolvedTenantRow
  /** null when no user exists at this address in this tenant. */
  readonly user: LoginCandidateUser | null
}

export interface LoginSessionWrite {
  readonly deviceId: string | null
  readonly ip: string | null
  readonly userAgent: string | null
  /** SHA-256 hex digest of the freshly minted refresh token. Never the raw value. */
  readonly refreshTokenHash: string
  /**
   * The EXACT `password_hash` value that was verified in `decide`. The write
   * guards on this — see this file's header — so a password change between
   * the read and the write invalidates the write rather than silently
   * succeeding against a credential that is no longer current.
   */
  readonly verifiedPasswordHash: string
}

export type LoginDecision =
  { readonly authenticate: false } | ({ readonly authenticate: true } & LoginSessionWrite)

export interface LoginSuccess {
  readonly authenticated: true
  readonly tenant: ResolvedTenantRow
  readonly user: { readonly id: string; readonly email: string; readonly fullName: string }
  readonly sessionId: string
  /**
   * M1-X, L1. `users.version` AS RETURNED BY THIS VERY LOGIN's own `UPDATE`
   * — i.e. AFTER the increment this write already performs, never the
   * pre-write value read in transaction one. `users.version` is bumped both
   * as login's own optimistic lock (migration 002) and, via migration 008's
   * trigger, whenever this user's effective permission set changes
   * (008_create_rbac.sql's header). Snapshotting the pre-write value here
   * would mint a token that is immediately one behind the version its own
   * login just produced, and packages/auth's guard would refuse it on the
   * very first request. See packages/auth/src/guard.ts for where this is
   * compared against the CURRENT users.version on every subsequent request.
   */
  readonly permissionVersion: number
  /** Computed by PostgreSQL (`now() + interval '14 days'`), never by the caller. See B5. */
  readonly refreshTokenExpiresAt: Date
}

export type LoginAttemptResult = LoginSuccess | { readonly authenticated: false }

export interface LoginTestHooks {
  /**
   * TEST ONLY. Called after `decide` has authenticated the candidate and
   * before the write transaction opens — the exact window a TOCTOU exploits.
   * Production code never sets this; it exists so an integration test can
   * mutate the row (disable the user, change the password, suspend the
   * tenant) on a SEPARATE connection at precisely this point and assert the
   * write still fails identically.
   */
  readonly beforeWrite?: () => Promise<void>
}

/**
 * Resolves `tenantCode` against the global `tenants` table, reads the one
 * candidate user by `(tenant_id, lower(email))` in a transaction that
 * commits immediately, then lets `decide` — which runs argon2id with no
 * transaction open — choose whether to write a session and a refresh token
 * family in a second, short transaction that re-resolves the tenant and
 * re-verifies account state at write time (see this file's header).
 *
 * Returns `null` when the tenant code does not resolve at all: the caller
 * (`packages/auth`) must still perform its one decoy verification in that
 * case, so that exactly one argon2id call happens on every path (ADR-0023
 * §4).
 */
export async function withLoginAttempt(
  tenantCode: string,
  normalisedEmail: string,
  decide: (candidate: LoginCandidate) => Promise<LoginDecision>,
  testHooks?: LoginTestHooks,
): Promise<LoginAttemptResult | null> {
  const resolved = await withResolvedTenant(
    tenantByCodeResolver(tenantCode),
    async (tx, { tenant }) => {
      const userRow = await tx
        .selectFrom('users')
        .select(['id', 'email', 'full_name', 'password_hash', 'status', 'version', 'created_by'])
        .where(sql<boolean>`lower(email) = ${normalisedEmail}`)
        .executeTakeFirst()

      const candidate: LoginCandidate = {
        tenant,
        user: userRow
          ? {
              id: userRow.id,
              email: userRow.email,
              fullName: userRow.full_name,
              passwordHash: userRow.password_hash,
              status: userRow.status,
              version: userRow.version,
              createdBy: userRow.created_by,
            }
          : null,
      }
      return candidate
    },
  )

  if (!resolved) return null

  const decision = await decide(resolved)
  if (!decision.authenticate) {
    return { authenticated: false }
  }

  // `decide` returning `authenticate: true` is only reachable with a real
  // user row — packages/auth's decision function is the one place that
  // enforces `user !== null && status === 'ACTIVE'` before returning it.
  // This defends the invariant a second time rather than trusting the
  // caller: a bug in the decision function must not be able to write a
  // session for a candidate with no user.
  if (!resolved.user) {
    throw new Error('withLoginAttempt: decide() authenticated a candidate with no user row')
  }
  const user = resolved.user
  const tenantAtRead = resolved.tenant

  if (testHooks?.beforeWrite) await testHooks.beforeWrite()

  // The second, short transaction. tenantCode is resolved AGAIN — the only
  // way a tenant id may enter this module (ADR-0023 §3/A2) — never carried
  // forward as a bare string through TenantContext.
  const writeResult = await withResolvedTenant(
    tenantByCodeResolver(tenantCode),
    async (tx, { tenant: tenantAtWrite }, tenantIdAtWrite) => {
      if (tenantIdAtWrite !== tenantAtRead.id) {
        // The tenant code resolved to a DIFFERENT id than moments ago.
        // Should be unreachable (tenant ids are immutable once assigned —
        // there is no code path that reassigns a code to a different row),
        // but this function does not trust that absence of a code path is
        // the same as a guarantee.
        return { authenticated: false } satisfies LoginAttemptResult
      }
      if (tenantAtWrite.status !== 'ACTIVE') {
        return { authenticated: false } satisfies LoginAttemptResult
      }
      return writeLoginSuccess(tx, tenantAtWrite, user, decision)
    },
  )

  // withResolvedTenant returns null only if the resolver finds nothing on
  // this second call — the tenant code stopped resolving between the two
  // reads. Reported the same way as every other failure on this path.
  return writeResult ?? { authenticated: false }
}

async function writeLoginSuccess(
  tx: TenantTx,
  tenant: ResolvedTenantRow,
  user: LoginCandidateUser,
  write: LoginSessionWrite,
): Promise<LoginAttemptResult> {
  // THE POINT OF TRUTH (item 1a). One statement, guarded on the account
  // state the credential was verified against, not on an optimistic
  // version counter: the row's own lock during THIS UPDATE decides against
  // whatever is true right now. `status <> 'ACTIVE'` (disabled since the
  // read), `password_hash <> $verifiedHash` (changed since the read, by a
  // reset or an admin action) or the row no longer existing all produce
  // ZERO rows updated, reported identically to a wrong password. version is
  // NOT in the WHERE clause — see the file header: two genuinely concurrent
  // valid logins for the same user must both succeed, and an optimistic
  // lock on a login-only column serves no purpose the state guard does not
  // already serve.
  const updated = await tx
    .updateTable('users')
    .set({
      last_login_at: sql`now()`,
      // See LoginCandidateUser.createdBy's comment: the provisioned owner's
      // updated_by must stay NULL, or users_authorship_pair_or_neither fails.
      updated_by: user.createdBy === null ? null : user.id,
      version: sql`version + 1`,
    })
    .where('tenant_id', '=', tenant.id)
    .where('id', '=', user.id)
    .where('status', '=', 'ACTIVE')
    .where('password_hash', '=', write.verifiedPasswordHash)
    // M1-X, L1: the post-increment value, for the token's permVer claim.
    .returning(['version'])
    .executeTakeFirst()

  if (!updated) {
    return { authenticated: false }
  }

  const session = await tx
    .insertInto('sessions')
    .values({
      tenant_id: tenant.id,
      user_id: user.id,
      device_id: write.deviceId,
      ip: write.ip,
      user_agent: write.userAgent,
      created_by: user.id,
      updated_by: user.id,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()

  const family = await tx
    .insertInto('refresh_token_families')
    .values({
      tenant_id: tenant.id,
      session_id: session.id,
      created_by: user.id,
      updated_by: user.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // B5: expiry computed by PostgreSQL (`now() + interval '14 days'`), the
  // same clock migration 005's `rt_lifetime_ceiling` CHECK measures
  // `issued_at` against — never a value the application computed from its
  // own clock, which a few seconds of skew turns into an uncaught 23514.
  const token = await tx
    .insertInto('refresh_tokens')
    .values({
      tenant_id: tenant.id,
      family_id: family.id,
      token_hash: write.refreshTokenHash,
      expires_at: sql`now() + interval '14 days'`,
      created_by: user.id,
      updated_by: user.id,
    })
    .returning('expires_at')
    .executeTakeFirstOrThrow()

  return {
    authenticated: true,
    tenant,
    user: { id: user.id, email: user.email, fullName: user.fullName },
    sessionId: session.id,
    permissionVersion: updated.version,
    refreshTokenExpiresAt: token.expires_at,
  }
}
