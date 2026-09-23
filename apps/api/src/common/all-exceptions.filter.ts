import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common'
import { getLogger, redactError } from '@finsoft/observability'
import type { Request, Response } from 'express'

/*
 * One error shape for the whole API, and one rule about what may leave the
 * process.
 *
 * An HttpException was thrown deliberately and its status and message are
 * part of the contract — a 403 from the tenant guard, a 400 from the zod
 * pipe. Those pass through.
 *
 * Anything else is a bug, and its message is not safe to return. A `pg`
 * connection error names the host, port, database and role; a Kysely error
 * can carry the SQL text and bound parameters, which on a posting path means
 * amounts and account ids. IMPLEMENTATION.md:247 asks for 403 rather than 500
 * on a permission failure; rule 20 governs the rest. So an unrecognised error
 * becomes a flat 500 with a fixed message, and the real one goes to the log.
 *
 * Structured logging arrives with FND-010. The Logger call here is the seam
 * it will replace.
 */

interface ErrorBody {
  readonly statusCode: number
  readonly error: string
  readonly message: string
  readonly path: string
  readonly timestamp: string
  readonly details?: unknown
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request = ctx.getRequest<Request>()

    /*
     * originalUrl, not url. With setGlobalPrefix the routes sit in a
     * mounted Express router, and inside a mounted router req.url is
     * relative to the mount point — so a 404 would be reported as
     * /does-not-exist rather than /api/does-not-exist, naming a path that
     * does not exist. An error report whose path is wrong is worse than
     * one with no path at all.
     */
    const path = request.originalUrl ?? request.url
    const body = this.toBody(exception, path)

    if (body.statusCode >= 500) {
      /*
       * The full error, including its cause chain, server-side only — and
       * through redactError, which is the point.
       *
       * This is the highest-risk log line in the API: a `pg` connection
       * failure carries host, port, database and the role it authenticated
       * as, and none of that trips a key-name or token-shape check. It was
       * previously written by NestJS's own Logger as raw text. Rule 20.
       */
      getLogger().error(
        {
          method: request.method,
          path,
          statusCode: body.statusCode,
          err: redactError(exception),
        },
        `${request.method} ${path} -> ${body.statusCode}`,
      )
    }

    response.status(body.statusCode).json(body)
  }

  private toBody(exception: unknown, path: string): ErrorBody {
    const timestamp = new Date().toISOString()

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const payload = exception.getResponse()

      // getResponse() is a string for the bare constructor form and an object
      // for the structured form the zod pipe uses. Normalise both.
      if (typeof payload === 'string') {
        return { statusCode: status, error: exception.name, message: payload, path, timestamp }
      }

      const record = payload as Record<string, unknown>
      return {
        statusCode: status,
        error: typeof record['error'] === 'string' ? record['error'] : exception.name,
        message:
          typeof record['message'] === 'string' ? record['message'] : 'The request was refused.',
        path,
        timestamp,
        ...(record['details'] === undefined ? {} : { details: record['details'] }),
      }
    }

    /*
     * Deliberately says nothing. Not the error class, not its message, not
     * whether it came from the database — an unauthenticated caller learns
     * only that the request failed.
     */
    return {
      statusCode: 500,
      error: 'internal_error',
      message: 'An unexpected error occurred.',
      path,
      timestamp,
    }
  }
}
