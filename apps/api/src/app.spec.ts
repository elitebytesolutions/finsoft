import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Body, Controller, Get, INestApplication, Module, Param, Post, Query } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { REPO_ROOT, prepareTestDatabase, teardownTestDatabase } from '@finsoft/database/testing'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { AllExceptionsFilter } from './common/all-exceptions.filter'
import { Public, TenantGuard } from './common/tenant.guard'
import { ZodValidationPipe } from './common/zod-validation.pipe'
import { REQUIRED_SCHEMA_VERSION } from './health/health.service'
import { HealthModule } from './health/health.module'

/*
 * The API skeleton, exercised through real HTTP rather than by calling
 * controller methods directly. A guard, a global prefix, an exception filter
 * and a status code set on the response object only exist once a request has
 * gone through the framework — testing the methods in isolation would assert
 * the parts that cannot break.
 */

const bodySchema = z.object({ name: z.string().min(1) })
const querySchema = z.object({ page: z.string().regex(/^\d+$/) })
const paramSchema = z.string().uuid()

const LEAKY_SECRET = 'connection-string-should-never-appear'

@Controller('probe')
class ProbeController {
  /** Does NOT opt out of the tenant guard. */
  @Get('protected')
  protected_() {
    return { reached: true }
  }

  @Public()
  @Get('public')
  public_() {
    return { reached: true }
  }

  /** Throws a non-HttpException, as a driver or a bug would. */
  @Public()
  @Get('boom')
  boom(): never {
    throw new Error(`pg: could not connect to ${LEAKY_SECRET}`)
  }

  @Public()
  @Post('body')
  body(@Body(new ZodValidationPipe(bodySchema)) parsed: z.infer<typeof bodySchema>) {
    return { parsed }
  }

  @Public()
  @Get('query')
  query(@Query(new ZodValidationPipe(querySchema)) parsed: z.infer<typeof querySchema>) {
    return { parsed }
  }

  @Public()
  @Get('param/:id')
  param(@Param('id', new ZodValidationPipe(paramSchema)) id: string) {
    return { id }
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
     * refuses any other.
     */
    await prepareTestDatabase()

    /*
     * The exception filter logs through @finsoft/observability, and
     * getLogger() throws when the logger has not been initialised — by
     * design, so a line written before startup named the service cannot be
     * attributed to the wrong one. main.ts calls this during bootstrap; a
     * test that builds the app itself has to do the same.
     *
     * `fatal` keeps the 5xx probes below from printing their deliberate
     * errors over the test output.
     */
    resetLoggerForTests()
    initLogger({ service: 'api-test', level: 'fatal' })

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new AllExceptionsFilter())
    await app.init()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    resetLoggerForTests()
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
    it('reports the schema version it required, not merely a count', async () => {
      const res = await request(app.getHttpServer()).get('/api/health/ready')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ready')
      expect(res.body.checks.database.status).toBe('up')
      // Proves it compared against a requirement rather than counting rows.
      expect(res.body.checks.database.detail).toMatch(
        new RegExp(`^schema \\d+, requires ${REQUIRED_SCHEMA_VERSION}$`),
      )
    })

