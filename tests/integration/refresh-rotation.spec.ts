import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'

import { withTenant } from '@finsoft/database'
import { spendRefreshToken } from '@finsoft/database/auth'
import { createActiveUserFixture } from './helpers/auth-seed.ts'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  scalarOn,
  sqlstate,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * Refresh token rotation, against a real PostgreSQL. Migration 005, ADR-0009.
 *
 * WHAT THIS FILE EXISTS TO PROVE
 *
 * Migration 005's header makes one claim that no amount of reading the SQL
 * can settle, because it is a claim about CONCURRENCY:
 *
 *   Two concurrent callers cannot both see rowcount 1, because the second
 *   blocks on the row lock and then re-evaluates `used_at IS NULL` against
 *   the committed row.
 *
 * Under READ COMMITTED that is true, and it is true for a reason specific to
 * this isolation level: a blocked UPDATE re-reads the row after the lock is
 * released and re-checks its WHERE clause against the NEW version. Under
 * REPEATABLE READ the same statement would raise a serialization failure
 * instead — a different, also-safe outcome, but a different one, and the
 * application's error handling differs between them. ARCHITECTURE §7 line 302
 * fixes READ COMMITTED system-wide, so the behaviour asserted here is the
 * behaviour production gets.
 *
 * THE CORRECTION THIS FILE GUARDS
 *
 * An earlier plan for this wave proposed treating two near-simultaneous
 * refreshes as "a legitimate tab race" and NOT revoking the family. The
 * Product Owner rejected it before any code was written, on the grounds that
 * a replayed stolen token and a second browser tab present the SAME EVIDENCE
 * to the server and cannot be told apart.
 *
 * The test named `the loser is indistinguishable from an attacker` below is
 * the executable form of that correction. It asserts a NEGATIVE — that the
 * database hands the application nothing it could use to distinguish them —
 * and it is the test that fails if someone later adds a "within 5 seconds,
 * same IP, allow it" carve-out. Read it before adding one.
 */

beforeAll(async () => {
  await prepareTestDatabase()
}, 60_000)

afterAll(async () => {
  await teardownTestDatabase()
})

let tenant: TenantFixture
let other: TenantFixture

beforeAll(async () => {
  tenant = await createTenantFixture('RRA')
  other = await createTenantFixture('RRB')
}, 60_000)

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** What the application does with the raw token: hash it, keep nothing else. */
const hashToken = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex')

interface Chain {
  readonly sessionId: string
  readonly familyId: string
  readonly tokenId: string
  readonly raw: string
  /** Minted by the column DEFAULT, not by this file. */
  readonly scid: string
}

/** A session, a family and one live token — what a successful login produces. */
async function login(fixture: TenantFixture): Promise<Chain> {
  const raw = randomUUID() + randomUUID()

  return runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant(async (tx) => {
      const [session] = await rawOn<{ id: string; session_correlation_id: string }>(
        tx,
        `INSERT INTO sessions (tenant_id, user_id, created_by, updated_by)
         VALUES ($1, $2, $2, $2) RETURNING id, session_correlation_id`,
        [fixture.tenantId, fixture.ownerId],
      )
      const [family] = await rawOn<{ id: string }>(
        tx,
        `INSERT INTO refresh_token_families (tenant_id, session_id, created_by, updated_by)
         VALUES ($1, $2, $3, $3) RETURNING id`,
        [fixture.tenantId, session!.id, fixture.ownerId],
      )
      const [token] = await rawOn<{ id: string }>(
        tx,
        `INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, expires_at, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '13 days', $4, $4) RETURNING id`,
        [fixture.tenantId, family!.id, hashToken(raw), fixture.ownerId],
      )
      return {
        sessionId: session!.id,
        familyId: family!.id,
        tokenId: token!.id,
        raw,
        scid: (session as { session_correlation_id: string }).session_correlation_id,
      }
    }),
  )
}

/*
 * The single-use fence, as the application will issue it.
 *
 * The WHERE clause is the whole mechanism: `used_at IS NULL` is what the
 * second caller re-evaluates after the first commits. It returns the rows
 * affected, because rowcount is the signal — 1 means this caller may rotate,
 * 0 means the token was already spent and the family must be revoked.
 */
