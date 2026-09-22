import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { closeDatabase } from '@finsoft/database'
import { AppModule } from './app.module'

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
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  const logger = new Logger('bootstrap')

  /*
   * Everything is served under /api, so the reverse proxy can route on path
   * alone without rewriting. /health is therefore /api/health — the probe
   * travels the same path as real traffic, which is the point of a probe.
   */
  app.setGlobalPrefix('api')

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
