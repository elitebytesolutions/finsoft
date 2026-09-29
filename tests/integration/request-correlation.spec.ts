import { Writable } from 'node:stream'
import type { MiddlewareConsumer, NestMiddleware, INestApplication } from '@nestjs/common'
import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { recordAudit, TenantContext, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { getCorrelation, getLogger, initLogger, resetLoggerForTests } from '@finsoft/observability'
import {
  REQUEST_ID_RESPONSE_HEADER,
  requestCorrelationMiddleware,
} from '../../apps/api/src/correlation/request-correlation.middleware.ts'
import { AllExceptionsFilter } from '../../apps/api/src/common/all-exceptions.filter.ts'

/*
 * M1-C, end to end over real HTTP: the correlation middleware establishes
 * requestId/ip for the whole pipeline, echoes X-Request-Id on the response,
 * every log line for the request carries it, and an audit row written
 * during the request (with no explicit requestId/ip of its own) picks both
 * up from the ambient context — the exact chain the Architecture seat's
 * ruling on M2 depends on: audit rows must carry a request id, and it must
 * come from somewhere real, not be threaded by hand through every call site.
 *
 * Registration order matters and is deliberately made to mirror main.ts:
 * `requestCorrelationMiddleware` is bound with `app.use()`, exactly as
 * main.ts binds it, BEFORE the test's own tenant-context middleware (which
 * stands in for real authentication — there is no real TenantGuard wired
 * into this throwaway module, matching the established pattern in
 * audit-api.spec.ts) and before app.init().
 */

const TEST_TENANT_HEADER = 'x-test-tenant-id'
const TEST_USER_HEADER = 'x-test-user-id'

@Injectable()
class TestTenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const tenantId = req.header(TEST_TENANT_HEADER)
    const userId = req.header(TEST_USER_HEADER) ?? null
    if (!tenantId) {
      next()
      return
    }
    TenantContext.run({ tenantId, userId }, next)
  }
}

@Controller('probe')
class CorrelationProbeController {
  /** Writes one audit row, deliberately omitting requestId/ip. */
  @Get('audit')
  async writeAudit() {
    getLogger().info({}, 'probe handling request')

    const { userId } = TenantContext.require()
    const result = await withTenant((tx) =>
      recordAudit(tx, {
        actorUserId: userId,
        action: 'CORRELATION_PROBE',
        entityType: 'probe',
        entityId: null,
        beforeJson: null,
        afterJson: null,
      }),
    )

    return { requestId: getCorrelation()?.requestId, auditId: result.id }
  }

  /*
   * POST with a JSON body: NestJS's default body parser reads the request
   * stream (an asynchronous operation happening AFTER
   * requestCorrelationMiddleware has already called `next()`) before this
   * handler — or any guard/interceptor — runs. This proves the correlation
   * context, entered via AsyncLocalStorage around `next()`, survives that
   * hop rather than being an artefact of GET requests never crossing it.
   */
  @Post('audit')
  async writeAuditFromBody(@Body() body: { note?: string }) {
    getLogger().info({}, 'probe handling POST request')

    const { userId } = TenantContext.require()
    const result = await withTenant((tx) =>
      recordAudit(tx, {
        actorUserId: userId,
        action: 'CORRELATION_PROBE_POST',
        entityType: 'probe',
        entityId: null,
        beforeJson: null,
        afterJson: null,
      }),
    )

    return {
      requestId: getCorrelation()?.requestId,
      auditId: result.id,
      receivedNote: body?.note,
    }
  }
}

@Module({ controllers: [CorrelationProbeController] })
class ProbeModule {}

@Module({ imports: [ProbeModule] })
class TestAppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TestTenantContextMiddleware).forRoutes('*')
  }
}

let app: INestApplication
let tenant: TenantFixture
let lines: Record<string, unknown>[]

beforeAll(async () => {
  await prepareTestDatabase()
  tenant = await createTenantFixture('RQC')
}, 120_000)

afterAll(async () => teardownTestDatabase())

beforeEach(async () => {
  resetLoggerForTests()
  lines = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)))
      callback()
    },
  })
  initLogger({ service: 'api', destination: stream, level: 'debug' })

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  app = moduleRef.createNestApplication()
  app.use(requestCorrelationMiddleware)
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new AllExceptionsFilter())
  await app.init()
}, 60_000)

afterEach(async () => {
  await app?.close()
  resetLoggerForTests()
})

interface StoredRow {
  request_id: string | null
  ip: string | null
}

