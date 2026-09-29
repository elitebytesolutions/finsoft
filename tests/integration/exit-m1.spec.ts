import { randomUUID } from 'node:crypto'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Redis } from 'ioredis'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'kysely'
import { ACCESS_TOKEN_TTL_SECONDS, hashRefreshToken } from '@finsoft/auth'
import { listAuditEvents, withGlobal, withTenant } from '@finsoft/database'
import { prepareTestDatabase, runAs, teardownTestDatabase, unique } from '@finsoft/database/testing'
import { seedSystemRoles } from '@finsoft/permissions'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { createActiveUserFixture, type ActiveUserFixture } from './helpers/auth-seed.ts'

/*
 * docs/WAVE_1_REGISTER.md, W1-006 · "The exit criterion" — M1-X.
 *
 * Through the REAL apps/api/src/app.module.ts (TenantGuard, PermissionGuard,
 * TenantContextInterceptor, RouteDecorationCheck — exactly the wiring
 * main.ts boots) and real logins, never a test-only auth stand-in.
 *
 * | # | criterion |
 * |---|---|
 * | 1 | Tenant A can read AND update its own record — authorised access succeeds |
 * | 2 | Tenant A cannot read/modify B's record via id/tenant-id in body/query/header/path |
 * | 3 | Missing, tampered, expired and revoked credentials are each rejected |
 * | 4 | The API connects as the restricted database role |
 * | 5 | Concurrent A/B requests stay isolated |
 *
 * Plus audit: logins appear in GET /api/audit for Owner, 403 for Viewer,
 * and tenant B's audit never shows A's rows.
 *
 * DECISION on criterion 2's "path" door: M1's real surface (auth + audit)
 * has no resource-by-path-id route — GET /api/audit takes filters as QUERY
 * parameters, not a path segment, and GET/PATCH /api/auth/me operate on
 * "self" from the verified token, with no id anywhere in the request at
 * all. The three doors that genuinely exist on this surface — header, body
 * and query — each get their own test below. A path-id door test belongs
 * with the first resource that has one (a customer or invoice endpoint,
 * M2/M3) and is recorded as OBSERVED in the delivery report rather than
 * faked here against a route that does not exist.
 */

interface Principal {
  readonly user: ActiveUserFixture
  readonly accessToken: string
  readonly refreshCookie: string
}

let app: INestApplication
let a: Principal
let aViewer: { readonly userId: string; readonly accessToken: string }
let b: Principal

const CSRF = { 'X-Requested-With': 'finsoft' }

function cookieHeaderFrom(res: request.Response): string {
  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  const rt = setCookies.find((c) => c.startsWith('finsoft_rt='))
  if (!rt) throw new Error('no finsoft_rt cookie in response')
  return rt.split(';')[0] ?? ''
}

async function loginAs(user: ActiveUserFixture): Promise<Principal> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ tenantCode: user.code, email: user.email, password: user.password })
  expect(res.status).toBe(200)
  return { user, accessToken: res.body.accessToken, refreshCookie: cookieHeaderFrom(res) }
}

