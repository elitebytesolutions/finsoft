/*
 * The logger.
 *
 * INFRASTRUCTURE §8: application → structured JSON logs → aggregation. So the
 * output is JSON on stdout and nothing else. The process does not know where
 * its logs go; the platform decides. A logger that writes files, rotates them
 * or ships them itself is a logger that breaks in a container.
 *
 * pino is the implementation, for two reasons that matter here rather than
 * because it is popular: it serialises straight to JSON without an intermediate
 * string format, and it is fast enough that nobody is tempted to make logging
 * conditional to claw back latency on the posting path.
 *
 * Every log object passes through redact.ts on the way in — see the comment
 * there for why that is three layers and not one.
 */

import { pino, type DestinationStream, type Logger as PinoLogger, type LoggerOptions } from 'pino'

import { getCorrelation } from './context.ts'
import { redact, redactValueShapes } from './redact.ts'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LEVELS: readonly string[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

function resolveLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase()
  if (raw && LEVELS.includes(raw)) return raw as LogLevel
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

/*
 * Base fields on every line, so an aggregator can slice by deployment without
 * the application having to remember to add them per call.
 *
 * `service` distinguishes api from worker — INFRASTRUCTURE §8 requires
 * correlation ACROSS them, which is only possible if lines say which they
 * came from.
 */
export interface LoggerConfig {
  readonly service: string
  readonly level?: LogLevel
  readonly version?: string
  /*
   * Where the lines go. Defaults to stdout, which is the only correct answer
   * in a container (INFRASTRUCTURE §8).
   *
   * Overridden only by tests, and only so they can assert on the REAL output
   * rather than on `redact()` in isolation — a configuration change that
   * bypassed the redaction choke point would pass a unit test of `redact` and
   * fail this one. That is worth a seam.
   */
  readonly destination?: DestinationStream
}

export const baseOptions = (config: LoggerConfig): LoggerOptions => ({
  level: config.level ?? resolveLevel(),

  base: {
    service: config.service,
    env: process.env.NODE_ENV ?? 'development',
    version: config.version ?? process.env.APP_VERSION ?? 'dev',
    /*
     * Deliberately NOT pid and hostname (pino's defaults). In a container the
     * pid is always 1 and the hostname is a scheduler-assigned id that changes
     * every deploy — noise on every line, in exchange for nothing.
     */
  },

  /*
   * ISO 8601 with milliseconds, UTC. pino's default is epoch milliseconds,
   * which is smaller but unreadable at the moment someone is reading logs
   * because something is wrong. Fiscal periods make the date semantically
   * load-bearing here (ADR-0012), so it is spelled out.
   */
  timestamp: () => `,"time":"${new Date().toISOString()}"`,

  formatters: {
    /* `level: "info"`, not `level: 30`. */
    level: (label) => ({ level: label }),

    /*
     * Every log object passes through redaction here. This is the single
     * choke point: there is no code path into the output that skips it.
     *
     * `redact` handles an Error at any depth by delegating to `redactError`,
     * so no `serializers.err` is configured. An earlier version set both, and
     * they fought: pino runs `formatters.log` BEFORE `serializers`, so
     * `redact` turned the Error into a plain object and the serializer then
     * received a non-Error and emitted `{name: "NonError", message:
     * "[object Object]"}` — losing the message it was there to preserve.
     * One choke point, not two.
     */
    log: (object) => redact(object) as Record<string, unknown>,
  },

  /*
   * The MESSAGE path, which formatters.log does not cover.
   *
   * pino applies `formatters.log` to the merge OBJECT only. The message
   * string and any %s interpolation arguments go straight to the output, so
   * until this hook existed:
   *
   *   log.info('auth failed: ' + header)      → emitted the header verbatim
   *   log.info({ok: 1}, 'token %s', jwt)      → emitted the jwt verbatim
   *
   * That is the most likely leak in practice, because interpolating a value
   * into a message is exactly what someone writes while debugging the thing
   * that is going wrong.
   *
   * Only the VALUE-SHAPE layer applies here. Key-name denial is meaningless
   * for free text, and the bounds belong to structured data — a truncated
   * message would hide the end of the sentence that explains the incident.
   */
  hooks: {
    logMethod(args: unknown[], method: (...a: unknown[]) => void): void {
      method.apply(
        this,
        args.map((arg) => (typeof arg === 'string' ? redactValueShapes(arg) : arg)),
      )
    },
  },

  /*
   * Correlation is injected rather than passed, so a call site that forgets
   * still produces a correlated line. See context.ts.
   */
  mixin: () => {
    const correlation = getCorrelation()
    return correlation ? { ...correlation } : {}
  },
})

export type Logger = PinoLogger

let root: Logger | undefined

/**
 * Creates the process-wide root logger. Called once, at startup.
 *
 * Idempotent by design: a second call returns the first logger rather than
 * building a second one, because two roots would mean two base-field sets and
 * a debugging session that goes in circles.
 */
export function initLogger(config: LoggerConfig): Logger {
  root ??= config.destination
    ? pino(baseOptions(config), config.destination)
    : pino(baseOptions(config))
  return root
}

/**
 * The root logger.
 *
 * Throws if `initLogger` has not run. A lazily-defaulted logger would silently
 * produce lines with the wrong service name for the first part of startup,
 * which is the window where startup failures actually happen.
 */
export function getLogger(): Logger {
  if (!root) {
    throw new Error('initLogger() must be called at startup before getLogger()')
  }
  return root
}

/** A child logger with fixed extra fields — one per module or job. */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(redact(bindings) as Record<string, unknown>)
}

/** Test seam. Resets the module-level root so a suite can build a fresh one. */
export function resetLoggerForTests(): void {
  root = undefined
}
