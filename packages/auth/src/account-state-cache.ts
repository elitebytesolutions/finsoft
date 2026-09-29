import { Redis } from 'ioredis'
import { getAccountState, type AccountState } from '@finsoft/database/auth'
import { TenantContext } from '@finsoft/database'

/*
 * M1-X, L1. The guard refuses a token whose `perm_ver` claim is behind the
 * user's CURRENT permission version, and refuses when the user is not
 * ACTIVE or the tenant is not ACTIVE. PostgreSQL is the source of truth;
 * this is the short-TTL cache in front of it, exactly the shape
 * `session-cache.ts` already uses for `isSessionActiveCached` and for the
 * identical reason: the guard runs on every authenticated request, so a
 * fresh row read per request would be one extra round trip on the hottest
 * path in the system.
 *
 * Same fallback discipline as session-cache.ts: on a cache miss OR a Redis
 * error, fall back to PostgreSQL rather than failing closed. A Redis blip
 * must not read as "every account is suspended".
 */

const TTL_SECONDS = 15

let redis: Redis | undefined

function client(): Redis {
  if (redis) return redis
  const url = process.env['REDIS_URL']
  if (!url) throw new Error('REDIS_URL is not set')
  redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2_000 })
  redis.on('error', () => {
    // Swallowed deliberately, exactly as session-cache.ts and throttle.ts do:
    // every caller here already falls back to Postgres on any error.
  })
  return redis
}

export async function closeAccountStateCacheClient(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => undefined)
    redis = undefined
  }
}

function cacheKey(tenantId: string, userId: string): string {
  return `account-state:${tenantId}:${userId}`
}

interface CachedAccountState {
  readonly userStatus: string
  readonly tenantStatus: string
  readonly permissionVersion: number
}

export async function getAccountStateCached(
  tenantId: string,
  userId: string,
): Promise<AccountState | null> {
  const key = cacheKey(tenantId, userId)

  try {
    const cached = await client().get(key)
    if (cached !== null) {
      // A stored empty-object sentinel means "no such account" (see below) —
      // distinguished from a real state so a permanently-vanished user does
      // not read as ACTIVE.
      if (cached === '') return null
      return JSON.parse(cached) as CachedAccountState
    }
  } catch {
    // Fall through to Postgres.
  }

  const state = await TenantContext.run({ tenantId, userId }, () => getAccountState(userId))

  try {
    await client().set(key, state ? JSON.stringify(state) : '', 'EX', TTL_SECONDS)
  } catch {
    // Caching is an optimisation; losing it changes nothing about correctness.
  }

  return state
}

/**
 * Invalidated wherever an account's status or permission version changes
 * within this session's lifetime and the change must be visible before the
 * TTL — not currently called anywhere (no such write path exists yet in
 * M1-X's scope), but exported so a future permission-management endpoint has
 * it ready, exactly as `invalidateSessionCache` exists for logout.
 */
export async function invalidateAccountStateCache(tenantId: string, userId: string): Promise<void> {
  try {
    await client().del(cacheKey(tenantId, userId))
  } catch {
    // Best-effort: the TTL bound still holds even if this fails.
  }
}
