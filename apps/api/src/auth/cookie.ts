import type { CookieOptions, Request, Response } from 'express'

/*
 * The refresh cookie. ADR-0009:48-52, Council update 2026-09-27.
 *
 * The cookie PREFIX is undecided — ADR-0023's own "Open" list gates
 * `Set-Cookie` on it, and the Architecture seat's note explains why: `__Host-`
 * forbids `Domain` and forces `Path=/`, which conflicts with ADR-0009's
 * scoped `Path=/api/auth`; `__Secure-` is compatible with the scoped path.
 * Rather than guess, the name and path are configurable, so the Council can
 * set the staging values without a code change, and a `__Host-` name is
 * REJECTED here unless the path is also `/`, so the two can never silently
 * drift apart.
 *
 * `Secure` is never dropped, even for local http://localhost — Chrome and
 * the other major browsers treat localhost as a secure context, so the flag
 * does not break local development (the task's own note).
 */

const DEFAULT_COOKIE_NAME = 'finsoft_rt'
const DEFAULT_COOKIE_PATH = '/api/auth'
const MAX_AGE_SECONDS = 14 * 24 * 60 * 60 // ADR-0009:24, ~14 days

export function refreshCookieName(): string {
  const name = process.env['AUTH_REFRESH_COOKIE_NAME'] ?? DEFAULT_COOKIE_NAME
  const path = refreshCookiePath()
  if (name.startsWith('__Host-') && path !== '/') {
    throw new Error(
      `AUTH_REFRESH_COOKIE_NAME "${name}" uses the __Host- prefix, which the cookie spec ` +
        `requires Path=/ for. AUTH_REFRESH_COOKIE_PATH is "${path}". Either drop the __Host- ` +
        'prefix (use __Secure- with the scoped path) or set the path to /.',
    )
  }
  return name
}

export function refreshCookiePath(): string {
  return process.env['AUTH_REFRESH_COOKIE_PATH'] ?? DEFAULT_COOKIE_PATH
}

function cookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: refreshCookiePath(),
    maxAge: maxAgeSeconds * 1000,
  }
}

export function setRefreshCookie(res: Response, rawToken: string, expiresAt: Date): void {
  const maxAgeSeconds = Math.max(
    1,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    // Never exceed ADR-0009's ceiling even if a caller passes a bad expiry.
  )
  res.cookie(refreshCookieName(), rawToken, cookieOptions(Math.min(maxAgeSeconds, MAX_AGE_SECONDS)))
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(refreshCookieName(), { path: refreshCookiePath() })
}

export function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined
  return cookies?.[refreshCookieName()]
}

/**
 * CSRF defence for the refresh and logout endpoints (ADR-0009's cookie means
 * CSRF must be handled explicitly). A simple browser form post cannot set a
 * custom header, so requiring this one is sufficient against that class of
 * attack without a double-submit token.
 */
export function hasCsrfHeader(req: Request): boolean {
  return req.headers['x-requested-with'] === 'finsoft'
}