async function seedOwnerAndViewer(label: string) {
  const owner = await createActiveUserFixture(label)

  const viewerId = await runAs({ tenantId: owner.tenantId, userId: owner.ownerId }, () =>
    withTenant(async (tx) => {
      await seedSystemRoles(tx, owner.tenantId)

      const ownerRole = await tx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', owner.tenantId)
        .where('code', '=', 'owner')
        .executeTakeFirstOrThrow()
      await tx
        .insertInto('user_roles')
        .values({
          tenant_id: owner.tenantId,
          user_id: owner.ownerId,
          role_id: ownerRole.id,
          created_by: owner.ownerId,
          updated_by: owner.ownerId,
        })
        .execute()

      const viewerRole = await tx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', owner.tenantId)
        .where('code', '=', 'viewer')
        .executeTakeFirstOrThrow()

      const viewer = await tx
        .insertInto('users')
        .values({
          tenant_id: owner.tenantId,
          email: `viewer.${unique()}@example.test`,
          full_name: 'Viewer User',
          status: 'ACTIVE',
          password_hash: owner.tenantId, // placeholder overwritten below via real hash
          created_by: owner.ownerId,
          updated_by: owner.ownerId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      await tx
        .insertInto('user_roles')
        .values({
          tenant_id: owner.tenantId,
          user_id: viewer.id,
          role_id: viewerRole.id,
          created_by: owner.ownerId,
          updated_by: owner.ownerId,
        })
        .execute()

      return viewer.id
    }),
  )

  return { owner, viewerId }
}

beforeAll(async () => {
  await prepareTestDatabase()
  process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL']
  const flusher = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379')
  await flusher.flushdb()
  await flusher.quit()

  resetLoggerForTests()
  initLogger({ service: 'exit-m1-test', level: 'fatal' })

  const { AppModule } = await import('../../apps/api/src/app.module.ts')
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new AllExceptionsFilter())
  await app.init()
  // Criterion 5 fires 20 concurrent requests at the same underlying HTTP
  // server; supertest attaches a listener per request, past Node's default
  // cap of 10. Benign, but noisy in CI output otherwise.
  app.getHttpServer().setMaxListeners(30)

  const seedA = await seedOwnerAndViewer('X1A')
  const seedB = await seedOwnerAndViewer('X1B')

  // The viewer fixture above needed a REAL password hash, not a placeholder —
  // set via the ordinary app-role grant, same shape createActiveUserFixture
  // uses for the owner.
  const { hashPassword } = await import('@finsoft/auth')
  const viewerPasswordHash = await hashPassword('Viewer-Correct-Horse-1')
  await runAs({ tenantId: seedA.owner.tenantId, userId: seedA.owner.ownerId }, () =>
    withTenant((tx) =>
      tx
        .updateTable('users')
        .set({
          password_hash: viewerPasswordHash,
          updated_by: seedA.owner.ownerId,
          version: sql`version + 1`,
        })
        .where('id', '=', seedA.viewerId)
        .execute(),
    ),
  )

  a = await loginAs(seedA.owner)
  b = await loginAs(seedB.owner)

  const viewerLogin = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({
      tenantCode: seedA.owner.code,
      email: (
        await runAs({ tenantId: seedA.owner.tenantId, userId: seedA.owner.ownerId }, () =>
          withTenant((tx) =>
            tx
              .selectFrom('users')
              .select('email')
              .where('id', '=', seedA.viewerId)
              .executeTakeFirstOrThrow(),
          ),
        )
      ).email,
      password: 'Viewer-Correct-Horse-1',
    })
  expect(viewerLogin.status).toBe(200)
  aViewer = { userId: seedA.viewerId, accessToken: viewerLogin.body.accessToken }
}, 120_000)

afterAll(async () => {
  await app?.close()
  resetLoggerForTests()
  await teardownTestDatabase()
})

describe('W1-006 criterion 1: authorised access succeeds (A reads and updates its own record)', () => {
  it('GET /api/auth/me returns A’s own profile', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${a.accessToken}`)
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(a.user.ownerId)
    expect(res.body.tenant.id).toBe(a.user.tenantId)
  })

  it('PATCH /api/auth/me updates A’s own record, and the read reflects it', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${a.accessToken}`)

    const patch = await request(app.getHttpServer())
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ fullName: 'Renamed Owner A', version: before.body.user.version })
    expect(patch.status).toBe(200)
    expect(patch.body.fullName).toBe('Renamed Owner A')
    expect(patch.body.id).toBe(a.user.ownerId)
    expect(patch.body.version).toBe(before.body.user.version + 1)

    const read = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${a.accessToken}`)
    expect(read.body.user.fullName).toBe('Renamed Owner A')
  })

  describe('M1-X, Council DB C3: optimistic concurrency', () => {
    it('a stale/wrong version is rejected with 409 and writes NO audit row', async () => {
      const before = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${a.accessToken}`)
      const wrongVersion = before.body.user.version + 999

      const auditBefore = await runAs({ tenantId: a.user.tenantId, userId: a.user.ownerId }, () =>
        withTenant((tx) => listAuditEvents(tx, { action: 'USER_PROFILE_UPDATED', limit: 200 })),
      )

      const res = await request(app.getHttpServer())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ fullName: 'Should Not Apply', version: wrongVersion })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('version_conflict')

      const auditAfter = await runAs({ tenantId: a.user.tenantId, userId: a.user.ownerId }, () =>
        withTenant((tx) => listAuditEvents(tx, { action: 'USER_PROFILE_UPDATED', limit: 200 })),
      )
      expect(auditAfter.items.length).toBe(auditBefore.items.length)

      const readAfter = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${a.accessToken}`)
      expect(readAfter.body.user.fullName).not.toBe('Should Not Apply')
    })

    it('audit before_json/after_json reflect the actual old and new fullName', async () => {
      const before = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${a.accessToken}`)
      const oldName = before.body.user.fullName as string
      const newName = `Audited Name ${unique()}`

      await request(app.getHttpServer())
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ fullName: newName, version: before.body.user.version })
        .expect(200)

      const events = await runAs({ tenantId: a.user.tenantId, userId: a.user.ownerId }, () =>
        withTenant((tx) => listAuditEvents(tx, { action: 'USER_PROFILE_UPDATED', limit: 200 })),
      )
      // Newest first (listAuditEvents orders by seq DESC).
      const latest = events.items[0]
      expect(latest?.beforeJson).toEqual({ fullName: oldName })
      expect(latest?.afterJson).toEqual({ fullName: newName })
    })
  })
})

