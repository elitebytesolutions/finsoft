import { Writable } from 'node:stream'

import { pino } from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  asSessionCorrelationId,
  extendCorrelation,
  getCorrelation,
  newRequestId,
  newSessionCorrelationId,
  withCorrelation,
} from './context.ts'
import { BUSINESS_EVENTS, logCommittedBusinessEvent } from './events.ts'
import { baseOptions, initLogger, resetLoggerForTests } from './logger.ts'
import { REDACTED } from './redact.ts'

/** Collects the JSON lines a logger writes, so the output can be asserted. */
function capture() {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)))
      callback()
    },
  })
  /*
   * Indexed access is checked (`noUncheckedIndexedAccess`), and a test that
   * silently reads `undefined` because nothing was logged would pass its
   * `not.toContain` assertions for the wrong reason. This throws instead.
   */
  const line = (index = 0): Record<string, unknown> => {
    const found = lines[index]
    if (!found) throw new Error(`expected a log line at index ${index}, got ${lines.length}`)
    return found
  }
  return { lines, stream, line }
}

describe('log line shape', () => {
  it('emits JSON with a level label, ISO timestamp and base fields', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api', version: '1.2.3' }), stream)

    log.info('started')

    expect(line().level).toBe('info')
    expect(line().service).toBe('api')
    expect(line().version).toBe('1.2.3')
    expect(line().msg).toBe('started')
    /* ISO 8601, not epoch millis — readable at the moment someone needs it. */
    expect(String(line().time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('omits pid and hostname, which are noise in a container', () => {
    const { stream, line } = capture()
    pino(baseOptions({ service: 'api' }), stream).info('x')
    expect(line().pid).toBeUndefined()
    expect(line().hostname).toBeUndefined()
  })
})

describe('redaction is not bypassable', () => {
  it('redacts a denied key passed directly to the logger', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)

    log.info({ user: 'asma', password: 'hunter2' }, 'sign-in attempt')

    expect(line().password).toBe(REDACTED)
    expect(JSON.stringify(line())).not.toContain('hunter2')
  })

  it('redacts a denied key nested several levels down', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)

    log.info({ a: { b: { c: { apiKey: 'sk_live_9999' } } } }, 'nested')

    expect(JSON.stringify(line())).not.toContain('sk_live_9999')
  })

  it('sanitises an error through the err serialiser', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)

    log.error(
      { err: Object.assign(new Error('connect failed'), { host: 'db.internal', port: 5432 }) },
      'database unreachable',
    )

    const serialised = JSON.stringify(line())
    expect(serialised).not.toContain('db.internal')
    expect(serialised).toContain('connect failed')
  })
})

describe('correlation', () => {
  it('attaches the ambient context to every line without being passed it', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)
    const requestId = newRequestId()

    withCorrelation({ requestId, tenantId: 'tenant-1' }, () => {
      log.info('inside')
    })

    expect(line().requestId).toBe(requestId)
    expect(line().tenantId).toBe('tenant-1')
  })

  it('adds nothing when there is no ambient context', () => {
    const { stream, line } = capture()
    pino(baseOptions({ service: 'worker' }), stream).info('outside')
    expect(line().requestId).toBeUndefined()
  })

  it('extends the context without leaking into a sibling scope', () => {
    const outer = { requestId: 'req-1' }

    withCorrelation(outer, () => {
      extendCorrelation({ tenantId: 'tenant-a' }, () => {
        expect(getCorrelation()?.tenantId).toBe('tenant-a')
      })
      /* The extension is scoped to its callback, not to the request. */
      expect(getCorrelation()?.tenantId).toBeUndefined()
    })
  })

  it('refuses to extend outside a correlation scope', () => {
    expect(() => extendCorrelation({ tenantId: 't' }, () => undefined)).toThrow(
      /outside a correlation scope/,
    )
  })
})

describe('session correlation id', () => {
  it('logs the approved correlation id and never a raw session id', () => {
    const { stream, line } = capture()
    const log = pino(baseOptions({ service: 'api' }), stream)
    const sessionCorrelationId = newSessionCorrelationId()

    withCorrelation({ requestId: newRequestId(), sessionCorrelationId }, () => {
      log.info({ sessionId: 'sess_raw_secret' }, 'request')
    })

    expect(line().sessionCorrelationId).toBe(sessionCorrelationId)
    expect(line().sessionId).toBe(REDACTED)
    expect(JSON.stringify(line())).not.toContain('sess_raw_secret')
  })

  it('mints a distinct id per session', () => {
    expect(newSessionCorrelationId()).not.toBe(newSessionCorrelationId())
  })

  /*
   * The guard that makes the rule mechanical rather than cultural: a raw
   * session id routed here throws instead of being logged.
   */
  it('rejects a value that is not a minted UUID', () => {
    expect(() => asSessionCorrelationId('sess_abc123')).toThrow(/never be used here/)
    expect(() => asSessionCorrelationId('')).toThrow()
  })

  it('accepts a minted id round-tripped through storage', () => {
    const minted = newSessionCorrelationId()
    expect(asSessionCorrelationId(String(minted))).toBe(minted)
  })
})

describe('business events', () => {
  beforeEach(() => resetLoggerForTests())

  it('rejects a name that is not ENTITY_PAST_TENSE', () => {
    initLogger({ service: 'api' })
    expect(() => logCommittedBusinessEvent({ event: 'salePosted' })).toThrow(/SCREAMING_SNAKE/)
    expect(() => logCommittedBusinessEvent({ event: 'SALE' })).toThrow()
    expect(() => logCommittedBusinessEvent({ event: 'sale_posted' })).toThrow()
  })

  it('accepts the convention', () => {
    initLogger({ service: 'api' })
    expect(() => logCommittedBusinessEvent({ event: 'SALE_POSTED' })).not.toThrow()
  })

  /*
   * The catalogue is deliberately sparse: a name appears only with the code
   * that raises it. SALE_POSTED is absent because nothing can post a sale yet.
   */
  it('does not pre-declare events for operations that do not exist', () => {
    expect(Object.keys(BUSINESS_EVENTS)).not.toContain('SALE_POSTED')
  })
})

describe('root logger lifecycle', () => {
  beforeEach(() => resetLoggerForTests())

  it('refuses to hand out a logger before startup configured one', async () => {
    const { getLogger } = await import('./logger.ts')
    expect(() => getLogger()).toThrow(/initLogger\(\)/)
  })

  it('is idempotent, so two callers cannot create two roots', () => {
    expect(initLogger({ service: 'api' })).toBe(initLogger({ service: 'worker' }))
  })
})
