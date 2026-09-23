import type { LoggerService, LogLevel } from '@nestjs/common'
import { getLogger, redactError } from '@finsoft/observability'

/*
 * NestJS's logging, routed through the redacting logger.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * NestJS ships its own `Logger`, and it was being used directly: bootstrap
 * messages, route mapping, and — the one that matters — the exception
 * filter's 5xx handler writing a full stack trace.
 *
 * That produced a SECOND log stream on the same stdout the JSON pipeline
 * reads. Unstructured, so the aggregator cannot parse it. Uncorrelated, so
 * the line cannot be joined to the request that caused it. And, decisively,
 * UNREDACTED — a `pg` connection error carries host, port, database and role,
 * and this was the single most likely place one reached the log (rule 20).
 *
 * `ADR-0016` claims "one root logger, idempotent". That was not true of the
 * running system while this existed. It is now.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────
 *
 * It does not make NestJS's own internal messages structured data. They
 * arrive as strings, and they leave as the `msg` field of a JSON line. What
 * it does is put every one of them through the same redaction the rest of
 * the system uses, and give them the ambient correlation context.
 */
export class FinsoftNestLogger implements LoggerService {
  private readonly context: string

  constructor(context = 'nest') {
    this.context = context
  }

  /**
   * NestJS passes an optional trailing context argument, and for `error()` a
   * trailing stack string as well. Both arrive as untyped rest parameters.
   */
  private write(level: 'debug' | 'info' | 'warn' | 'error', message: unknown, rest: unknown[]) {
    /*
     * Everything goes through the logger's own choke point rather than being
     * pre-formatted here: the merge object passes `formatters.log`, and the
     * message string passes the `logMethod` hook. Building a single string
     * here would smuggle the detail past the object path.
     */
    const [first, ...others] = rest
    const context = typeof first === 'string' ? first : this.context

    const extra: Record<string, unknown> = { nestContext: context }

    // `error()` supplies a stack as its first trailing argument in some
    // call shapes and as part of `message` in others. Both are treated as an
    // error payload so `redactError` sees them.
    const detail = others.length > 0 ? others : undefined
    if (detail) extra.detail = detail

    if (message instanceof Error) {
      getLogger()[level]({ ...extra, err: redactError(message) }, message.message)
      return
    }

    if (typeof first === 'string' && level === 'error' && rest.length > 1) {
      // (message, stack, context) — the filter's shape.
      extra.stack = first
      extra.nestContext = typeof others[0] === 'string' ? others[0] : this.context
    }

    getLogger()[level](extra, String(message))
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest)
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest)
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest)
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest)
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest)
  }

  /** NestJS asks which levels are on; the logger's own level decides. */
  setLogLevels?(_levels: LogLevel[]): void {
    // Intentionally empty. LOG_LEVEL owns this, in one place, for both
    // services — two competing level configurations is how a production
    // logger ends up silently quieter than anyone expects.
  }
}