async function spend(
  tx: Parameters<typeof rawOn>[0],
  tokenHash: string,
  actorId: string,
): Promise<string[]> {
  // Literally the statement migration 005's header documents. An earlier
  // version differed in two harmless-looking ways — `updated_by = created_by`
  // and a narrower RETURNING — which is how a header drifts from the thing it
  // claims to describe.
  const rows = await rawOn<{ id: string; family_id: string }>(
    tx,
    `UPDATE refresh_tokens
        SET used_at = now(), updated_by = $2, version = version + 1
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING id, family_id`,
    [tokenHash, actorId],
  )
  return rows.map((r) => r.family_id)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ *
 * The fence
 * ------------------------------------------------------------------ */

describe('the single-use fence', () => {
  it('lets exactly one of two concurrent spends win', async () => {
    const chain = await login(tenant)
    const principal = { tenantId: tenant.tenantId, userId: tenant.ownerId }

    /*
     * Two real transactions on two pool connections, interleaved so that the
     * second is genuinely blocked on the first's row lock when the first
     * commits. Sequencing them with promises rather than sleeps alone is
     * what makes this a test of the lock rather than a test of timing:
     * `firstHasUpdated` cannot resolve before the UPDATE returned, so the
     * second statement is always issued against a locked row.
     */
    let releaseFirst!: () => void
    const firstMayCommit = new Promise<void>((r) => {
      releaseFirst = r
    })
    let firstHasUpdated!: () => void
    const firstUpdated = new Promise<void>((r) => {
      firstHasUpdated = r
    })

    const winner = runAs(principal, () =>
      withTenant(async (tx) => {
        const rows = await spend(tx, hashToken(chain.raw), tenant.ownerId)
        firstHasUpdated()
        await firstMayCommit
        return rows
      }),
    )

    await firstUpdated

    const loser = runAs(principal, () =>
      withTenant(async (tx) => spend(tx, hashToken(chain.raw), tenant.ownerId)),
    )

    // Long enough that the second statement is certainly waiting on the lock
    // rather than merely queued in the driver.
    await sleep(250)
    releaseFirst()

    const [a, b] = await Promise.all([winner, loser])

    expect(a).toHaveLength(1)
    expect(
      b,
      'the second caller re-evaluated `used_at IS NULL` against the committed row and matched nothing',
    ).toHaveLength(0)
  })

  it('the loser is indistinguishable from an attacker', async () => {
    /*
     * THE EXECUTABLE FORM OF THE PRODUCT OWNER'S CORRECTION.
     *
     * Two presentations of the same spent token: one from a second browser
     * tab racing the first, one from someone who stole the cookie and
     * replayed it an hour later. This asserts the database returns the SAME
     * THING for both — an empty result — so no application branch can exist
     * that treats them differently, because there is no input on which to
     * branch.
     *
     * If a future change makes this test fail by returning something richer
     * from the losing UPDATE, that richer return value is precisely the
     * "distinguish the tab from the thief" signal that does not exist. The
     * correct response is to delete the change, not to update the assertion.
     */
    const chain = await login(tenant)
    const principal = { tenantId: tenant.tenantId, userId: tenant.ownerId }

    await runAs(principal, () =>
      withTenant((tx) => spend(tx, hashToken(chain.raw), tenant.ownerId)),
    )

    const tabRace = await runAs(principal, () =>
      withTenant((tx) => spend(tx, hashToken(chain.raw), tenant.ownerId)),
    )
    const replayedTheft = await runAs(principal, () =>
      withTenant((tx) => spend(tx, hashToken(chain.raw), tenant.ownerId)),
    )

    expect(tabRace).toEqual([])
    expect(replayedTheft).toEqual([])
    expect(
      tabRace,
      'the server sees identical evidence in both cases; revoking the family is the only safe response to either',
    ).toEqual(replayedTheft)
  })

  it('revokes the whole family in one write, whatever its length', async () => {
    const chain = await login(tenant)
    const principal = { tenantId: tenant.tenantId, userId: tenant.ownerId }

    // Rotate three times, so the family has depth and a walk would have work to do.
    let current = chain.raw
    let currentId = chain.tokenId
    for (let i = 0; i < 3; i++) {
      const next = randomUUID() + randomUUID()
      const nextId: string = await runAs(principal, () =>
        withTenant(async (tx) => {
          await spend(tx, hashToken(current), tenant.ownerId)
          const [row] = await rawOn<{ id: string }>(
            tx,
            `INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, expires_at, created_by, updated_by)
             VALUES ($1, $2, $3, now() + interval '13 days', $4, $4) RETURNING id`,
            [tenant.tenantId, chain.familyId, hashToken(next), tenant.ownerId],
          )
          await rawOn(
            tx,
            `UPDATE refresh_tokens SET replaced_by = $1, version = version + 1 WHERE id = $2`,
            [row!.id, currentId],
          )
          return row!.id
        }),
      )
      current = next
      currentId = nextId
    }

    const affected = await runAs(principal, () =>
      withTenant(async (tx) => {
        const rows = await rawOn<{ id: string }>(
          tx,
          `UPDATE refresh_token_families
              SET revoked_at = now(), revoked_reason = 'refresh token reuse detected',
                  updated_by = created_by, version = version + 1
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING id`,
          [chain.familyId],
        )
        return rows.length
      }),
    )

    expect(affected, 'one row, regardless of how many tokens descend from it').toBe(1)

    const depth = await runAs(principal, () =>
      withTenant((tx) =>
        scalarOn<string>(tx, `SELECT count(*) FROM refresh_tokens WHERE family_id = $1`, [
          chain.familyId,
        ]),
      ),
    )
    expect(Number(depth)).toBe(4)
  })
})

/* ------------------------------------------------------------------ *
 * Tenancy
 * ------------------------------------------------------------------ */

describe('tenant isolation', () => {
  it('hides another tenant’s session, family and tokens', async () => {
    const mine = await login(tenant)

    const seen = await runAs({ tenantId: other.tenantId, userId: other.ownerId }, () =>
      withTenant(async (tx) => ({
        sessions: await rawOn(tx, `SELECT id FROM sessions WHERE id = $1`, [mine.sessionId]),
        families: await rawOn(tx, `SELECT id FROM refresh_token_families WHERE id = $1`, [
          mine.familyId,
        ]),
        tokens: await rawOn(tx, `SELECT id FROM refresh_tokens WHERE id = $1`, [mine.tokenId]),
      })),
    )

    expect(seen.sessions).toEqual([])
    expect(seen.families).toEqual([])
    expect(seen.tokens).toEqual([])
  })

  it('cannot spend another tenant’s token by presenting its hash', async () => {
    /*
     * The IDOR shape, and the one that matters most here: a refresh token is
     * looked up BY HASH, with no id in the request, so an attacker who
     * obtains a hash from another tenant has the only input the lookup takes.
     * RLS on the UPDATE's USING clause is what makes the row invisible to the
     * statement rather than merely unreadable afterwards.
     */
    const mine = await login(tenant)

    const spent = await runAs({ tenantId: other.tenantId, userId: other.ownerId }, () =>
      withTenant((tx) => spend(tx, hashToken(mine.raw), other.ownerId)),
    )
    expect(spent).toEqual([])

    const stillLive = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        scalarOn<Date | null>(tx, `SELECT used_at FROM refresh_tokens WHERE id = $1`, [
          mine.tokenId,
        ]),
      ),
    )
    expect(stillLive, 'the neighbour’s attempt must not have spent it either').toBeNull()
  })

  /*
   * D5 (docs/WAVE_1_REGISTER.md D-W1-004; ADR-0023 §2): the test above
   * derives its ENTIRE guarantee from RLS being in force on a by-hash
   * lookup executed under an ESTABLISHED tenant context (`withTenant`,
   * `other`'s). The real refresh path has neither — it calls
   * `spendRefreshToken` with NO tenant context at all, and the tenant is
   * decided by migration 006's SECURITY DEFINER resolver, not by RLS on the
   * caller's own connection. That guarantee has to be re-proved through the
   * ACTUAL mechanism, or it silently stops testing anything the moment the
   * production code path diverges from this test's assumptions — which it
   * already has.
   */
  it('spendRefreshToken (the production mechanism) resolves and spends under the OWNING tenant only, with no tenant context established at all', async () => {
    // spendRefreshToken now checks users.status/tenants.status ACTIVE (C4) —
    // createTenantFixture's provisioned owner is INVITED, so this needs an
    // ACTIVE fixture rather than the shared `tenant`/`other`, which the rest
    // of this file uses for lower-level RLS/trigger tests that do not care
    // about status.
    const activeTenant = await createActiveUserFixture('RRC')
    const activeOther = await createActiveUserFixture('RRD')
    const mine = await login(activeTenant)

    // No runAs/withTenant here — this is exactly what the real /auth/refresh
    // handler does: no TenantContext exists yet when this is called.
    const outcome = await spendRefreshToken({
      presentedTokenHash: hashToken(mine.raw),
      newTokenHash: hashToken(randomUUID() + randomUUID()),
      deviceId: null,
    })

    expect(outcome.outcome).toBe('success')
    if (outcome.outcome !== 'success') throw new Error('unreachable')
    expect(outcome.tenant.id, 'must resolve to the OWNING tenant').toBe(activeTenant.tenantId)
    expect(outcome.tenant.id, 'must never resolve to the neighbour').not.toBe(activeOther.tenantId)
    expect(outcome.sessionId).toBe(mine.sessionId)

    // And the neighbour's own chain is untouched by this call — the
    // resolver never even considered the neighbour's rows.
    const otherFamilyStillLive = await runAs(
      { tenantId: activeOther.tenantId, userId: activeOther.ownerId },
      () =>
        withTenant((tx) =>
          scalarOn<Date | null>(
            tx,
            `SELECT revoked_at FROM refresh_token_families WHERE tenant_id = $1`,
            [activeOther.tenantId],
          ),
        ),
    )
    expect(otherFamilyStillLive ?? null).toBeNull()
  })

  it('spendRefreshToken cannot be steered into a different tenant by an ambient TenantContext', async () => {
    // Defence in depth: even if some future caller mistakenly wrapped this
    // in runAs({tenantId: other...}) — the shape a copy-pasted repository
    // call might take — the resolver's own answer must still win, because
    // withResolvedTenant sets app.tenant_id from the resolver's return
    // value alone, never from whatever ambient TenantContext (if any)
    // happens to be active.
    const activeTenant = await createActiveUserFixture('RRE')
    const activeOther = await createActiveUserFixture('RRF')
    const mine = await login(activeTenant)

    const outcome = await runAs(
      { tenantId: activeOther.tenantId, userId: activeOther.ownerId },
      () =>
        spendRefreshToken({
          presentedTokenHash: hashToken(mine.raw),
          newTokenHash: hashToken(randomUUID() + randomUUID()),
          deviceId: null,
        }),
    )

    expect(outcome.outcome).toBe('success')
    if (outcome.outcome !== 'success') throw new Error('unreachable')
    expect(outcome.tenant.id).toBe(activeTenant.tenantId)
  })

  it('cannot plant a row under another tenant’s id', async () => {
    const error = await runAs({ tenantId: other.tenantId, userId: other.ownerId }, () =>
      withTenant(async (tx) =>
        rawOn(
          tx,
          /*
           * `session_correlation_id` is deliberately NOT named here. Naming
           * it would raise 42501 from the column-scoped INSERT grant, and
           * this test would then pass for entirely the wrong reason — the
           * WITH CHECK policy it exists to prove would never be reached.
           */
          `INSERT INTO sessions (tenant_id, user_id, created_by, updated_by)
           VALUES ($1, $2, $2, $2)`,
          [tenant.tenantId, other.ownerId],
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      ),
    )

    expect(error, 'WITH CHECK, not merely USING').not.toBeNull()
    // 42501 insufficient_privilege is what a WITH CHECK violation raises.
    expect(sqlstate(error)).toBe('42501')
  })
})