describe('W1-006 criterion 2: A cannot reach B by id/tenant-id, each door tested separately', () => {
  it('header door: X-Tenant-Id: B has no effect — A still sees only A', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .set('X-Tenant-Id', b.user.tenantId)
    expect(res.status).toBe(200)
    expect(res.body.tenant.id).toBe(a.user.tenantId)
    expect(res.body.tenant.id).not.toBe(b.user.tenantId)
  })

  it('body door: an undeclared tenantId/userId in the PATCH body has no effect', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${a.accessToken}`)

    const res = await request(app.getHttpServer())
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({
        fullName: 'Still A',
        version: before.body.user.version,
        tenantId: b.user.tenantId,
        userId: b.user.ownerId,
      })
    expect(res.status).toBe(200)
    // The update landed on A's own row, never B's — never accepts an id from the body at all.
    expect(res.body.id).toBe(a.user.ownerId)

    const bProfile = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${b.accessToken}`)
    expect(bProfile.body.user.fullName).not.toBe('Still A')
  })

  it('query door: GET /api/audit?actor=<B’s id> and ?tenant_id=<B> return none of B’s rows', async () => {
    const byActor = await request(app.getHttpServer())
      .get('/api/audit')
      .query({ actor: b.user.ownerId })
      .set('Authorization', `Bearer ${a.accessToken}`)
    expect(byActor.status).toBe(200)
    expect(byActor.body.items).toEqual([])

    const byTenantId = await request(app.getHttpServer())
      .get('/api/audit')
      .query({ tenant_id: b.user.tenantId })
      .set('Authorization', `Bearer ${a.accessToken}`)
    expect(byTenantId.status).toBe(200)
    // tenant_id is not a declared field of the query schema and is stripped;
    // the response is still exactly A's own tenant's events (which include
    // A's own Viewer user, seeded alongside A's Owner — never filtered by
    // the supplied tenant_id, and never B's actor either way).
    expect(
      byTenantId.body.items.every(
        (item: { actorUserId: string | null }) => item.actorUserId !== b.user.ownerId,
      ),
    ).toBe(true)
  })

  /*
   * M1-X, Council DB C2/Sec 4: the PATCH /me calls above (and in criterion 1)
   * bump A's users.version each time they succeed — the same coarse counter
   * the guard treats as the permission version (see
   * tests/integration/account-state-guard.spec.ts's own note, and the TD
   * entry in docs/TECH_DEBT.md). Every criterion BELOW this point reuses
   * `a.accessToken` freely; without re-minting it here, those assertions
   * would only keep passing for as long as the account-state cache's 15s
   * TTL happens to still be serving the snapshot an earlier GET populated —
   * a suite that happened to finish fast enough, not a suite whose later
   * cases are actually independent of cache timing. Re-logging in mints a
   * token whose OWN claimed version already matches (or exceeds) current,
   * so nothing below depends on the cache at all.
   */
  afterAll(async () => {
    a = await loginAs(a.user)
  })
})

