import { Writable } from 'node:stream'

import { getCorrelation, initLogger, resetLoggerForTests } from '@finsoft/observability'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleHeartbeat, type HeartbeatPayload } from './jobs/heartbeat.ts'
import { OutageTracker } from './outage.ts'
import type { Job } from './queue.ts'
import { withJobContext } from './runner.ts'

/*
 * No Redis here. These exercise the wrapper that every handler runs inside —
 * correlation, logging, and error propagation — which is logic, not
 * integration. The queue itself is proven against a real Redis by the
 * compose stack, not by a mock that would agree with whatever it was told.
 */

function fakeJob<T>(data: T, overrides: Partial<Job<T>> = {}): Job<T> {
  return { id: '1', attemptsMade: 0, data, opts: { attempts: 5 }, ...overrides } as Job<T>
}

let lines: Record<string, unknown>[]

beforeEach(() => {
  resetLoggerForTests()
  lines = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)))
      callback()
    },
  })
  initLogger({ service: 'worker', destination: stream })
})

afterEach(() => resetLoggerForTests())

describe('correlation across the queue hop', () => {
  it('re-establishes the producing request id inside the handler', async () => {
    let seen: string | undefined

    const run = withJobContext<HeartbeatPayload>('heartbeat', async () => {
      seen = getCorrelation()?.requestId
      return Promise.resolve()
    })

    await run(
      fakeJob<HeartbeatPayload>({
        correlationId: 'req-from-api',
        enqueuedAt: new Date().toISOString(),
      }),
    )

    expect(seen).toBe('req-from-api')
  })

  it('carries tenant and job name into the log lines', async () => {
    const run = withJobContext<HeartbeatPayload>('heartbeat', () => Promise.resolve())

    await run(
      fakeJob<HeartbeatPayload>({
        correlationId: 'req-1',
        tenantId: 'tenant-9',
        enqueuedAt: new Date().toISOString(),
      }),
    )

    const started = lines.find((l) => l.msg === 'job started')
    expect(started?.requestId).toBe('req-1')
    expect(started?.tenantId).toBe('tenant-9')
    expect(started?.jobName).toBe('heartbeat')
  })

  /*
   * A job with no correlation id is a bug in whatever enqueued it. Minting a
   * fresh one here would produce a trace that looks complete and joins to
   * nothing — discovered months later, during an incident.
   */
  it('refuses a job with no correlation id rather than minting one', async () => {
    const handler = vi.fn(() => Promise.resolve())
    const run = withJobContext('heartbeat', handler)

    await expect(
      run(fakeJob({ correlationId: '', enqueuedAt: new Date().toISOString() })),
    ).rejects.toThrow(/no correlationId/)

    expect(handler).not.toHaveBeenCalled()
  })
})

describe('failure handling', () => {
  it('re-throws so BullMQ retries, rather than reporting success', async () => {
    const run = withJobContext('heartbeat', () => Promise.reject(new Error('smtp refused')))

    await expect(
      run(fakeJob({ correlationId: 'req-1', enqueuedAt: new Date().toISOString() })),
    ).rejects.toThrow('smtp refused')
  })

  it('logs the failure with correlation and a sanitised error', async () => {
    const run = withJobContext('heartbeat', () =>
      Promise.reject(
        Object.assign(new Error('connect failed'), { host: 'redis.internal', port: 6379 }),
      ),
    )

    await run(fakeJob({ correlationId: 'req-1', enqueuedAt: new Date().toISOString() })).catch(
      () => undefined,
    )

    const failed = lines.find((l) => l.msg === 'job failed')
    expect(failed?.requestId).toBe('req-1')

    /* The logger's redaction applies to worker logs exactly as it does to the API's. */
    const serialised = JSON.stringify(failed)
    expect(serialised).toContain('connect failed')
    expect(serialised).not.toContain('redis.internal')
  })

  it('records the attempt number, so a retry is distinguishable from a first run', async () => {
    const run = withJobContext('heartbeat', () => Promise.reject(new Error('nope')))

    await run(
      fakeJob(
        { correlationId: 'req-1', enqueuedAt: new Date().toISOString() },
        { attemptsMade: 2 },
      ),
    ).catch(() => undefined)

    expect(lines.find((l) => l.msg === 'job failed')?.attempt).toBe(3)
  })
})

describe('heartbeat handler', () => {
  it('measures queue latency from the enqueue time, not from log timestamps', async () => {
    const enqueuedAt = new Date(Date.now() - 1_500).toISOString()

    await handleHeartbeat(fakeJob<HeartbeatPayload>({ correlationId: 'req-1', enqueuedAt }))

    const beat = lines.find((l) => l.msg === 'heartbeat')
    expect(Number(beat?.queueLatencyMs)).toBeGreaterThanOrEqual(1_400)
  })

  it('does not blow up on an unparseable enqueue time', async () => {
    await handleHeartbeat(
      fakeJob<HeartbeatPayload>({ correlationId: 'req-1', enqueuedAt: 'not a date' }),
    )

    expect(lines.find((l) => l.msg === 'heartbeat')?.queueLatencyMs).toBeUndefined()
  })
})

describe('outage de-duplication', () => {
  /*
   * Found by running the worker image against an unreachable Redis: BullMQ's
   * error event fires on every reconnect attempt, and the first version
   * logged all of them — two identical lines a second, about 172,000 a day.
   * A repeating failure gets one line, not one per attempt.
   */
  it('logs the first failure and stays quiet for the rest', () => {
    const outage = new OutageTracker('down', 'up')

    for (let i = 0; i < 50; i += 1) outage.recordFailure({ attempt: i })

    expect(lines.filter((l) => l.msg === 'down')).toHaveLength(1)
    expect(outage.isFailing).toBe(true)
  })

  it('reports the shape of the outage on recovery', () => {
    const outage = new OutageTracker('down', 'up')

    outage.recordFailure({})
    outage.recordFailure({})
    outage.recordFailure({})
    outage.recordSuccess()

    const recovery = lines.find((l) => l.msg === 'up')
    expect(recovery?.failedAttempts).toBe(3)
    expect(Number(recovery?.outageMs)).toBeGreaterThanOrEqual(0)
    expect(outage.isFailing).toBe(false)
  })

  it('says nothing on a success that follows no failure', () => {
    new OutageTracker('down', 'up').recordSuccess()
    expect(lines.filter((l) => l.msg === 'up')).toHaveLength(0)
  })

  it('logs again for a SECOND outage, rather than staying quiet forever', () => {
    const outage = new OutageTracker('down', 'up')

    outage.recordFailure({})
    outage.recordSuccess()
    outage.recordFailure({})

    expect(lines.filter((l) => l.msg === 'down')).toHaveLength(2)
  })
})