/* ------------------------------------------------------------------ *
 * The grant posture
 * ------------------------------------------------------------------ */

describe('what finsoft_app may write', () => {
  /*
   * These ask PostgreSQL the effective question — "may this role do this" —
   * rather than reading GRANT statements back out of the catalog.
   *
   * THE DISTINCTION IS NOT ACADEMIC. Migration 004 shipped a column-scoped
   * UPDATE grant that was entirely decorative, because `ALTER DEFAULT
   * PRIVILEGES` had already granted TABLE-level UPDATE at CREATE TABLE and a
   * table-level grant supersedes a column list. Every column looked correctly
   * granted; every other column was writable too. `has_table_privilege`
   * returns false only if the REVOKE actually ran.
   */
  const may = (role: string, table: string, priv: string): Promise<boolean | undefined> =>
    runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        scalarOn<boolean>(tx, `SELECT has_table_privilege($1, $2, $3)`, [role, table, priv]),
      ),
    )

  const mayColumn = (
    role: string,
    table: string,
    column: string,
    priv: string,
  ): Promise<boolean | undefined> =>
    runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        scalarOn<boolean>(tx, `SELECT has_column_privilege($1, $2, $3, $4)`, [
          role,
          table,
          column,
          priv,
        ]),
      ),
    )

  for (const table of ['sessions', 'refresh_token_families', 'refresh_tokens']) {
    it(`holds no table-wide UPDATE on ${table}`, async () => {
      expect(await may('finsoft_app', table, 'UPDATE')).toBe(false)
    })

    it(`holds no DELETE on ${table}`, async () => {
      // Rule 4. A revoked session is evidence that a session existed.
      expect(await may('finsoft_app', table, 'DELETE')).toBe(false)
    })
  }

  it('cannot move a session to another tenant or another user', async () => {
    expect(await mayColumn('finsoft_app', 'sessions', 'tenant_id', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'sessions', 'user_id', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'sessions', 'created_by', 'UPDATE')).toBe(false)
  })

  it('cannot rewrite a token’s identity, only spend it', async () => {
    expect(await mayColumn('finsoft_app', 'refresh_tokens', 'token_hash', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'refresh_tokens', 'family_id', 'UPDATE')).toBe(false)
    expect(await mayColumn('finsoft_app', 'refresh_tokens', 'expires_at', 'UPDATE')).toBe(false)

    expect(await mayColumn('finsoft_app', 'refresh_tokens', 'used_at', 'UPDATE')).toBe(true)
    expect(await mayColumn('finsoft_app', 'refresh_tokens', 'replaced_by', 'UPDATE')).toBe(true)
  })

  it('cannot re-date a session correlation id after the fact', async () => {
    // It appears in logs. A mutable one would let an actor rewrite the join
    // key between a trace and the session it belongs to.
    expect(await mayColumn('finsoft_app', 'sessions', 'session_correlation_id', 'UPDATE')).toBe(
      false,
    )
  })

  it('does not expose token hashes to readonly_support', async () => {
    expect(await may('readonly_support', 'sessions', 'SELECT')).toBe(true)
    expect(await may('readonly_support', 'refresh_token_families', 'SELECT')).toBe(true)
    expect(
      await may('readonly_support', 'refresh_tokens', 'SELECT'),
      'a support role gains nothing from token hashes and widens the blast radius of holding them',
    ).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * Transition enforcement
 *
 * THE TESTS FOR THE HALF THE FIRST DRAFT OMITTED.
 *
 * Every assertion here failed — that is, the forbidden write SUCCEEDED —
 * against the draft that shipped column grants without transition triggers.
 * The draft's header claimed "the single-use claim is enforced by the
 * database, not by the application"; measured as `finsoft_app` under RLS, a
 * token could be spent, rewound to NULL and spent again, and a revoked
 * session could be un-revoked.
 *
 * A column grant bounds WHICH columns application code may write. Only a
 * trigger bounds which DIRECTION. These prove the second half exists.
 * ------------------------------------------------------------------ */

/** Run a statement and return the SQLSTATE it raised, or null if it succeeded. */
async function sqlstateOf(
  fixture: TenantFixture,
  text: string,
  parameters: readonly unknown[] = [],
): Promise<string | undefined | null> {
  return runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
    withTenant((tx) => rawOn(tx, text, parameters)).then(
      () => null,
      (e: unknown) => sqlstate(e),
    ),
  )
}

describe('spending a token is terminal', () => {
  it('cannot rewind used_at to NULL', async () => {
    const chain = await login(tenant)
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) => spend(tx, hashToken(chain.raw), tenant.ownerId)),
    )

    const state = await sqlstateOf(
      tenant,
      `UPDATE refresh_tokens SET used_at = NULL, version = version + 1 WHERE id = $1`,
      [chain.tokenId],
    )
    expect(state, 'this UPDATE succeeded before the transition trigger existed').toBe('23514')
  })

  it('cannot re-date used_at', async () => {
    const chain = await login(tenant)
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) => spend(tx, hashToken(chain.raw), tenant.ownerId)),
    )

    const state = await sqlstateOf(
      tenant,
      `UPDATE refresh_tokens SET used_at = now() + interval '1 hour', version = version + 1 WHERE id = $1`,
      [chain.tokenId],
    )
    expect(state).toBe('23514')
  })

  it('cannot spend an expired token', async () => {
    const chain = await login(tenant)
    const expiredHash = hashToken(randomUUID() + randomUUID())

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn(
          tx,
          `INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, issued_at, expires_at, created_by, updated_by)
           VALUES ($1, $2, $3, now() - interval '19 days', now() - interval '6 days', $4, $4)`,
          [tenant.tenantId, chain.familyId, expiredHash, tenant.ownerId],
        ),
      ),
    )

    const spent = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) => spend(tx, expiredHash, tenant.ownerId)),
    )
    expect(spent, 'the fence predicate carries `expires_at > now()`').toEqual([])
  })

  it('cannot rewrite replaced_by once set', async () => {
    const chain = await login(tenant)
    const successor = await login(tenant)

    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        await spend(tx, hashToken(chain.raw), tenant.ownerId)
        await rawOn(
          tx,
          `UPDATE refresh_tokens SET replaced_by = $1, version = version + 1 WHERE id = $2`,
          [successor.tokenId, chain.tokenId],
        )
      }),
    )

    const state = await sqlstateOf(
      tenant,
      `UPDATE refresh_tokens SET replaced_by = NULL, version = version + 1 WHERE id = $1`,
      [chain.tokenId],
    )
    expect(state).toBe('23514')
  })
})

