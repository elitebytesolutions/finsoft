import { sql } from 'kysely'
import { withTenant } from '@finsoft/database'
import { createTenantFixture, runAs, type TenantFixture } from '@finsoft/database/testing'
import { hashPassword } from '@finsoft/auth'

/*
 * A tiny, reusable fixture: a tenant plus one ACTIVE user with a real
 * argon2id password hash, through the ordinary grant/trigger path
 * (migration 007's column-scoped UPDATE, INVITED -> ACTIVE). Built on top of
 * `createTenantFixture`'s provisioned INVITED owner rather than duplicating
 * tenant/user creation.
 *
 * Reused by tests/security's auth specs, and intended for the staging
 * bhatti1/bhatti2 seed (docs/WAVE_1_REGISTER.md W1-002's own note that this
 * lane's seed helper is what a later staging-seed task builds on).
 */

export interface ActiveUserFixture extends TenantFixture {
  readonly email: string
  readonly password: string
}

export async function createActiveUserFixture(
  label: string,
  password = 'Correct-Horse-Battery-Staple-1',
): Promise<ActiveUserFixture> {
  const fixture = await createTenantFixture(label)
  const passwordHash = await hashPassword(password)

  const email = await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant(async (tx) => {
      const row = await tx
        .updateTable('users')
        .set({
          password_hash: passwordHash,
          status: 'ACTIVE',
          // The fixture owner is the provisioned owner (created_by IS
          // NULL — createTenantFixture's own doc comment). users_authorship_
          // pair_or_neither requires updated_by to stay NULL too.
          updated_by: null,
          version: 1,
        })
        .where('id', '=', fixture.ownerId)
        .returning('email')
        .executeTakeFirstOrThrow()
      return row.email
    }),
  )

  return { ...fixture, email, password }
}

/**
 * Flips an ACTIVE user to DISABLED, through the ordinary grant/trigger path
 * (migration 007's column-scoped UPDATE and `users_enforce_transition`'s
 * ACTIVE -> DISABLED arm) — not a raw bypass. Used by L4's "disabled user
 * refreshing" case: the user's existing session/refresh token stay exactly
 * as they were: only the account's own status changes.
 */
export async function disableUser(fixture: ActiveUserFixture): Promise<void> {
  await runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant((tx) =>
      tx
        .updateTable('users')
        // A relative bump, not a literal: this fixture's user may already
        // have logged in (which itself bumps version), so a hardcoded
        // literal can collide with users_enforce_transition's "version must
        // increase" check.
        .set({ status: 'DISABLED', updated_by: null, version: sql`version + 1` })
        .where('id', '=', fixture.ownerId)
        .execute(),
    ),
  )
}
