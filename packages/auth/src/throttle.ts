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
 * All layers are evaluated on every request; a BLOCKING layer that is
 * exhausted rejects the request. A non-blocking layer (§5 layer 4, the
 * global rate) never rejects — it only reports itself in `alertedLayers` so
 * the caller can log a business event / emit a metric (B4, security
 * re-review: "never a hard block — a global block is self-DoS and is the
 * attacker's actual goal").
 *
 * Counters increment identically on a miss and a hit (§4 item 5) — every
 * layer is incremented before its outcome is evaluated, for every request,
 * regardless of whether the credential turns out to be valid.
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
  /** Defaults to `true`. `false` = alert-only (ADR-0023 §5 layer 4). */
  readonly blocking?: boolean
  /**
   * Defaults to `false`. `true` for layers keyed on the victim's own
   * identity (email, email+tenant, ip+email) — the ones a HashingQueueFullError
   * must not spend, since a full hashing queue is a capacity problem, not
   * something the account did (see `refundLayers`).
   */
  readonly accountKeyed?: boolean
}

export interface ThrottleDecision {
  readonly throttled: boolean
  readonly retryAfterSeconds: number
  /** Non-blocking layers that were exhausted on this call, for the caller to log/alert on. */
  readonly alertedLayers: readonly string[]
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

/*
 * C6: INCR and EXPIRE atomically, via a Lua script run server-side, rather
 * than two round trips. Two separate commands leave a window — a process
 * crash, a network partition, or simply two requests interleaving between
 * them — in which a key can be INCRemented to 1 and never get its EXPIRE,
 * becoming a TTL-less counter that then blocks its key FOREVER (Redis TTL
 * -1 means "no expiry"). A Lua script is a single atomic operation from
 * Redis's point of view: no other command can run between the INCR and the
 * conditional EXPIRE inside it.
 */
const INCR_AND_EXPIRE_IF_NEW = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  local ttl = redis.call('TTL', KEYS[1])
  return {count, ttl}
`

interface LayerResult {
  readonly key: string
  readonly blocking: boolean
  readonly exhausted: boolean
  readonly retryAfterSeconds: number
}

async function incrementAndCheck(layer: ThrottleLayer): Promise<LayerResult> {
  try {
    const key = `throttle:${layer.key}`
    const [count, ttl] = (await client().eval(
      INCR_AND_EXPIRE_IF_NEW,
      1,
      key,
      layer.windowSeconds,
    )) as [number, number]
    const retryAfterSeconds = ttl > 0 ? ttl : layer.windowSeconds
    return {
      key: layer.key,
      blocking: layer.blocking ?? true,
      exhausted: count > layer.limit,
      retryAfterSeconds,
    }
  } catch (error) {
    throw new ThrottleUnavailableError({ cause: error })
  }
}

/**
 * N5, security re-review 2026-09-27: an alert-only layer (§5 layer 4) is
 * exhausted on EVERY request once past its limit, for as long as volume
 * stays high — without this, "log a business event" becomes "log one every
 * request", which floods the very channel an on-call engineer needs during
 * the incident it's meant to signal. `SET NX EX` is the dedup: the first
 * caller to observe the layer exhausted within a window wins the alert: the
 * rest see the key already set and skip it, atomically (SET NX is a single
 * command, so there is no separate check-then-set race here).
 */
const ALERT_DEDUP_SECONDS = 60

async function shouldAlert(layerKey: string): Promise<boolean> {
  try {
    const result = await client().set(
      `throttle:alerted:${layerKey}`,
      '1',
      'EX',
      ALERT_DEDUP_SECONDS,
      'NX',
    )
    return result === 'OK'
  } catch {
    // The alert itself is best-effort; a Redis hiccup here must not turn an
    // alert-only layer into something that affects the request's outcome.
    return false
  }
}

/**
 * Evaluate every layer. A BLOCKING layer that is exhausted makes the whole
 * call `throttled`; a non-blocking layer that is exhausted never does, and
 * is reported in `alertedLayers` — deduplicated to at most once per
 * `ALERT_DEDUP_SECONDS` window (N5) — instead. Throws
 * `ThrottleUnavailableError` — never silently permits — if Redis cannot be
 * reached for ANY layer.
 */
export async function checkLayers(layers: readonly ThrottleLayer[]): Promise<ThrottleDecision> {
  const results = await Promise.all(layers.map(incrementAndCheck))

  const blockingExhausted = results.filter((r) => r.exhausted && r.blocking)
  const nonBlockingExhausted = results.filter((r) => r.exhausted && !r.blocking)
  const alertDecisions = await Promise.all(nonBlockingExhausted.map((r) => shouldAlert(r.key)))
  const alertedLayers = nonBlockingExhausted.filter((_, i) => alertDecisions[i]).map((r) => r.key)

  if (blockingExhausted.length === 0) {
    return { throttled: false, retryAfterSeconds: 0, alertedLayers }
  }
  return {
    throttled: true,
    retryAfterSeconds: Math.max(...blockingExhausted.map((r) => r.retryAfterSeconds)),
    alertedLayers,
  }
}

/**
 * Item 1d, security re-review: `HashingQueueFullError` is a capacity
 * problem, not something the account did, so the account-keyed layers this
 * request already incremented must be given back — a full hashing queue
 * must not spend a legitimate user's throttle budget. IP-only and global
 * layers are NOT refunded: volume from an IP, or globally, is exactly what
 * those layers exist to track regardless of why an individual request
 * failed.
 */
export async function refundLayers(layers: readonly ThrottleLayer[]): Promise<void> {
  const toRefund = layers.filter((l) => l.accountKeyed)
  await Promise.all(
    toRefund.map((l) =>
      client()
        .decr(`throttle:${l.key}`)
        .catch(() => undefined),
    ),
  )
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
 *
 * Layer 4 (global) is `blocking: false` (B4, security re-review): ADR-0023
 * §5 is explicit that this layer is "alert and global slowdown, never a
 * hard block — a global block is self-DoS and is the attacker's actual
 * goal". The "slowdown" half is not implemented here (it would need a
 * latency-injection mechanism this task does not build); the "never a hard
 * block, always alert" half is.
 */
export function loginLayers(input: {
  readonly normalisedEmail: string
  readonly normalisedTenantCode: string
  readonly ipPrefix: string
}): readonly ThrottleLayer[] {
  return [
    {
      key: `login:email:${input.normalisedEmail}`,
      limit: 30,
      windowSeconds: 15 * 60,
      accountKeyed: true,
    },
    {
      key: `login:email-tenant:${input.normalisedEmail}:${input.normalisedTenantCode}`,
      limit: 10,
      windowSeconds: 15 * 60,
      accountKeyed: true,
    },
    { key: `login:ip:${input.ipPrefix}`, limit: 60, windowSeconds: 5 * 60 },
    {
      key: `login:ip-email:${input.ipPrefix}:${input.normalisedEmail}`,
      limit: 5,
      windowSeconds: 5 * 60,
      accountKeyed: true,
    },
    { key: 'login:global', limit: 2000, windowSeconds: 60, blocking: false },
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
