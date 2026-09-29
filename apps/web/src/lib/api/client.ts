/* The one place apps/web talks to the API. Same-origin `/api` base — in production the
 * Caddy proxy routes it, in local dev `next.config.mjs` rewrites it — so ADR-0009's
 * SameSite=Strict refresh cookie is ever sent at all (a cross-origin call would drop it
 * silently, which fails in a way that looks like an auth bug and is actually a proxy bug).
 *
 * Nothing here decides a number or a permission. It moves bytes and translates transport
 * failures into the typed `ApiError` screens branch on. */
import { getAccessToken, notifyForbidden, setAccessToken } from './session'
import { ApiError, type LoginRequest, type LoginResponse, type MeResponse } from './types'

const REQUESTED_WITH_HEADER = 'X-Requested-With'
const REQUESTED_WITH_VALUE = 'finsoft'

async function parseJsonSafe(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function toMessage(body: Record<string, unknown> | null, fallback: string): string {
  const message = body?.message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

function networkError(cause: unknown): ApiError {
  return new ApiError(
    'network_error',
    'Could not reach the server. Check your connection and try again.',
    { cause },
  )
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init)
  } catch (cause) {
    throw networkError(cause)
  }
}

/**
 * `POST /api/auth/login`. Never retried automatically — a login failure is shown, not
 * silently re-attempted, per docs/design-system/pages/login/README.md §6.
 */
export async function login(credentials: LoginRequest): Promise<LoginResponse> {
  const res = await rawFetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  })

  if (res.status === 429) {
    const body = await parseJsonSafe(res)
    const retryAfterHeader = res.headers.get('Retry-After')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
    throw new ApiError('rate_limited', toMessage(body, 'Too many attempts. Try again later.'), {
      status: 429,
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    })
  }

  if (res.status === 401) {
    const body = await parseJsonSafe(res)
    throw new ApiError(
      'invalid_credentials',
      toMessage(body, 'Incorrect tenant code, email or password.'),
      { status: 401 },
    )
  }

  if (res.status === 400) {
    // apps/api/src/common/zod-validation.pipe.ts: {error:'validation_failed', message,
    // details:[{path,code,message}]}. Client-side validation already covers presence and
    // email shape (screens/login.tsx), so this is the edge the form check does not
    // reach — e.g. a tenantCode shape the server rejects. `details` rides along so a
    // caller can map a path to a field; the login screen currently just renders `message`
    // as a form-level banner, which is still the server's rejection, verbatim.
    const body = await parseJsonSafe(res)
    const details = Array.isArray(body?.details)
      ? (body.details as Array<{ path?: unknown; code?: unknown; message?: unknown }>)
          .filter((d) => typeof d.path === 'string' && typeof d.message === 'string')
          .map((d) => ({ path: d.path as string, message: d.message as string }))
      : undefined
    throw new ApiError(
      'validation_failed',
      toMessage(body, 'The request body did not match the expected shape.'),
      { status: 400, details },
    )
  }

  if (!res.ok) {
    const body = await parseJsonSafe(res)
    throw new ApiError('unknown', toMessage(body, `Sign in failed (${res.status}).`), {
      status: res.status,
    })
  }

  const data = (await res.json()) as LoginResponse
  setAccessToken(data.accessToken)
  return data
}

/**
 * `POST /api/auth/logout`. Best-effort against the server; local state always clears.
 *
 * `/auth/logout` is NOT `@Public()` (apps/api/src/auth/auth.controller.ts) — `TenantGuard`
 * rejects it with 401 unless it carries `Authorization: Bearer <access token>`, exactly like
 * any other protected route. Without this header the server never sees `req.auth`, never
 * revokes the session, and the refresh cookie is left valid — sign-out would clear the tab's
 * memory while the session family lives on. So this attaches the current access token when
 * one is held; when none is held (e.g. a stale tab after a hard reload with no session to
 * restore) there is nothing server-side to revoke and the 401 that follows is swallowed below
 * like any other best-effort failure.
 */
export async function logout(): Promise<void> {
  try {
    const token = getAccessToken()
    const headers: Record<string, string> = { [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE }
    if (token) headers.Authorization = `Bearer ${token}`
    await rawFetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers,
    })
  } catch {
    // A network failure on logout must not trap the user in a "logged in" client
    // state — the access token is dropped below regardless, and the refresh cookie
    // (if the request never reached the server) simply outlives this tab.
  } finally {
    setAccessToken(null)
  }
}

let refreshPromise: Promise<boolean> | null = null

async function performRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE },
    })
    if (!res.ok) {
      setAccessToken(null)
      return false
    }
    const data = (await res.json()) as LoginResponse
    setAccessToken(data.accessToken)
    return true
  } catch {
    setAccessToken(null)
    return false
  }
}

/**
 * Single in-flight refresh per tab. Every caller during the window a refresh is running
 * — the silent refresh on load racing a background 401, or three tabs' worth of guards
 * firing at once — shares this one promise instead of each spending (and rotating past)
 * the refresh cookie, which under ADR-0022's no-grace-window rotation would revoke the
 * whole session family on the second caller.
 */
export function refresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

/**
 * Authenticated fetch for everything except the three auth endpoints above. On a 401 it
 * refreshes (once, shared) and retries the request exactly once; a second 401 surfaces as
 * `session_expired` for the caller to act on (redirect to /login). A 403 never retries.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const attempt = async (): Promise<Response> => {
    const headers = new Headers(init.headers)
    const token = getAccessToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    return rawFetch(path, { ...init, headers, credentials: 'include' })
  }

  let res = await attempt()

  if (res.status === 401) {
    const refreshed = await refresh()
    if (!refreshed) {
      throw new ApiError('session_expired', 'Your session ended. Sign in again to continue.', {
        status: 401,
      })
    }
    res = await attempt()
    if (res.status === 401) {
      throw new ApiError('session_expired', 'Your session ended. Sign in again to continue.', {
        status: 401,
      })
    }
  }

  if (res.status === 403) {
    // The fixed contract: "403 {error:'forbidden'} -> /unauthorized". This
    // module has no router, so it only announces the fact — session.ts's
    // onForbidden subscribers (auth-context.tsx) do the actual navigation.
    notifyForbidden()
    throw new ApiError('forbidden', 'You do not have permission to do that.', { status: 403 })
  }

  if (!res.ok) {
    const body = await parseJsonSafe(res)
    throw new ApiError('unknown', toMessage(body, `Request failed (${res.status}).`), {
      status: res.status,
    })
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** `GET /api/auth/me`. Bearer-authenticated, so it is what drives the silent-refresh-on-load
 * path: called with no access token in memory, it 401s, `apiFetch` refreshes from the
 * HttpOnly cookie, and retries — restoring the session with no code duplicated here. */
export function me(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/api/auth/me')
}
