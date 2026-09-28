import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkLayers, closeThrottleClient, refundLayers, type ThrottleLayer } from './throttle.ts'

/*
 * N5 (alert dedup) and item 1d (refund on a full hashing queue), security
 * re-review 2026-09-27.
 */

beforeAll(() => {
  const envPath = resolve(import.meta.dirname, '..', '..', '..', '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
  process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6412'
})

afterAll(async () => {
  await closeThrottleClient()
})

function uniqueLayer(overrides: Partial<ThrottleLayer> = {}): ThrottleLayer {
  return {
    key: `test:${Math.random().toString(36).slice(2)}`,
    limit: 0, // exhausted on the very first increment
    windowSeconds: 60,
    blocking: false,
    ...overrides,
  }
}

describe('checkLayers — alert dedup (N5)', () => {
  it('reports a newly-exhausted non-blocking layer in alertedLayers exactly once, then suppresses it', async () => {
    const layer = uniqueLayer()

    const first = await checkLayers([layer])
    expect(first.throttled, 'non-blocking layers never throttle').toBe(false)
    expect(first.alertedLayers).toEqual([layer.key])

    const second = await checkLayers([layer])
    expect(
      second.alertedLayers,
      'the SAME layer, still exhausted, must not alert again within the dedup window',
    ).toEqual([])

    const third = await checkLayers([layer])
    expect(third.alertedLayers).toEqual([])
  })

  it('alerts independently per layer key', async () => {
    const a = uniqueLayer()
    const b = uniqueLayer()

    const result = await checkLayers([a, b])
    expect(new Set(result.alertedLayers)).toEqual(new Set([a.key, b.key]))
  })

  it('a blocking layer that is exhausted is never reported in alertedLayers', async () => {
    const layer = uniqueLayer({ blocking: true })
    const result = await checkLayers([layer])
    expect(result.throttled).toBe(true)
    expect(result.alertedLayers).toEqual([])
  })
})

describe('refundLayers (item 1d)', () => {
  async function counterValue(key: string): Promise<number> {
    const redis = new Redis(process.env['REDIS_URL'] as string)
    try {
      const value = await redis.get(`throttle:${key}`)
      return value ? Number(value) : 0
    } finally {
      await redis.quit()
    }
  }

  it('decrements only account-keyed layers, leaving IP/global layers untouched', async () => {
    const accountKeyed = uniqueLayer({ limit: 100, accountKeyed: true })
    const ipKeyed = uniqueLayer({ limit: 100, accountKeyed: false })

    await checkLayers([accountKeyed, ipKeyed]) // both -> 1
    await checkLayers([accountKeyed, ipKeyed]) // both -> 2

    expect(await counterValue(accountKeyed.key)).toBe(2)
    expect(await counterValue(ipKeyed.key)).toBe(2)

    await refundLayers([accountKeyed, ipKeyed])

    expect(await counterValue(accountKeyed.key), 'account-keyed layer must be refunded').toBe(1)
    expect(await counterValue(ipKeyed.key), 'IP/global layers are never refunded').toBe(2)
  })

  it('a HashingQueueFullError-triggered refund gives back exactly what THIS request spent', async () => {
    const layer = uniqueLayer({ limit: 100, accountKeyed: true })
    await checkLayers([layer]) // this "request" increments once
    expect(await counterValue(layer.key)).toBe(1)

    await refundLayers([layer])
    expect(await counterValue(layer.key), 'back to zero — as if this request never happened').toBe(
      0,
    )
  })
})