describe('W1-006 criterion 3: missing, tampered, expired and revoked credentials are each rejected', () => {
  it('missing: no Authorization header at all', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  it('tampered: a modified payload no longer matches its signature', async () => {
    const [header, payload, signature] = a.accessToken.split('.')
    const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'))
    decoded.sub = b.user.ownerId // attempt to become B, from A's own token
    const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url')
    const forged = `${header}.${tamperedPayload}.${signature}`

    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`)
    expect(res.status).toBe(401)
  })

  it('expired: a refresh token past its expires_at is rejected, cookie or not', async () => {
    // refresh_tokens_enforce_transition (migration 005) makes an EXISTING
    // row's expires_at immutable — "a token identity is immutable; it may
    // only be spent" — so an expired token cannot be produced by backdating
    // a real one. This INSERTS a fresh row already past its expiry, on a
    // real family from a real login, exactly the shape
    // tests/integration/refresh-rotation.spec.ts's "cannot spend an expired
    // token" case uses.
    const login = await loginAs(a.user)
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
    const sessionId = me.body.sessionId as string

    const family = await runAs({ tenantId: a.user.tenantId, userId: a.user.ownerId }, () =>
      withTenant((tx) =>
        tx
          .selectFrom('refresh_token_families')
          .select('id')
          .where('session_id', '=', sessionId)
          .executeTakeFirstOrThrow(),
      ),
    )

    const expiredRaw = randomUUID() + randomUUID()
    const expiredHash = hashRefreshToken(expiredRaw)

    await runAs({ tenantId: a.user.tenantId, userId: a.user.ownerId }, () =>
      withTenant((tx) =>
        sql`
          INSERT INTO refresh_tokens (tenant_id, family_id, token_hash, issued_at, expires_at, created_by, updated_by)
          VALUES (${a.user.tenantId}, ${family.id}, ${expiredHash}, now() - interval '19 days', now() - interval '6 days', ${a.user.ownerId}, ${a.user.ownerId})
        `.execute(tx),
      ),
    )

    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', `finsoft_rt=${expiredRaw}`)
      .set(CSRF)
      .send()
    expect(res.status).toBe(401)
  })

  it('revoked: a refresh token from a logged-out session is rejected', async () => {
    const login = await loginAs(a.user)
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .set(CSRF)
      .send()

    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', login.refreshCookie)
      .set(CSRF)
      .send()
    expect(res.status).toBe(401)
  })

  /*
   * M1-X, Council re-review exit-suite addition: the "expired" case above
   * (refresh_tokens_enforce_transition, migration 005) proves a REFRESH
   * token's own expiry is enforced. It says nothing about an ACCESS token's
   * `exp` claim — verified independently, by `jose`, inside
   * `verifyAccessToken` (packages/auth/src/jwt.ts), against a bearer token
   * on every request. This proves that path too, through the real HTTP
   * surface rather than by calling `verifyAccessToken` directly.
   *
   * `vi.useFakeTimers({ toFake: ['Date'] })` fakes only `Date`/`Date.now()`
   * — not `setTimeout`/`setImmediate`/timers — so the real event loop, the
   * real Postgres/Redis clients this request still touches on its way to
   * (correctly) failing early, and every OTHER concurrently-running test's
   * async work keep ticking on the real clock. Only `jose`'s own
   * `exp`-vs-"now" comparison (which reads `new Date()`) sees the future.
   */
  it('expired: an access token past its own exp claim is rejected', async () => {
    // A dedicated user, not `a.user`: `login:ip-email` (packages/auth's
    // throttle) is keyed on (ip, email) with a limit of 5 per 5 minutes, and
    // `a.user` already spends several of that budget elsewhere in this
    // file. A fresh identity keeps this test's login independent of how
    // many other tests around it happen to log the same principal in.
    const dedicated = await createActiveUserFixture('X1EXP')
    const login = await loginAs(dedicated)
    const realNow = Date.now()

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(realNow + (ACCESS_TOKEN_TTL_SECONDS + 60) * 1000)

      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${login.accessToken}`)
      expect(res.status).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })

  /*
   * M1-X, Council re-review exit-suite addition: logout must reject the OLD
   * access token IMMEDIATELY, not merely once the session-active cache's
   * 15s TTL (packages/auth/src/session-cache.ts) happens to expire on its
   * own. `logout()` calls `invalidateSessionCache` before returning, so
   * this makes the very next request with no artificial delay — proving the
   * flush, not just eventual consistency with a cache that would have
   * expired anyway by the time a slower test got around to asserting it.
   */
  it('logged out: an access token from a logged-out session is rejected immediately, not just eventually', async () => {
    // Same reasoning as the expired-access-token test above: a dedicated
    // user keeps this test's one login off `a.user`'s shared throttle
    // budget.
    const dedicated = await createActiveUserFixture('X1OUT')
    const login = await loginAs(dedicated)

    const before = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
    expect(before.status).toBe(200) // sanity: the token works before logout

    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .set(CSRF)
      .send()

    const after = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
    expect(after.status).toBe(401)
  })
})