    it('keeps REQUIRED_SCHEMA_VERSION in step with the migrations on disk', () => {
      /*
       * The constant is the compatibility contract: a build deployed ahead of
       * its migrations must report NOT ready rather than fail on the first
       * query against a column that does not exist. It lives in code so the
       * running container needs no access to the migration files — and this
       * test is what stops it drifting behind them.
       */
      const highest = readdirSync(join(REPO_ROOT, 'database', 'migrations'))
        .filter((f) => f.endsWith('.sql'))
        .map((f) => Number(f.slice(0, 3)))
        .reduce((a, b) => Math.max(a, b), 0)

      expect(
        REQUIRED_SCHEMA_VERSION,
        `${highest} migration(s) exist. If the API needs the newest one, bump ` +
          'REQUIRED_SCHEMA_VERSION in health.service.ts.',
      ).toBe(highest)
    })
  })

  describe('the tenant guard fails closed', () => {
    it('refuses a route that has not opted out', async () => {
      // The substance of the whole guard. Authentication is Wave 1, so no
      // request can present a verified tenant — and the default must be
      // refusal, not "allow until auth arrives".
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

  describe('the exception filter', () => {
    it('turns an unexpected error into a flat 500', async () => {
      const res = await request(app.getHttpServer()).get('/api/probe/boom')
      expect(res.status).toBe(500)
      expect(res.body.error).toBe('internal_error')
      expect(res.body.message).toBe('An unexpected error occurred.')
    })

    it('leaks nothing from the underlying error', async () => {
      // A pg error names host, port, database and role; a Kysely error can
      // carry SQL text and bound parameters, which on a posting path means
      // amounts and account ids (rule 20).
      const res = await request(app.getHttpServer()).get('/api/probe/boom')
      const serialised = JSON.stringify(res.body)
      expect(serialised).not.toContain(LEAKY_SECRET)
      expect(serialised).not.toContain('pg:')
      expect(serialised).not.toMatch(/\bat \w+.*\.ts:\d+/) // no stack frames
    })

    it('preserves a deliberate status rather than flattening it to 500', async () => {
      // IMPLEMENTATION.md:247 — a permission failure is 403, not 500, not 200.
      expect((await request(app.getHttpServer()).get('/api/probe/protected')).status).toBe(403)
      expect((await request(app.getHttpServer()).get('/api/does-not-exist')).status).toBe(404)
    })

    it('gives every error the same shape', async () => {
      for (const path of ['/api/probe/boom', '/api/probe/protected', '/api/does-not-exist']) {
        const res = await request(app.getHttpServer()).get(path)
        expect(Object.keys(res.body)).toEqual(
          expect.arrayContaining(['statusCode', 'error', 'message', 'path', 'timestamp']),
        )
        expect(res.body.path).toBe(path)
      }
    })
  })

  describe('zod validation reaches body, query and path', () => {
    it('validates and passes through a body', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/probe/body')
        .send({ name: 'Bhatti' })
      expect(res.status).toBe(201)
      expect(res.body.parsed).toEqual({ name: 'Bhatti' })
    })

    it('strips an undeclared body property, so a tenant cannot be smuggled', async () => {
      // ADR-0004:76 — a request that tries to supply a tenant is not honoured.
      const res = await request(app.getHttpServer())
        .post('/api/probe/body')
        .send({ name: 'Bhatti', tenant_id: '00000000-0000-0000-0000-000000000001' })
      expect(res.status).toBe(201)
      expect(res.body.parsed).not.toHaveProperty('tenant_id')
    })

    it('rejects a bad body with 400', async () => {
      const res = await request(app.getHttpServer()).post('/api/probe/body').send({ name: '' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('validation_failed')
    })

    it('validates a query string', async () => {
      expect((await request(app.getHttpServer()).get('/api/probe/query?page=2')).status).toBe(200)
      const bad = await request(app.getHttpServer()).get('/api/probe/query?page=abc')
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe('validation_failed')
    })

    it('validates a path parameter', async () => {
      const ok = await request(app.getHttpServer()).get(
        '/api/probe/param/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      )
      expect(ok.status).toBe(200)
      expect((await request(app.getHttpServer()).get('/api/probe/param/not-a-uuid')).status).toBe(
        400,
      )
    })

    it('hands the handler the PARSED value, not the raw input', async () => {
      // The pipe's output is what business logic sees. If the raw request
      // object were passed through, every downstream assumption about shape
      // would rest on the client.
      const res = await request(app.getHttpServer()).get('/api/probe/query?page=7&extra=ignored')
      expect(res.body.parsed).toEqual({ page: '7' })
    })
  })

  describe('global prefix', () => {
    it('serves nothing outside /api, so the proxy can route on path alone', async () => {
      expect((await request(app.getHttpServer()).get('/health')).status).toBe(404)
      expect((await request(app.getHttpServer()).get('/api/health')).status).toBe(200)
    })
  })
})
