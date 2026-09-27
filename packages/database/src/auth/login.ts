import { sql } from 'kysely'
import { withResolvedTenant, type TenantTx } from '../transaction.ts'
import { tenantByCodeResolver, type ResolvedTenantRow } from './resolvers.ts'

/*
 * The login persistence boundary. ADR-0023 §1, §3, §4.
 *
 * `packages/auth` owns the credential decision (argon2id, constant-time,
 * decoy hash) but never touches Kysely (dependency-cruiser's
 * `kysely-is-allowlisted`). This module owns the one transaction that reads
 * the candidate row and, if `decide` says so, writes the login's effects —
 * so that "the credential verification and the last_login_at write share
 * one transaction with the tenant established once" (ADR-0023 §3) is a
 * structural fact rather than a convention two packages have to honour
 * separately.
 *
 * `decide` runs *inside* the transaction. Argon2id is pure CPU work with no
 * database dependency, so awaiting it here costs a held connection for the
 * duration of one hash (~20ms) and buys the single-transaction property.
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
  readonly refreshTokenExpiresAt: Date
}

export type LoginDecision =
  { readonly authenticate: false } | ({ readonly authenticate: true } & LoginSessionWrite)

export interface LoginSuccess {
  readonly authenticated: true
  readonly tenant: ResolvedTenantRow
  readonly user: { readonly id: string; readonly email: string; readonly fullName: string }
  readonly sessionId: string
  readonly permissionVersion: number
}

export type LoginAttemptResult = LoginSuccess | { readonly authenticated: false }

/**
 * Resolves `tenantCode` against the global `tenants` table, reads the one
 * candidate user by `(tenant_id, lower(email))`, and lets `decide` — which
 * has already run its argon2id verification by the time it returns — choose
 * whether to write a session and a refresh token family in the same
 * transaction.
 *
 * Returns `null` when the tenant code does not resolve at all: the caller
 * (`packages/auth`) must still perform its one decoy verification in that
 * case, outside any transaction, so that exactly one argon2id call happens
 * on every path (ADR-0023 §4).
 */
export async function withLoginAttempt(
  tenantCode: string,
  normalisedEmail: string,
  decide: (candidate: LoginCandidate) => Promise<LoginDecision>,
): Promise<LoginAttemptResult | null> {
  return withResolvedTenant(tenantByCodeResolver(tenantCode), async (tx, { tenant }) => {
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

    const decision = await decide(candidate)
    if (!decision.authenticate) {
      return { authenticated: false }
    }

    // `decide` returning `authenticate: true` is only reachable with a real
    // user row — packages/auth's decision function is the one place that
    // enforces `user !== null && status === 'ACTIVE'` before returning it.
    // This defends the invariant a second time rather than trusting the
    // caller: a bug in the decision function must not be able to write a
    // session for a candidate with no user.
    if (!candidate.user) {
      throw new Error('withLoginAttempt: decide() authenticated a candidate with no user row')
    }
    const user = candidate.user

    return writeLoginSuccess(tx, tenant, user, decision)
  })
}

async function writeLoginSuccess(
  tx: TenantTx,
  tenant: ResolvedTenantRow,
  user: LoginCandidateUser,
  write: LoginSessionWrite,
): Promise<LoginSuccess> {
  const updated = await tx
    .updateTable('users')
    .set({
      last_login_at: new Date(),
      // See LoginCandidateUser.createdBy's comment: the provisioned owner's
      // updated_by must stay NULL, or users_authorship_pair_or_neither fails.
      updated_by: user.createdBy === null ? null : user.id,
      version: user.version + 1,
    })
    .where('tenant_id', '=', tenant.id)
    .where('id', '=', user.id)
    .where('version', '=', user.version)
    .executeTakeFirst()

  if (updated.numUpdatedRows === 0n) {
    // Optimistic lock lost — another concurrent login/update on this exact
    // row. Rare and not the client's fault; the caller maps this to a 401
    // (identical to any other failure) rather than a 500, because retrying
    // is indistinguishable from a fresh login attempt.
    throw new Error('withLoginAttempt: concurrent update lost the optimistic lock on users')
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

  await tx
    .insertInto('refresh_tokens')
    .values({
      tenant_id: tenant.id,
      family_id: family.id,
      token_hash: write.refreshTokenHash,
      expires_at: write.refreshTokenExpiresAt,
      created_by: user.id,
      updated_by: user.id,
    })
    .execute()

  return {
    authenticated: true,
    tenant,
    user: { id: user.id, email: user.email, fullName: user.fullName },
    sessionId: session.id,
    permissionVersion: session.permission_version,
  }
}
