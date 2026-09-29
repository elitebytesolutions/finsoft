import { INestApplication, Module } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import { Redis } from 'ioredis'
import { sql } from 'kysely'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '@finsoft/database'
import { prepareTestDatabase, runAs, teardownTestDatabase } from '@finsoft/database/testing'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'
import { AuthModule } from '../../apps/api/src/auth/auth.module.ts'
import { TenantContextInterceptor } from '../../apps/api/src/common/tenant-context.interceptor.ts'
import { TenantGuard } from '../../apps/api/src/common/tenant.guard.ts'
import { createActiveUserFixture, type ActiveUserFixture } from './helpers/auth-seed.ts'

/*
 * M1-X, L1: the guard refuses a token whose perm_ver claim is behind the
 * user's CURRENT permission version, and refuses when the user is not
 * ACTIVE or the tenant is not ACTIVE — checked on every request, not only at
 * login/refresh, per apps/api/src/common/tenant.guard.ts ->
 * @finsoft/auth's verifyBearerToken -> getAccountStateCached.
 *
 * Each case below flips the row on a SEPARATE connection (runAs + withTenant
 * directly, not through the HTTP surface — there is no admin endpoint for
 * this yet) BEFORE the first authenticated request for that user, so the
 * short-TTL Redis cache is a guaranteed miss and reads the post-flip state,
 * exactly as it would on any other cold key.
 */

@Module({
  imports: [AuthModule],
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
class TestAuthAppModule {}

let app: INestApplication

async function loginAndGetToken(user: ActiveUserFixture): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ tenantCode: user.code, email: user.email, password: user.password })
  expect(res.status).toBe(200)
  return res.body.accessToken as string
}

async function bumpUsersVersion(user: ActiveUserFixture): Promise<void> {
  await runAs({ tenantId: user.tenantId, userId: user.ownerId }, () =>
    withTenant((tx) =>
      tx
        .updateTable('users')
        .set({ version: sql`version + 1`, updated_by: null })
        .where('id', '=', user.ownerId)
        .execute(),
    ),
  )
}

async function suspendUser(user: ActiveUserFixture): Promise<void> {
  await runAs({ tenantId: user.tenantId, userId: user.ownerId }, () =>
    withTenant((tx) =>
      tx
        .updateTable('users')
        .set({ status: 'SUSPENDED', updated_by: null, version: sql`version + 1` })
        .where('id', '=', user.ownerId)
        .execute(),
    ),
  )
}

/**
 * finsoft_app holds no UPDATE grant on tenants.status (ADR-0023 §1) — a
 * tenant suspension is a separately-permissioned operator action, not
 * something the ordinary app role can do to itself. This goes through
 * finsoft_migration directly, exactly as
 * tests/integration/login-toctou.spec.ts's identical case does.
 */
async function suspendTenant(user: ActiveUserFixture): Promise<void> {
  const { Client } = await import('pg')
  const url = process.env['TEST_MIGRATION_DATABASE_URL']
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('UPDATE tenants SET status = $2 WHERE id = $1', [user.tenantId, 'SUSPENDED'])
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  await prepareTestDatabase()
  process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL']

  const flusher = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379')
  await flusher.flushdb()
  await flusher.quit()

  resetLoggerForTests()
  initLogger({ service: 'account-state-guard-test', level: 'fatal' })

  const moduleRef = await Test.createTestingModule({ imports: [TestAuthAppModule] }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.use(cookieParser())
  app.useGlobalFilters(new AllExceptionsFilter())
  await app.init()
}, 120_000)

afterAll(async () => {
  await app?.close()
  resetLoggerForTests()
  await teardownTestDatabase()
})

describe('the guard refuses a stale perm_ver claim', () => {
  it('401s once users.version has moved past the token\'s snapshot', async () => {
    const user = await createActiveUserFixture('PV1')
    const token = await loginAndGetToken(user)

    // Simulates what migration 008's permission_version cascade does on a
    // role/permission change: bumps users.version without touching the
    // session or minting a new token.
    await bumpUsersVersion(user)

    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('a freshly minted token (refresh) carries the current version and is accepted', async () => {
    const user = await createActiveUserFixture('PV2')
    const token = await loginAndGetToken(user)
    await bumpUsersVersion(user)

    const stale = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(stale.status).toBe(401)

    // A fresh login (a fresh mint, exactly like a refresh would produce)
    // snapshots the version AFTER the bump and is accepted.
    const freshToken = await loginAndGetToken(user)
    const fresh = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${freshToken}`)
    expect(fresh.status).toBe(200)
  })
})

describe('the guard refuses a non-ACTIVE user, even mid-session', () => {
  it('401s once the user is SUSPENDED, before the access token would otherwise expire', async () => {
    const user = await createActiveUserFixture('PV3')
    const token = await loginAndGetToken(user)

    await suspendUser(user)

    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })
})

describe('the guard refuses a non-ACTIVE tenant, even mid-session', () => {
  it('401s once the tenant is SUSPENDED', async () => {
    const user = await createActiveUserFixture('PV4')
    const token = await loginAndGetToken(user)

    await suspendTenant(user)

    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })
})

describe('the ordinary case is unaffected', () => {
  it('an ACTIVE user with an unchanged version is accepted', async () => {
    const user = await createActiveUserFixture('PV5')
    const token = await loginAndGetToken(user)

    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})
