/*
 * @finsoft/observability — structured logging for api and worker.
 *
 * Not importable by the kernels (ARCHITECTURE §5: a kernel imports database,
 * validation and shared-types, and nothing else) and not by `apps/web`, which
 * runs in a browser where a server logger has no meaning. See ADR-0016.
 */

export {
  asSessionCorrelationId,
  extendCorrelation,
  getCorrelation,
  newRequestId,
  newSessionCorrelationId,
  withCorrelation,
  type CorrelationContext,
  type SessionCorrelationId,
} from './context.ts'

export {
  BUSINESS_EVENTS,
  logCommittedBusinessEvent,
  type BusinessEvent,
  type BusinessEventName,
} from './events.ts'

export {
  baseOptions,
  childLogger,
  getLogger,
  initLogger,
  resetLoggerForTests,
  type Logger,
  type LoggerConfig,
  type LogLevel,
} from './logger.ts'

export {
  isDeniedKey,
  redact,
  redactError,
  redactValueShapes,
  REDACTED,
  type SanitisedError,
} from './redact.ts'
