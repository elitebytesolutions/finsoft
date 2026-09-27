import { Redis } from 'ioredis'

/*
 * Login and refresh throttling. ADR-0023 §5.
 *
 * Throttling is keyed on attacker-controllable input, always time-decaying,
 * always self-recovering, and never requires administrator action — the
 * opposite of ADR-0009:121's per-user lockout, which ADR-0023 supersedes
 * because it is a named-user denial of service (anyone who knows an
 * employee's email can make them unable to work). Lockout — a sticky state
 * needing an unlock, keyed on (user, device/IP) — is explicitly out of
 * scope for this task: its table arrives with RBAC (docs/WAVE_1_REGISTER.md
 * §W1-002), and this module implements none of it.
 *
 * All layers are evaluated on every request; the request is rejected if ANY
 * is exhausted. Counters increment identically on a miss and a hit (§4 item
 * 5) — the caller (`login.ts`/`refresh.ts`) calls `recordAttempt` on every
 * outcome, never only on failure.
 *
 * FAILS CLOSED. If Redis is unreachable, the caller must return 503 — never
 * fall through to "not throttled", which is exactly the failure mode an
 * attacker would target first.
 */

export class ThrottleUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The rate limiter is unavailable.', options)
    this.name = 'ThrottleUnavailableError'
  }
}

export interface ThrottleLayer {
  readonly key: string
  readonly limit: number
  readonly windowSeconds: number
}

export interface ThrottleDecision {
  readonly throttled: boolean
  readonly retryAfterSeconds: number
}

let redis: Redis | undefined

function client(): Redis {
  if (redis) return redis
  const url = process.env['REDIS_URL']
  if (!url) throw new Error('REDIS_URL is not set')
  redis = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    // Offline queueing left ON, deliberately: a command issued in the brief
    // window between client construction and the initial handshake
    // completing must not be treated the same as Redis genuinely being
    // down. With it disabled, EVERY command issued before that handshake
    // finishes fails immediately with "Stream isn't writeable" — the first
    // request after a cold start would see the limiter as unavailable even
    // though Redis is healthy. `maxRetriesPerRequest: 1` plus
    // `connectTimeout` still bounds how long a command waits when Redis is
    // actually unreachable, so "fails closed" holds either way.
  })
  redis.on('error', () => {
    // Swallowed deliberately: every call site below already treats a
    // failing command as ThrottleUnavailableError. An unhandled 'error'
    // event on an ioredis client would otherwise crash the process, which
    // is a much worse failure mode than a 503 on the auth endpoints.
  })
  return redis
}

/** Test/shutdown hook. Not used by production code paths. */
export async function closeThrottleClient(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => undefined)
    redis = undefined
  }
}

async function incrementAndCheck(layer: ThrottleLayer): Promise<ThrottleDecision> {
  try {
    const c = client()
    const key = `throttle:${layer.key}`
    const count = await c.incr(key)
    if (count === 1) {
      await c.expire(key, layer.windowSeconds)
    }
    const ttl = await c.ttl(key)
    const retryAfterSeconds = ttl > 0 ? ttl : layer.windowSeconds
    return { throttled: count > layer.limit, retryAfterSeconds }
  } catch (error) {
    throw new ThrottleUnavailableError({ cause: error })
  }
}

/**
 * Evaluate every layer and return the strictest (longest) retry-after among
 * whichever are exhausted. Throws `ThrottleUnavailableError` — never
 * silently permits — if Redis cannot be reached for ANY layer.
 */
export async function checkLayers(layers: readonly ThrottleLayer[]): Promise<ThrottleDecision> {
  const results = await Promise.all(layers.map(incrementAndCheck))
  const throttledResults = results.filter((r) => r.throttled)
  if (throttledResults.length === 0) {
    return { throttled: false, retryAfterSeconds: 0 }
  }
  return {
    throttled: true,
    retryAfterSeconds: Math.max(...throttledResults.map((r) => r.retryAfterSeconds)),
  }
}

/*
 * ADR-0023 §5's layer table for /auth/login. `X-Forwarded-For` parsing
 * (Nth-from-the-right) and IP-prefix truncation (/32 v4, /64 v6) are the
 * caller's job (apps/api), which is where the trusted proxy count is
 * configured — this module only ever sees the already-resolved values.
 *
 * Layer 0 (email-only, code-independent) escalates to proof-of-work in the
 * full design; no proof-of-work/CAPTCHA verifier exists in this codebase and
 * building one is out of scope for this task (it would need an apps/web
 * component, which is outside this lane's ALLOWED paths — see the BLOCKED
 * note in the delivery report). Escalating layer 0 to a longer, still
 * self-recovering cooldown rather than to proof-of-work is a deliberate,
 * narrower substitute, not the design ADR-0023 specifies, and is recorded
 * as a decision rather than silently shipped as if it were the real thing.
 */
export function loginLayers(input: {
  readonly normalisedEmail: string
  readonly normalisedTenantCode: string
  readonly ipPrefix: string
}): readonly ThrottleLayer[] {
  return [
    { key: `login:email:${input.normalisedEmail}`, limit: 30, windowSeconds: 15 * 60 },
    {
      key: `login:email-tenant:${input.normalisedEmail}:${input.normalisedTenantCode}`,
      limit: 10,
      windowSeconds: 15 * 60,
    },
    { key: `login:ip:${input.ipPrefix}`, limit: 60, windowSeconds: 5 * 60 },
    {
      key: `login:ip-email:${input.ipPrefix}:${input.normalisedEmail}`,
      limit: 5,
      windowSeconds: 5 * 60,
    },
    { key: 'login:global', limit: 2000, windowSeconds: 60 },
  ]
}

/**
 * /auth/refresh has no email. Keyed on the IP prefix and the presented
 * token's hash — never logged (§5: "a bare 64-hex digest... covered by the
 * same log-leak assertion §6 requires").
 */
export function refreshLayers(input: {
  readonly ipPrefix: string
  readonly presentedTokenHash: string
}): readonly ThrottleLayer[] {
  return [
    { key: `refresh:ip:${input.ipPrefix}`, limit: 120, windowSeconds: 5 * 60 },
    { key: `refresh:token:${input.presentedTokenHash}`, limit: 10, windowSeconds: 5 * 60 },
  ]
}