async function storedRow(auditId: string): Promise<StoredRow> {
  return TenantContext.run({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant(async (tx) => {
      const [row] = await rawOn<StoredRow>(
        tx,
        'select request_id, ip from audit_log where id = $1',
        [auditId],
      )
      return row!
    }),
  )
}

describe('a request with a valid X-Request-Id', () => {
  it('echoes it on the response, and the audit row written during the request carries it', async () => {
    const requestId = '9f8e7d6c-5b4a-4321-9876-543210fedcba'

    const res = await request(app.getHttpServer())
      .get('/api/probe/audit')
      .set('X-Request-Id', requestId)
      .set('X-Forwarded-For', '203.0.113.42')
      .set(TEST_TENANT_HEADER, tenant.tenantId)
      .set(TEST_USER_HEADER, tenant.ownerId)
      .expect(200)

    expect(res.headers[REQUEST_ID_RESPONSE_HEADER.toLowerCase()]).toBe(requestId)
    expect(res.body.requestId).toBe(requestId)

    const row = await storedRow(res.body.auditId)
    expect(row.request_id).toBe(requestId)
    // Normalised (ADR-0020 ip.ts): a plain IPv4 dotted-quad is unchanged.
    expect(row.ip).toBe('203.0.113.42')
  })

  it('carries the request id on every log line for the request', async () => {
    const requestId = '9f8e7d6c-5b4a-4321-9876-543210fedcbb'

    await request(app.getHttpServer())
      .get('/api/probe/audit')
      .set('X-Request-Id', requestId)
      .set(TEST_TENANT_HEADER, tenant.tenantId)
      .set(TEST_USER_HEADER, tenant.ownerId)
      .expect(200)

    const probeLine = lines.find((l) => l['msg'] === 'probe handling request')
    expect(probeLine).toBeDefined()
    expect(probeLine?.['requestId']).toBe(requestId)
  })

  /*
   * Architecture seat condition, M1-C: ip is personal data and must never
   * reach a log line, even though it does reach the audit row (asserted
   * above). packages/observability/src/logger.test.ts covers mixin() in
   * isolation; this is the same rule asserted against the real pipeline —
   * a real request, a real X-Forwarded-For, the real logger.
   */
  it('never logs the ip, on any line written while handling the request', async () => {
    const requestId = '9f8e7d6c-5b4a-4321-9876-543210fedcbc'

    await request(app.getHttpServer())
      .get('/api/probe/audit')
      .set('X-Request-Id', requestId)
      .set('X-Forwarded-For', '203.0.113.77')
      .set(TEST_TENANT_HEADER, tenant.tenantId)
      .set(TEST_USER_HEADER, tenant.ownerId)
      .expect(200)

    for (const l of lines) {
      expect(l['ip'], `log line ${JSON.stringify(l)} must not carry ip`).toBeUndefined()
    }
    expect(JSON.stringify(lines)).not.toContain('203.0.113.77')
  })
})

describe('a request with no X-Request-Id, or a malformed one', () => {
  it('mints a fresh id, echoes it, and the audit row carries THAT id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/probe/audit')
      .set(TEST_TENANT_HEADER, tenant.tenantId)
      .set(TEST_USER_HEADER, tenant.ownerId)
      .expect(200)

    const echoed = res.headers[REQUEST_ID_RESPONSE_HEADER.toLowerCase()]
    expect(echoed).toBeTruthy()
    expect(res.body.requestId).toBe(echoed)

    const row = await storedRow(res.body.auditId)
    expect(row.request_id).toBe(echoed)
  })

  it('an oversized/malformed header is replaced, never adopted verbatim', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/probe/audit')
      .set('X-Request-Id', '; DROP TABLE audit_log; --')
      .set(TEST_TENANT_HEADER, tenant.tenantId)
      .set(TEST_USER_HEADER, tenant.ownerId)
      .expect(200)

    const echoed = res.headers[REQUEST_ID_RESPONSE_HEADER.toLowerCase()]
    expect(echoed).not.toBe('; DROP TABLE audit_log; --')
    expect(echoed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    const row = await storedRow(res.body.auditId)
    expect(row.request_id).toBe(echoed)
  })
})

describe('a POST with a JSON body', () => {
  it('the correlation context survives the body parser: the audit row carries request_id and the normalised ip', async () => {
    const requestId = '9f8e7d6c-5b4a-4321-9876-543210fedcbd'

    const res = await request(app.getHttpServer())
      .post('/api/probe/audit')
      .set('X-Request-Id', requestId)
      .set('X-Forwarded-For', '203.0.113.88')
      .set(TEST_TENANT_HEADER, tenant.tenantId)
      .set(TEST_USER_HEADER, tenant.ownerId)
      .send({ note: 'hello from the body' })
      .expect(201)

    // The body really was parsed — this is not a no-op POST.
    expect(res.body.receivedNote).toBe('hello from the body')
    expect(res.body.requestId).toBe(requestId)
    expect(res.headers[REQUEST_ID_RESPONSE_HEADER.toLowerCase()]).toBe(requestId)

    const row = await storedRow(res.body.auditId)
    expect(row.request_id).toBe(requestId)
    expect(row.ip).toBe('203.0.113.88')
  })
})

describe('idempotent request-id round trip', () => {
  it('two distinct requests never mint the same id', async () => {
    const first = await request(app.getHttpServer())
      .get('/api/probe/audit')
      .set(TEST_TENANT_HEADER, tenant.tenantId)
      .set(TEST_USER_HEADER, tenant.ownerId)
      .expect(200)
    const second = await request(app.getHttpServer())
      .get('/api/probe/audit')
      .set(TEST_TENANT_HEADER, tenant.tenantId)
      .set(TEST_USER_HEADER, tenant.ownerId)
      .expect(200)

    expect(first.headers[REQUEST_ID_RESPONSE_HEADER.toLowerCase()]).not.toBe(
      second.headers[REQUEST_ID_RESPONSE_HEADER.toLowerCase()],
    )
  })
})