describe('revocation is terminal and effective', () => {
  const revokeSession = (fixture: TenantFixture, id: string): Promise<unknown> =>
    runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
      withTenant((tx) =>
        rawOn(
          tx,
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'admin terminated',
                  status = 'REVOKED', version = version + 1
            WHERE id = $1`,
          [id],
        ),
      ),
    )

  const revokeFamily = (fixture: TenantFixture, id: string): Promise<unknown> =>
    runAs({ tenantId: fixture.tenantId, userId: fixture.ownerId }, () =>
      withTenant((tx) =>
        rawOn(
          tx,
          `UPDATE refresh_token_families SET revoked_at = now(),
                  revoked_reason = 'refresh token reuse detected', version = version + 1
            WHERE id = $1`,
          [id],
        ),
      ),
    )

  it('a revoked session cannot be un-revoked', async () => {
    const chain = await login(tenant)
    await revokeSession(tenant, chain.sessionId)

    const state = await sqlstateOf(
      tenant,
      `UPDATE sessions SET revoked_at = NULL, revoked_reason = NULL, status = 'ACTIVE',
              version = version + 1
        WHERE id = $1`,
      [chain.sessionId],
    )
    expect(
      state,
      'ADR-0009 calls revocation the whole reason sessions are a table; undoing it restores access an administrator removed',
    ).toBe('23514')
  })

  it('a revoked family cannot be un-revoked', async () => {
    const chain = await login(tenant)
    await revokeFamily(tenant, chain.familyId)

    const state = await sqlstateOf(
      tenant,
      `UPDATE refresh_token_families SET revoked_at = NULL, revoked_reason = NULL,
              version = version + 1
        WHERE id = $1`,
      [chain.familyId],
    )
    expect(state).toBe('23514')
  })

  it('no new token may be issued into a revoked family', async () => {
    const chain = await login(tenant)
    await revokeFamily(tenant, chain.familyId)

    const state = await sqlstateOf(
      tenant,
      `INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, expires_at, created_by, updated_by)
       VALUES ($1, $2, $3, now() + interval '13 days', $4, $4)`,
      [tenant.tenantId, chain.familyId, hashToken(randomUUID() + randomUUID()), tenant.ownerId],
    )
    expect(state, 'otherwise the revocation is real in the audit trail and void in practice').toBe(
      '23514',
    )
  })

  it('a token in a revoked family cannot be spent', async () => {
    /*
     * Reuse detection revokes the family. It did NOT stop the family's other
     * tokens spending: measured, an unspent sibling still returned rowcount
     * 1, which the migration header decodes as "this caller won the race and
     * may rotate". Reuse detection implies an unspent sibling exists — that
     * is what makes it reuse — so this was the live case.
     */
    const chain = await login(tenant)
    await revokeFamily(tenant, chain.familyId)

    const state = await sqlstateOf(
      tenant,
      `UPDATE refresh_tokens
          SET used_at = now(), updated_by = created_by, version = version + 1
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hashToken(chain.raw)],
    )
    expect(state, 'revocation must be effective, not merely recorded').toBe('23514')
  })

  it('revoking a session cascades to its families', async () => {
    // Without the cascade, terminating a session revoked nothing: the family
    // stayed live, its token spent, and a new token was appended to the same
    // family. The chain kept rotating after an administrator had ended it.
    const chain = await login(tenant)
    await revokeSession(tenant, chain.sessionId)

    const revoked = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        scalarOn<Date | null>(tx, `SELECT revoked_at FROM refresh_token_families WHERE id = $1`, [
          chain.familyId,
        ]),
      ),
    )
    expect(revoked, 'the session trigger must revoke its live families').not.toBeNull()
  })

  it('a token under a revoked session cannot be spent', async () => {
    const chain = await login(tenant)
    await revokeSession(tenant, chain.sessionId)

    const state = await sqlstateOf(
      tenant,
      `UPDATE refresh_tokens
          SET used_at = now(), updated_by = created_by, version = version + 1
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hashToken(chain.raw)],
    )
    expect(
      state,
      'this is the end-to-end property: admin terminates a session, the chain stops rotating',
    ).toBe('23514')
  })

  it('no new family may be opened under a revoked session', async () => {
    const chain = await login(tenant)
    await revokeSession(tenant, chain.sessionId)

    const state = await sqlstateOf(
      tenant,
      `INSERT INTO refresh_token_families (tenant_id, session_id, created_by, updated_by)
       VALUES ($1, $2, $3, $3)`,
      [tenant.tenantId, chain.sessionId, tenant.ownerId],
    )
    expect(state).toBe('23514')
  })
})

describe('monotonic columns', () => {
  it('version cannot be rolled backward', async () => {
    const chain = await login(tenant)
    const state = await sqlstateOf(
      tenant,
      `UPDATE sessions SET last_seen_at = now(), version = 0 WHERE id = $1`,
      [chain.sessionId],
    )
    expect(state, 'an optimistic lock that can be wound back is not a lock').toBe('23514')
  })

  it('mfa_at cannot be back-dated', async () => {
    const chain = await login(tenant)
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn(tx, `UPDATE sessions SET mfa_at = now(), version = version + 1 WHERE id = $1`, [
          chain.sessionId,
        ]),
      ),
    )

    const state = await sqlstateOf(
      tenant,
      `UPDATE sessions SET mfa_at = now() - interval '1 day', version = version + 1 WHERE id = $1`,
      [chain.sessionId],
    )
    expect(
      state,
      'step-up freshness gates period.reopen and role changes; back-dating it forges recency',
    ).toBe('23514')
  })

  it('permission_version cannot move backward', async () => {
    // ADR-0009:102 — a token behind this version is refused at the guard, so
    // winding it back would restore a privilege level that was withdrawn.
    const chain = await login(tenant)
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        rawOn(
          tx,
          `UPDATE sessions SET permission_version = 3, version = version + 1 WHERE id = $1`,
          [chain.sessionId],
        ),
      ),
    )

    const state = await sqlstateOf(
      tenant,
      `UPDATE sessions SET permission_version = 1, version = version + 1 WHERE id = $1`,
      [chain.sessionId],
    )
    expect(state).toBe('23514')
  })

  it('last_seen_at cannot move backward', async () => {
    const chain = await login(tenant)
    const state = await sqlstateOf(
      tenant,
      `UPDATE sessions SET last_seen_at = now() - interval '1 day', version = version + 1 WHERE id = $1`,
      [chain.sessionId],
    )
    expect(state).toBe('23514')
  })
})

/* ------------------------------------------------------------------ *
 * The CHECK constraints
 *
 * These were verified by hand during review and existed in no test, so
 * nothing would have failed if a later migration dropped one. Hand
 * verification is not a gate.
 * ------------------------------------------------------------------ */
describe('constraints', () => {
  it('mints session_correlation_id from the column DEFAULT', async () => {
    const chain = await login(tenant)
    // `login()` does not supply one. Entropy is a schema fact here, not an
    // application promise — which is the difference between this column and
    // refresh_tokens.token_hash, whose raw value the database must never see.
    expect(chain.scid).toMatch(/^scid_[0-9a-f]{32}$/)
  })

  it('will not let the application name session_correlation_id at all', async () => {
    /*
     * This asserted `23514` — the CHECK — until the column-scoped INSERT
     * grant landed. The CHECK is still there and still guards the migration
     * role, but `finsoft_app` no longer reaches it: it cannot name the
     * column, so the DEFAULT is the only way a value can arrive.
     *
     * That is the whole point of the grant. A DEFAULT is overridable by any
     * caller that names the column; measured before the grant,
     * `scid_deadbeefdeadbeefdeadbeefdeadbeef` was accepted with zero entropy
     * and the CHECK satisfied.
     */
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO sessions (tenant_id, user_id, session_correlation_id, created_by, updated_by)
         VALUES ($1, $2, $3, $2, $2)`,
        [tenant.tenantId, tenant.ownerId, 'scid_deadbeefdeadbeefdeadbeefdeadbeef'],
      ),
      'insufficient_privilege — the column is not in the INSERT grant',
    ).toBe('42501')
  })

  it('will not let the application choose a session id', async () => {
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO sessions (id, tenant_id, user_id, created_by, updated_by)
         VALUES ($1, $2, $3, $3, $3)`,
        ['00000000-0000-4000-8000-000000000001', tenant.tenantId, tenant.ownerId],
      ),
    ).toBe('42501')
  })

  it('will not let the application set created_at', async () => {
    // Rule 13: the server's clock sets it, never the caller's.
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO sessions (tenant_id, user_id, created_at, created_by, updated_by)
         VALUES ($1, $2, now() - interval '1 year', $2, $2)`,
        [tenant.tenantId, tenant.ownerId],
      ),
    ).toBe('42501')
  })

  it('will not let a session be born revoked', async () => {
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO sessions (tenant_id, user_id, revoked_at, revoked_reason, status, created_by, updated_by)
         VALUES ($1, $2, now(), 'forged', 'REVOKED', $2, $2)`,
        [tenant.tenantId, tenant.ownerId],
      ),
    ).toBe('42501')
  })

  it('refuses a future-dated issued_at', async () => {
    /*
     * `rt_lifetime_ceiling` is measured from `issued_at`, so on its own it
     * stops nothing: measured before the trigger,
     * `issued_at = now() + 350 days, expires_at = now() + 364 days` was
     * ACCEPTED — a 364-day refresh credential — and the test named
     * "refuses a token that outlives ADR-0009's ceiling" passed green over it.
     */
    const chain = await login(tenant)
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, issued_at, expires_at, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '350 days', now() + interval '364 days', $4, $4)`,
        [tenant.tenantId, chain.familyId, hashToken(randomUUID()), tenant.ownerId],
      ),
      'the ceiling and the clock anchor are one control; neither works alone',
    ).toBe('23514')
  })

  it('keeps status and revoked_at in step', async () => {
    const chain = await login(tenant)
    expect(
      await sqlstateOf(
        tenant,
        `UPDATE sessions SET status = 'REVOKED', version = version + 1 WHERE id = $1`,
        [chain.sessionId],
      ),
      'REVOKED without a revoked_at would let the guard and the record disagree',
    ).toBe('23514')
  })

  it('refuses a revocation with no reason', async () => {
    const chain = await login(tenant)
    expect(
      await sqlstateOf(
        tenant,
        `UPDATE sessions SET revoked_at = now(), status = 'REVOKED', version = version + 1 WHERE id = $1`,
        [chain.sessionId],
      ),
    ).toBe('23514')
  })

  it('refuses an uppercase token hash', async () => {
    const chain = await login(tenant)
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, expires_at, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '13 days', $4, $4)`,
        [tenant.tenantId, chain.familyId, 'A'.repeat(64), tenant.ownerId],
      ),
    ).toBe('23514')
  })

  it('refuses a token that expires before it is issued', async () => {
    const chain = await login(tenant)
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, issued_at, expires_at, created_by, updated_by)
         VALUES ($1, $2, $3, now(), now() - interval '1 second', $4, $4)`,
        [tenant.tenantId, chain.familyId, hashToken(randomUUID()), tenant.ownerId],
      ),
    ).toBe('23514')
  })

  it('refuses a token that outlives ADR-0009’s ceiling', async () => {
    const chain = await login(tenant)
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, expires_at, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '30 days', $4, $4)`,
        [tenant.tenantId, chain.familyId, hashToken(randomUUID()), tenant.ownerId],
      ),
      'a fixture minting 30-day tokens is how a 14-day spec quietly becomes a 30-day one',
    ).toBe('23514')
  })

  it('refuses replaced_by on an unspent token', async () => {
    const chain = await login(tenant)
    const other = await login(tenant)
    expect(
      await sqlstateOf(
        tenant,
        `UPDATE refresh_tokens SET replaced_by = $1, version = version + 1 WHERE id = $2`,
        [other.tokenId, chain.tokenId],
      ),
    ).toBe('23514')
  })

  it('refuses a token that replaces itself', async () => {
    const chain = await login(tenant)
    expect(
      await sqlstateOf(
        tenant,
        `UPDATE refresh_tokens SET used_at = now(), replaced_by = id, version = version + 1 WHERE id = $1`,
        [chain.tokenId],
      ),
    ).toBe('23514')
  })

  it('refuses a duplicate token hash', async () => {
    const chain = await login(tenant)
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, expires_at, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '13 days', $4, $4)`,
        [tenant.tenantId, chain.familyId, hashToken(chain.raw), tenant.ownerId],
      ),
    ).toBe('23505')
  })

  it('refuses a session whose subject belongs to another tenant', async () => {
    expect(
      await sqlstateOf(
        tenant,
        `INSERT INTO sessions (tenant_id, user_id, created_by, updated_by)
         VALUES ($1, $2, $3, $3)`,
        [tenant.tenantId, other.ownerId, tenant.ownerId],
      ),
      'a single-column REFERENCES users(id) is checked with row security OFF and would accept this',
    ).toBe('23503')
  })
})
