import { Redis } from 'ioredis'
import { isSessionActive } from '@finsoft/database/auth'
import { TenantContext } from '@finsoft/database'

/*
 * ADR-0009:122: "the guard checks the session is ACTIVE — a cached lookup
 * (Redis), with a short TTL, falling back to PostgreSQL, which remains the
 * source of truth." Revocation is therefore immediate in Postgres and
 * bounded by this TTL (plus the access token's own remaining life) at the
 * guard.
 *
 * On a cache miss OR a Redis error, this falls back to PostgreSQL rather
 * than failing closed — unlike the login/refresh throttle. The guard runs on
 * every authenticated request in the system; treating a Redis blip as
 * "everyone is logged out" is a much larger blast radius than the small
 * window this cache is buying, and PostgreSQL is already the source of
 * truth this falls back to.
 */

const TTL_SECONDS = 15

let redis: Redis | undefined

function client(): Redis {
  if (redis) return redis
  const url = process.env['REDIS_URL']
  if (!url) throw new Error('REDIS_URL is not set')
  // Offline queueing left ON — see throttle.ts's identical note. This cache
  // falls back to Postgres on any error regardless, but there is no reason
  // to manufacture one out of the normal post-construction handshake delay.
  redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2_000 })
  redis.on('error', () => {
    // See throttle.ts's identical note: swallowed so a Redis blip cannot
    // crash the process. Every caller here already falls back to Postgres.
  })
  return redis
}

export async function closeSessionCacheClient(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => undefined)
    redis = undefined
  }
}

function cacheKey(tenantId: string, sessionId: string): string {
  return `session:active:${tenantId}:${sessionId}`
}

export async function isSessionActiveCached(
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const key = cacheKey(tenantId, sessionId)

  try {
    const cached = await client().get(key)
    if (cached !== null) return cached === '1'
  } catch {
    // Fall through to Postgres.
  }

  const active = await TenantContext.run({ tenantId, userId }, () => isSessionActive(sessionId))

  try {
    await client().set(key, active ? '1' : '0', 'EX', TTL_SECONDS)
  } catch {
    // Caching is an optimisation; losing it changes nothing about correctness.
  }

  return active
}

/** Logout invalidates the cache immediately rather than waiting out the TTL. */
export async function invalidateSessionCache(tenantId: string, sessionId: string): Promise<void> {
  try {
    await client().del(cacheKey(tenantId, sessionId))
  } catch {
    // Best-effort: the TTL bound still holds even if this fails.
  }
}
