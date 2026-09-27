import { sql } from 'kysely'
import { TenantContext } from '../tenant-context.ts'
import { withResolvedTenant, withTenant, type TenantTx } from '../transaction.ts'
import { tenantByCodeResolver, type ResolvedTenantRow } from './resolvers.ts'

/*
 * The login persistence boundary. ADR-0023 §1, §3, §4. Security re-review
 * findings B5, C2, C3 (2026-09-27) folded in.
 *
 * TWO TRANSACTIONS, NOT ONE (C2). ADR-0023 §3 originally asked for a single
 * transaction spanning the read, the argon2id verification and the write,
 * "which §1's claim about RLS being in force during verification requires".
 * That claim is satisfied by the READ alone — `password_hash` is read under
 * RLS with the tenant established, which is the property that matters.
 * Holding the transaction open across argon2id itself (~20ms of pure CPU,
 * per the concurrency semaphore's own budget) means an unauthenticated
 * endpoint under a burst of concurrent attempts holds a pooled connection
 * for the duration of every hash in flight — a connection-pool exhaustion
 * vector distinct from, and not covered by, the memory/CPU semaphore.
 * Security review flagged this and it is fixed here: the resolve+read
 * transaction commits before `decide` (argon2id) runs, and a second, short
 * transaction does only the write. The tenant id crossing between them is
 * NOT a request-derived value — it is the SAME resolver's own return value
 * from transaction one, carried in a local variable, never re-derived from
 * anything the caller supplied.
 *
 * `decide` still runs argon2id exactly once, still before any status is
 * evaluated (ADR-0023 §4) — only the transaction boundary moved.
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
}

export type LoginDecision =
  { readonly authenticate: false } | ({ readonly authenticate: true } & LoginSessionWrite)

export interface LoginSuccess {
  readonly authenticated: true
  readonly tenant: ResolvedTenantRow
  readonly user: { readonly id: string; readonly email: string; readonly fullName: string }
  readonly sessionId: string
  readonly permissionVersion: number
  /** Computed by PostgreSQL (`now() + interval '14 days'`), never by the caller. See B5. */
  readonly refreshTokenExpiresAt: Date
}

export type LoginAttemptResult = LoginSuccess | { readonly authenticated: false }

/**
 * Resolves `tenantCode` against the global `tenants` table, reads the one
 * candidate user by `(tenant_id, lower(email))` in a transaction that
 * commits immediately, then lets `decide` — which runs argon2id with no
 * transaction open — choose whether to write a session and a refresh token
 * family in a second, short transaction.
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
  const tenant = resolved.tenant

  // The second, short transaction. `tenant.id` here is transaction one's
  // resolver output, not request input — TenantContext.run is the
  // sanctioned way to re-enter tenant scope for a value already obtained
  // this way (the same pattern packages/auth's own logout() and
  // session-cache.ts use for the already-authenticated path).
  return TenantContext.run({ tenantId: tenant.id, userId: user.id }, () =>
    withTenant((tx) => writeLoginSuccess(tx, tenant, user, decision)),
  )
}

async function attemptVersionedUpdate(
  tx: TenantTx,
  tenant: ResolvedTenantRow,
  user: LoginCandidateUser,
  version: number,
): Promise<boolean> {
  const updated = await tx
    .updateTable('users')
    .set({
      last_login_at: sql`now()`,
      // See LoginCandidateUser.createdBy's comment: the provisioned owner's
      // updated_by must stay NULL, or users_authorship_pair_or_neither fails.
      updated_by: user.createdBy === null ? null : user.id,
      version: version + 1,
    })
    .where('tenant_id', '=', tenant.id)
    .where('id', '=', user.id)
    .where('version', '=', version)
    .executeTakeFirst()

  return updated.numUpdatedRows > 0n
}

async function writeLoginSuccess(
  tx: TenantTx,
  tenant: ResolvedTenantRow,
  user: LoginCandidateUser,
  write: LoginSessionWrite,
): Promise<LoginAttemptResult> {
  // C3: an optimistic-lock miss is not this caller's fault and must never
  // surface as a 500. Retried once against the row's current version — the
  // race window is a handful of milliseconds between transaction one's read
  // and transaction two's write, so a second concurrent login (or a
  // password-change happening in the same instant) is the only realistic
  // cause, and one retry resolves it. If it is STILL lost, this is reported
  // as a plain authentication failure (identical 401), never thrown.
  let ok = await attemptVersionedUpdate(tx, tenant, user, user.version)
  if (!ok) {
    const fresh = await tx
      .selectFrom('users')
      .select('version')
      .where('tenant_id', '=', tenant.id)
      .where('id', '=', user.id)
      .executeTakeFirst()
    ok = fresh ? await attemptVersionedUpdate(tx, tenant, user, fresh.version) : false
  }
  if (!ok) {
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
    .returning(['id', 'permission_version'])
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
    permissionVersion: session.permission_version,
    refreshTokenExpiresAt: token.expires_at,
  }
}
