import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, login, logout, me, refresh } from '@/lib/api/client'
import { setAccessToken, getAccessToken } from '@/lib/api/session'
import { ApiError } from '@/lib/api/types'

/*
 * Exercises the API client's contract directly against a mocked `fetch` —
 * the single-flight refresh, the 401-refresh-retry path, 403 handling, and
 * logout — per the M1-W brief's acceptance criteria 3-5. No component, no
 * router: this is the transport layer on its own.
 */

const USER = { id: 'u1', fullName: 'Test User', email: 'test.user@example.com' }
const TENANT = { id: 't1', code: 'TEST', name: 'Test Tenant' }

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function emptyResponse(status: number): Response {
  return new Response(null, { status })
}

function authHeader(init?: RequestInit): string | null {
  const headers = init?.headers
  if (headers instanceof Headers) return headers.get('Authorization')
  if (Array.isArray(headers)) return headers.find(([k]) => k === 'Authorization')?.[1] ?? null
  return (headers as Record<string, string> | undefined)?.Authorization ?? null
}

describe('lib/api/client', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setAccessToken(null)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('login', () => {
    it('stores the access token and returns the session on success', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'tok-1', expiresIn: 900, user: USER, tenant: TENANT }),
      )

      const session = await login({ tenantCode: 'ACME', email: USER.email, password: 'x' })

      expect(session.user).toEqual(USER)
      expect(getAccessToken()).toBe('tok-1')
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      )
    })

    it('throws a generic invalid_credentials error on 401 — never which field was wrong', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_credentials' }))

      const err = await login({ tenantCode: 'ACME', email: 'a@b.com', password: 'x' }).catch(
        (e: unknown) => e,
      )

      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('invalid_credentials')
      expect(getAccessToken()).toBeNull()
    })

    it('throws a rate_limited error carrying the Retry-After seconds on 429', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '42' }))

      const err = await login({ tenantCode: 'ACME', email: 'a@b.com', password: 'x' }).catch(
        (e: unknown) => e,
      )

      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('rate_limited')
      expect((err as ApiError).retryAfterSeconds).toBe(42)
    })

    it('throws a network_error when fetch itself rejects', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'))

      const err = await login({ tenantCode: 'ACME', email: 'a@b.com', password: 'x' }).catch(
        (e: unknown) => e,
      )

      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('network_error')
    })
  })

  describe('refresh — single in-flight per tab', () => {
    it('collapses concurrent refresh() callers into exactly one network call', async () => {
      let refreshCalls = 0
      fetchMock.mockImplementation((url: string) => {
        if (url === '/api/auth/refresh') {
          refreshCalls++
          return new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(
                  jsonResponse(200, {
                    accessToken: 'tok-2',
                    expiresIn: 900,
                    user: USER,
                    tenant: TENANT,
                  }),
                ),
              10,
            ),
          )
        }
        throw new Error(`unexpected fetch: ${url}`)
      })

      const results = await Promise.all([refresh(), refresh(), refresh()])

      expect(refreshCalls).toBe(1)
      expect(results).toEqual([true, true, true])
      expect(getAccessToken()).toBe('tok-2')
    })

    it('a failed refresh clears the token and resolves false, never throwing', async () => {
      setAccessToken('stale')
      fetchMock.mockResolvedValueOnce(emptyResponse(401))

      await expect(refresh()).resolves.toBe(false)
      expect(getAccessToken()).toBeNull()
    })
  })

  describe('apiFetch — 401 refresh-and-retry, 403 forbidden', () => {
    it('two concurrent 401s from different endpoints share one refresh, then both succeed', async () => {
      setAccessToken('stale-token')
      let refreshCalls = 0

      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/auth/refresh') {
          refreshCalls++
          return Promise.resolve(
            jsonResponse(200, {
              accessToken: 'fresh-token',
              expiresIn: 900,
              user: USER,
              tenant: TENANT,
            }),
          )
        }
        if (authHeader(init) === 'Bearer fresh-token') {
          return Promise.resolve(jsonResponse(200, { path: url }))
        }
        return Promise.resolve(emptyResponse(401))
      })

      const [a, b] = await Promise.all([
        apiFetch<{ path: string }>('/api/widgets/a'),
        apiFetch<{ path: string }>('/api/widgets/b'),
      ])

      expect(refreshCalls).toBe(1)
      expect(a).toEqual({ path: '/api/widgets/a' })
      expect(b).toEqual({ path: '/api/widgets/b' })
    })

    it('a second 401 after a failed refresh throws session_expired', async () => {
      setAccessToken('stale-token')
      fetchMock.mockImplementation((url: string) => {
        if (url === '/api/auth/refresh') return Promise.resolve(emptyResponse(401))
        return Promise.resolve(emptyResponse(401))
      })

      const err = await apiFetch('/api/widgets/a').catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('session_expired')
    })

    it('a 403 throws forbidden without attempting a refresh', async () => {
      setAccessToken('tok')
      fetchMock.mockResolvedValueOnce(emptyResponse(403))

      const err = await apiFetch('/api/widgets/a').catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('forbidden')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('me() drives the silent-refresh-on-load path with no token in memory', async () => {
      // No access token set — matches a fresh page load.
      let refreshCalls = 0
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/auth/refresh') {
          refreshCalls++
          return Promise.resolve(
            jsonResponse(200, {
              accessToken: 'restored-token',
              expiresIn: 900,
              user: USER,
              tenant: TENANT,
            }),
          )
        }
        if (url === '/api/auth/me' && authHeader(init) === 'Bearer restored-token') {
          return Promise.resolve(
            jsonResponse(200, {
              user: USER,
              tenant: TENANT,
              sessionId: 's1',
              permissionVersion: 1,
            }),
          )
        }
        return Promise.resolve(emptyResponse(401))
      })

      const session = await me()

      expect(refreshCalls).toBe(1)
      expect(session.user).toEqual(USER)
    })
  })

  describe('logout', () => {
    it('clears the in-memory token even if the request fails', async () => {
      setAccessToken('tok')
      fetchMock.mockRejectedValueOnce(new TypeError('network down'))

      await logout()

      expect(getAccessToken()).toBeNull()
    })

    it('sends the X-Requested-With header the fixed contract requires', async () => {
      setAccessToken('tok')
      fetchMock.mockResolvedValueOnce(emptyResponse(204))

      await logout()

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/logout',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          headers: expect.objectContaining({ 'X-Requested-With': 'finsoft' }),
        }),
      )
      expect(getAccessToken()).toBeNull()
    })
  })
})
