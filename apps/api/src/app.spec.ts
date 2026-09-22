import { Controller, Get, INestApplication, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prepareTestDatabase, teardownTestDatabase } from '@finsoft/database/testing'
import { Public, TenantGuard } from './common/tenant.guard'
import { HealthModule } from './health/health.module'

/*
 * The API skeleton, exercised through real HTTP rather than by calling
 * controller methods directly. A guard, a global prefix and a status code set
 * on the response object are all things that only exist once a request has
 * gone through the framework — testing the method in isolation would assert
 * the parts that cannot break.
 */

/** A route that does NOT opt out of the tenant guard. */
@Controller('probe')
class ProbeController {
  @Get('protected')
  protected_() {
    return { reached: true }
  }

  @Public()
  @Get('public')
  public_() {
    return { reached: true }
  }
}

@Module({
  imports: [HealthModule],
  controllers: [ProbeController],
  providers: [{ provide: APP_GUARD, useClass: TenantGuard }],
})
class TestAppModule {}

describe('API skeleton', () => {
  let app: INestApplication

  beforeAll(async () => {
    /*
     * Points the pool at the TEST cluster before anything can open one
     * against the development database. The harness asserts the target and
     * refuses any other, so a readiness probe in a test can never reach dev
     * data (FND-005 keeps them as separate servers, not separate databases).
     */
    await prepareTestDatabase()

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await teardownTestDatabase()
  })

  describe('liveness', () => {
    it('answers 200 without touching a dependency', async () => {
      const res = await request(app.getHttpServer()).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0)
    })

    it('exposes nothing beyond uptime', async () => {
      // Unauthenticated endpoint. Version, hostname and dependency detail are
      // reconnaissance, and rule 20 governs what may leave the process.
      const res = await request(app.getHttpServer()).get('/api/health')
      expect(Object.keys(res.body).sort()).toEqual(['status', 'uptimeSeconds'])
    })
  })

  describe('readiness', () => {
    it('reports the database as up and names how many migrations are applied', async () => {
      const res = await request(app.getHttpServer()).get('/api/health/ready')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ready')
      expect(res.body.checks.database.status).toBe('up')
      // Proves the check actually queried rather than returning a constant.
      expect(res.body.checks.database.detail).toMatch(/^\d+ migration\(s\) applied$/)
    })
  })

  describe('the tenant guard fails closed', () => {
    it('refuses a route that has not opted out', async () => {
      // The substance of the whole guard. Authentication is Wave 1, so no
      // request can present a verified tenant — and the default must be
      // refusal, not "allow until auth arrives". A permissive default would
      // let the first Wave 1 endpoint serve untenanted with nothing failing.
      const res = await request(app.getHttpServer()).get('/api/probe/protected')
      expect(res.status).toBe(403)
      expect(res.body.reached).toBeUndefined()
    })

    it('allows a route that is explicitly @Public()', async () => {
      const res = await request(app.getHttpServer()).get('/api/probe/public')
      expect(res.status).toBe(200)
      expect(res.body.reached).toBe(true)
    })
  })

  describe('global prefix', () => {
    it('serves nothing outside /api, so the proxy can route on path alone', async () => {
      expect((await request(app.getHttpServer()).get('/health')).status).toBe(404)
      expect((await request(app.getHttpServer()).get('/api/health')).status).toBe(200)
    })
  })
})