describe('W1-006 criterion 4: the API connects as the restricted database role', () => {
  it('current_user is finsoft_app and it does not hold BYPASSRLS', async () => {
    const row = await withGlobal((tx) =>
      sql<{ current_user: string; rolbypassrls: boolean; rolsuper: boolean }>`
        SELECT current_user, r.rolbypassrls, r.rolsuper
        FROM pg_roles r WHERE r.rolname = current_user
      `.execute(tx),
    )
    const first = row.rows[0]
    expect(first?.current_user).toBe('finsoft_app')
    expect(first?.rolbypassrls).toBe(false)
    expect(first?.rolsuper).toBe(false)
  })
})

describe('W1-006 criterion 5: concurrent A/B requests stay isolated', () => {
  it('interleaved /me calls for A and B never cross-return the wrong tenant', async () => {
    const calls = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? request(app.getHttpServer())
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${a.accessToken}`)
            .then((res) => ({ expected: a.user.tenantId, got: res.body.tenant.id }))
        : request(app.getHttpServer())
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${b.accessToken}`)
            .then((res) => ({ expected: b.user.tenantId, got: res.body.tenant.id })),
    )

    const results = await Promise.all(calls)
    for (const { expected, got } of results) {
      expect(got).toBe(expected)
    }
  })
})

describe('W1-006 audit: Owner sees its own logins, Viewer is forbidden, B never sees A', () => {
  it('the Owner can list its own USER_SIGNED_IN events', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/audit')
      .query({ action: 'USER_SIGNED_IN' })
      .set('Authorization', `Bearer ${a.accessToken}`)
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBeGreaterThan(0)
    expect(res.body.items[0].actorUserId).toBe(a.user.ownerId)
  })

  it('a Viewer (no audit.view) is forbidden', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/audit')
      .set('Authorization', `Bearer ${aViewer.accessToken}`)
    expect(res.status).toBe(403)
  })

  it('tenant B’s audit view never shows any of A’s rows', async () => {
    const asB = await request(app.getHttpServer())
      .get('/api/audit')
      .set('Authorization', `Bearer ${b.accessToken}`)
    expect(asB.status).toBe(200)

    const aIds = (
      await runAs({ tenantId: a.user.tenantId, userId: a.user.ownerId }, () =>
        withTenant((tx) => listAuditEvents(tx, { limit: 200 })),
      )
    ).items.map((i) => i.id)

    const bVisibleIds = asB.body.items.map((i: { id: string }) => i.id)
    for (const id of aIds) {
      expect(bVisibleIds).not.toContain(id)
    }
  })
})
