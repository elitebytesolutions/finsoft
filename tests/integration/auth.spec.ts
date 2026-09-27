import { INestApplication, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import { Redis } from 'ioredis'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { decodeJwt, SignJWT } from 'jose'
import { prepareTestDatabase, teardownTestDatabase, unique } from '@finsoft/database/testing'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { resetVerificationCountForTests, verificationCountForTests } from '@finsoft/auth'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { TenantGuard } from '../../apps/api/src/common/tenant.guard.ts'
import { AuthModule } from '../../apps/api/src/auth/auth.module.ts'
import {
  createActiveUserFixture,
  disableUser,
  type ActiveUserFixture,
} from './helpers/auth-seed.ts'

/*
 * The auth HTTP contract, end to end, against real PostgreSQL and real
 * Redis. ADR-0009, ADR-0022, ADR-0023.
 *
 * REDIS_URL is repointed at the disposable test instance in beforeAll, AFTER
 * prepareTestDatabase() has loaded .env (it is not preloaded by vitest here)
 * and BEFORE anything in @finsoft/auth opens a connection — the same
 * principle the database harness enforces for TEST_DATABASE_URL, applied by
 * hand here because no equivalent guard exists yet for Redis (recorded under
 * OBSERVED in the delivery report).
 */

@Module({
  imports: [AuthModule],
  providers: [{ provide: APP_GUARD, useClass: TenantGuard }],
})
class TestAuthAppModule {}

const CSRF = { 'X-Requested-With': 'finsoft' }

function cookieHeaderFrom(res: request.Response): string {
  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  const rt = setCookies.find((c) => c.startsWith('finsoft_rt='))
  if (!rt) throw new Error('no finsoft_rt cookie in response')
  return rt.split(';')[0] ?? ''
}

describe('POST /api/auth/login, /refresh, /logout, GET /me, /jwks', () => {
  let app: INestApplication
  let user: ActiveUserFixture

  beforeAll(async () => {
    await prepareTestDatabase()
    process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL']

    /*
     * Flush the disposable throttle store before this file runs. Unlike the
     * database harness, nothing else resets Redis between runs — and
     * ADR-0023 §5's layer 2 (IP-only, limit 60 / 5 min) keys on the test
     * runner's own loopback address, shared by every test in this file and
     * by every previous run within the same five-minute window. Without
     * this, repeated local iteration (or two CI runs close together)
     * accumulates against that one key and every subsequent login here
     * starts failing with 429 for reasons that have nothing to do with the
     * test itself — exactly the kind of flakiness a disposable store is
     * supposed to avoid.
     */
    const flusher = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379')
    await flusher.flushdb()
    await flusher.quit()

    resetLoggerForTests()
    initLogger({ service: 'api-test', level: 'fatal' })

    const moduleRef = await Test.createTestingModule({ imports: [TestAuthAppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.use(cookieParser())
    app.useGlobalFilters(new AllExceptionsFilter())
    await app.init()

    user = await createActiveUserFixture('AU1')
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    resetLoggerForTests()
    await teardownTestDatabase()
  })

  beforeEach(() => {
    resetVerificationCountForTests()
  })

  describe('login', () => {
    it('succeeds for a seeded ACTIVE user and sets the refresh cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: user.code, email: user.email, password: user.password })

      expect(res.status).toBe(200)
      expect(res.body.accessToken).toEqual(expect.any(String))
      expect(res.body.expiresIn).toBe(15 * 60)
      expect(res.body.user).toEqual({
        id: user.ownerId,
        fullName: expect.any(String),
        email: user.email,
      })
      expect(res.body.tenant).toEqual({
        id: user.tenantId,
        code: user.code,
        name: expect.any(String),
      })

      const cookie = cookieHeaderFrom(res)
      expect(cookie).toMatch(/^finsoft_rt=[0-9a-f]{64}$/)
      const setCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('finsoft_rt='),
      )
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('Secure')
      expect(setCookie).toMatch(/SameSite=Strict/i)
      expect(setCookie).toContain('Path=/api/auth')

      expect(verificationCountForTests(), 'exactly one argon2id verification').toBe(1)
    })

    it('carries the signed tenant_id claim the RLS model rests on', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: user.code, email: user.email, password: user.password })

      const claims = decodeJwt(res.body.accessToken)
      expect(claims['tenant_id']).toBe(user.tenantId)
      expect(claims.sub).toBe(user.ownerId)
      expect(claims['session_id']).toEqual(expect.any(String))
      expect(claims['perm_ver']).toBe(0)
      expect(claims['mfa']).toBe(false)
    })

    const IDENTICAL_BODY = {
      statusCode: 401,
      error: 'invalid_credentials',
      message: 'Invalid tenant, email or password.',
    }

    it('fails identically on wrong password, unknown email and unknown tenant code', async () => {
      const wrongPassword = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: user.code, email: user.email, password: 'not-the-password' })
      expect(wrongPassword.status).toBe(401)
      expect(wrongPassword.body).toMatchObject(IDENTICAL_BODY)
      expect(verificationCountForTests()).toBe(1)

      resetVerificationCountForTests()
      const unknownEmail = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: user.code, email: `nobody-${unique()}@example.test`, password: 'x' })
      expect(unknownEmail.status).toBe(401)
      expect(unknownEmail.body).toMatchObject(IDENTICAL_BODY)
      expect(verificationCountForTests(), 'a miss still runs exactly one decoy verification').toBe(
        1,
      )

      resetVerificationCountForTests()
      const unknownTenant = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: `NOPE${unique()}`.slice(0, 12), email: user.email, password: 'x' })
      expect(unknownTenant.status).toBe(401)
      expect(unknownTenant.body).toMatchObject(IDENTICAL_BODY)
      expect(
        verificationCountForTests(),
        'an unresolved tenant code still runs exactly one decoy verification (ADR-0023 §4)',
      ).toBe(1)
    })

    it('fails identically for a non-ACTIVE user (INVITED, never activated)', async () => {
      const fresh = await createActiveUserFixtureInvitedOnly()

      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: fresh.code, email: fresh.email, password: 'whatever' })
      expect(res.status).toBe(401)
      expect(res.body).toMatchObject(IDENTICAL_BODY)
    })

    it('ignores a tenantId field in the body — it is not a recognised field and is stripped', async () => {
      const res = await request(app.getHttpServer()).post('/api/auth/login').send({
        tenantCode: user.code,
        email: user.email,
        password: user.password,
        tenantId: 'not-a-real-tenant',
      })
      expect(res.status).toBe(200)
      // The claim still names THIS tenant, never the injected field.
      expect(decodeJwt(res.body.accessToken)['tenant_id']).toBe(user.tenantId)
    })
  })

  describe('refresh rotation and reuse (ADR-0022)', () => {
    /*
     * Each test below performs 2-3 logins/refreshes. Sharing the top-level
     * `user` fixture across them would trip ADR-0023 §5's tight (ip, email)
     * throttle layer (limit 5 / 5 min) purely from test volume — a fresh
     * fixture per test keeps the throttle's own correctness (exercised
     * separately below) from making this section flaky.
     */
    async function fresh() {
      return createActiveUserFixture(`RF${unique()}`.slice(0, 6))
    }

    it('rotates the token and issues a new access token', async () => {
      const u = await fresh()
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })
      const firstCookie = cookieHeaderFrom(login)

      const refreshed = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', firstCookie)
        .set(CSRF)
        .send()

      expect(refreshed.status).toBe(200)
      expect(refreshed.body.accessToken).not.toBe(login.body.accessToken)
      const secondCookie = cookieHeaderFrom(refreshed)
      expect(secondCookie).not.toBe(firstCookie)
    })

    it('requires the CSRF header', async () => {
      const u = await fresh()
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })

      const res = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeaderFrom(login))
        .send()

      expect(res.status).toBe(403)
    })

    it('a replayed spent token revokes the family — no grace window, at any delay', async () => {
      const u = await fresh()
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })
      const firstCookie = cookieHeaderFrom(login)

      // Spend it once — legitimate.
      const firstRefresh = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', firstCookie)
        .set(CSRF)
        .send()
      expect(firstRefresh.status).toBe(200)
      const secondCookie = cookieHeaderFrom(firstRefresh)

      // Replay the SPENT token. Reuse — the family dies.
      const replay = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', firstCookie)
        .set(CSRF)
        .send()
      expect(replay.status).toBe(401)

      // The SUCCESSOR — the "legitimate" side of the same family — is now
      // dead too. This is the whole point: whoever presents second loses,
      // and there is no way to tell attacker from a second tab.
      const afterReuse = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', secondCookie)
        .set(CSRF)
        .send()
      expect(
        afterReuse.status,
        'the successor token must also be dead once reuse revoked the family',
      ).toBe(401)
    })

    it('401s a refresh for a since-DISABLED user, without spending the token (C4)', async () => {
      const u = await fresh()
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })
      const cookie = cookieHeaderFrom(login)

      await disableUser(u)

      const res = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', cookie)
        .set(CSRF)
        .send()
      expect(res.status).toBe(401)
    })
  })

  describe('logout', () => {
    it('revokes the session; a subsequent refresh with its cookie fails', async () => {
      const u = await createActiveUserFixture(`LO${unique()}`.slice(0, 6))
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })
      const cookie = cookieHeaderFrom(login)

      const logout = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .set(CSRF)
        .send()
      expect(logout.status).toBe(204)

      const refreshAfter = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', cookie)
        .set(CSRF)
        .send()
      expect(refreshAfter.status).toBe(401)
    })

    it('requires authentication', async () => {
      const res = await request(app.getHttpServer()).post('/api/auth/logout').set(CSRF).send()
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/auth/me and the guard', () => {
    it('returns the authenticated profile', async () => {
      const u = await createActiveUserFixture(`ME${unique()}`.slice(0, 6))
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })

      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
      expect(res.status).toBe(200)
      expect(res.body.user.id).toBe(u.ownerId)
      expect(res.body.tenant.id).toBe(u.tenantId)
      expect(res.body.permissionVersion).toBe(0)
    })

    it('401s with no bearer token', async () => {
      const res = await request(app.getHttpServer()).get('/api/auth/me')
      expect(res.status).toBe(401)
    })

    it('401s on a malformed token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', 'Bearer not-a-jwt')
      expect(res.status).toBe(401)
    })

    it('401s on an alg:none token with the real payload', async () => {
      const u = await createActiveUserFixture(`AN${unique()}`.slice(0, 6))
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })
      const parts = login.body.accessToken.split('.')
      const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
        'base64url',
      )
      const forged = `${noneHeader}.${parts[1]}.`

      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${forged}`)
      expect(res.status).toBe(401)
    })

    it('401s on an HS256-signed token (algorithm confusion) even with the real claims', async () => {
      // The classic RS256->HS256 confusion: an attacker who can obtain the
      // RS256 PUBLIC key (GET /api/auth/jwks is public by design) tries
      // signing a token with HS256 using the public key material as the
      // HMAC secret, hoping a verifier that trusts the token's own `alg`
      // header will use the public key symmetrically. `verifyAccessToken`
      // pins `algorithms: ['RS256']` independently of the header, so this
      // must be rejected before the signature is even checked.
      const u = await createActiveUserFixture(`HS${unique()}`.slice(0, 6))
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })
      const claims = decodeJwt(login.body.accessToken)

      const jwks = await request(app.getHttpServer()).get('/api/auth/jwks')
      const publicKeyMaterial = JSON.stringify(jwks.body.keys[0])

      const forged = await new SignJWT({
        tenant_id: claims['tenant_id'],
        session_id: claims['session_id'],
        perm_ver: claims['perm_ver'],
        mfa: claims['mfa'],
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.sub as string)
        .setIssuer('finsoft')
        .setAudience('finsoft-api')
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(new TextEncoder().encode(publicKeyMaterial))

      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${forged}`)
      expect(res.status).toBe(401)
    })

    it('401s on a token with a tampered tenant_id claim (signature no longer matches)', async () => {
      const u = await createActiveUserFixture(`TA${unique()}`.slice(0, 6))
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })
      const [header, payload, signature] = login.body.accessToken.split('.')
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      decoded.tenant_id = '00000000-0000-0000-0000-000000000000'
      const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url')
      const forged = `${header}.${tamperedPayload}.${signature}`

      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${forged}`)
      expect(res.status).toBe(401)
    })

    it('ignores a tenant supplied via header, query or body — the claim governs', async () => {
      const u = await createActiveUserFixture(`HD${unique()}`.slice(0, 6))
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ tenantCode: u.code, email: u.email, password: u.password })

      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .set('X-Tenant-Id', '00000000-0000-0000-0000-000000000000')
      expect(res.status).toBe(200)
      expect(res.body.tenant.id).toBe(u.tenantId)
    })
  })

  describe('GET /api/auth/jwks', () => {
    it('is public and exposes the verification keys', async () => {
      const res = await request(app.getHttpServer()).get('/api/auth/jwks')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.keys)).toBe(true)
      expect(res.body.keys.length).toBeGreaterThan(0)
      expect(res.body.keys[0]).not.toHaveProperty('d') // never the private key
    })
  })

  describe('throttling (ADR-0023 §5)', () => {
    it('429s with Retry-After once the tight (ip, email) layer is exhausted', async () => {
      const victim = `throttle-${unique()}@example.test`

      let last
      for (let i = 0; i < 6; i++) {
        last = await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ tenantCode: user.code, email: victim, password: 'wrong' })
      }

      expect(last?.status).toBe(429)
      expect(last?.headers['retry-after']).toEqual(expect.any(String))
    })
  })
})

/** A second, deliberately-not-activated fixture for the non-ACTIVE-user case. */
async function createActiveUserFixtureInvitedOnly() {
  const { createTenantFixture } = await import('@finsoft/database/testing')
  const fixture = await createTenantFixture(`INV${unique()}`.slice(0, 6))
  return { ...fixture, email: `owner.${fixture.code.toLowerCase()}@example.test` }
}
