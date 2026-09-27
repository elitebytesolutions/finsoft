import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import cookieParser from 'cookie-parser'
import { closeDatabase, openDatabase } from '@finsoft/database'
import { initLogger } from '@finsoft/observability'
import { FinsoftNestLogger } from './common/nest-logger'
import { AllExceptionsFilter } from './common/all-exceptions.filter'
import { AppModule } from './app.module'
import { assertProductionCookieSecurity, refreshCookieName } from './auth/cookie'

/*
 * The API process.
 *
 * It sits behind the reverse proxy at /api/*, same-origin with the web app —
 * which is what lets ADR-0009's SameSite=Strict refresh cookie work at all.
 * Next.js Server Components call this over the internal address; there is no
 * Next route handler in between.
 */

const DEFAULT_PORT = 3001

async function bootstrap(): Promise<void> {
  /*
   * Before anything else, including the logger and the database pool: a
   * synchronous, dependency-free check of the refresh cookie configuration.
   * assertProductionCookieSecurity() refuses to start in production without
   * a __Host- or __Secure- prefix; refreshCookieName() (already called on
   * every request) is called here too so a __Host- name paired with the
   * wrong path fails at boot, on every environment, rather than on the
   * first request that happens to touch it.
   */
  assertProductionCookieSecurity()
  refreshCookieName()

  /*
   * Before anything that might log. NestJS's own bootstrap messages are
   * routed through this logger below, and getLogger() throws if it has not
   * been initialised — deliberately, so a line written before startup
   * configured the service name is a loud failure rather than a line
   * attributed to the wrong service.
   */
  initLogger({ service: 'api' })

  /*
   * Open the pool BEFORE the server listens, and fail startup if it will not
   * open.
   *
   * Without this the pool opened lazily on the first query, which moved three
   * assertions from boot to whichever user made that request:
   *
   *   - the connecting role is subject to RLS. Pointed at finsoft_migration
   *     or a superuser, every policy in the database is off for this process
   *     and the system looks perfectly healthy while each tenant sees all
   *     rows. This is the one that matters.
   *   - numeric and int8 still arrive as strings (ADR-0013). A rewired type
   *     parser returns floats for money.
   *   - the connection string works at all.
   *
   * An orchestrator restarting a process that refuses to boot is the
   * behaviour wanted here; a process that starts, reports healthy, and fails
   * every request is not.
   */
  await openDatabase()

  const app = await NestFactory.create(AppModule, { bufferLogs: true })

  /*
   * Every NestJS log line now goes through the redacting logger. Without
   * this, NestJS wrote unstructured, uncorrelated, UNREDACTED text to the
   * same stdout the JSON pipeline reads — and the exception filter's 5xx
   * handler, which logs a full stack, was the likeliest place a pg
   * connection error carrying host, port, database and role reached the log.
   *
   * bufferLogs above holds NestJS's own startup messages until this call, so
   * they are replayed through the redactor rather than escaping before it is
   * installed.
   */
  const logger = new FinsoftNestLogger('bootstrap')
  app.useLogger(logger)

  /*
   * Everything is served under /api, so the reverse proxy can route on path
   * alone without rewriting. /health is therefore /api/health — the probe
   * travels the same path as real traffic, which is the point of a probe.
   */
  app.setGlobalPrefix('api')

  /*
   * ADR-0009: the refresh token travels only as an HttpOnly cookie, never in
   * a header or body. Reading it back (`req.cookies`) needs this middleware;
   * nothing here parses a *signed* cookie, because the refresh token is
   * opaque and hashed at rest, not something this process signs.
   */
  app.use(cookieParser())

  /*
   * One error shape for every failure, and nothing internal in a response.
   * An HttpException carries a deliberate status and message; anything else
   * becomes a flat 500 with the real error logged server-side (rule 20).
   */
  app.useGlobalFilters(new AllExceptionsFilter())

  /*
   * No global ValidationPipe.
   *
   * NestJS's built-in pipe is driven by class-validator, and ARCHITECTURE §2
   * puts shared schemas in packages/validation as zod. Installing
   * class-validator would mean two validation libraries with two sets of
   * rules, and eventually a field validated by one and not the other.
   *
   * Validation is per-route via ZodValidationPipe with a schema from
   * packages/validation. That pipe strips undeclared properties, so a
   * request still cannot smuggle a field the schema does not declare —
   * tenant_id above all (ADR-0004:76, rule 8).
   */

  if (process.env.NODE_ENV !== 'production') {
    /*
     * OpenAPI is served in non-production only. IMPLEMENTATION.md:250 makes
     * documented APIs part of the Definition of Done; publishing the full
     * surface unauthenticated in production is a different decision, and not
     * one to take by default.
     */
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('FinSoft API')
        .setDescription('Multi-tenant double-entry accounting and distribution ERP.')
        .setVersion('0.1.0')
        .build(),
    )
    SwaggerModule.setup('api/docs', app, document)
    logger.log('OpenAPI served at /api/docs')
  }

  /*
   * The pool must close, or a redeploy leaves connections held open against
   * a fixed backend budget until PostgreSQL times them out.
   */
  app.enableShutdownHooks()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void app
        .close()
        .then(() => closeDatabase())
        .then(() => process.exit(0))
    })
  }

  const port = Number(process.env.API_PORT ?? DEFAULT_PORT)
  await app.listen(port, '0.0.0.0')
  logger.log(`listening on ${port}`)
}

void bootstrap()
