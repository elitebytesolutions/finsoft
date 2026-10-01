import { randomUUID } from 'node:crypto'
import type { APIRequestContext, APIResponse } from '@playwright/test'

/*
 * A thin, real-HTTP client for the parts of the MVP journey (mvp-journey.spec.ts) that have
 * no API-backed screen to drive yet — today that is customer creation (C2) and reading the
 * audit trail (GET /api/audit), per docs/design/M3/ui-plan.md §5 ("still on mock data... not
 * part of the acceptance demo" — /customers and /admin-audit are still `ui-prototype` mocks on
 * `develop` as of this lane; M4-W replaces them). This is NOT a mock: every call here is a real
 * request to the same API process playwright.config.ts's `webServer` starts, over the loopback
 * HTTP the browser itself would use. It exists only because there is no rendered form yet for a
 * Playwright `page` to fill in — the moment M4-W lands a real `/customers` screen, step 2 can
 * move onto `page` the same way `login()` in mvp-journey.spec.ts already does, and this file
 * still earns its keep for the audit-trail checks, which have no screen brief in this wave at
 * all (docs/design-system/pages/audit-trail/README.md's `/admin-audit` is Administration, not
 * M3/M4 scope).
 *
 * Auth shape from apps/api/src/auth/auth.controller.ts (M1-A, "FIXED for M1"): POST /api/auth/
 * login takes { tenantCode, email, password } and returns { accessToken, expiresIn, user,
 * tenant }. The bearer token is used on every call below exactly as the web client's own fetch
 * wrapper (apps/web/src/lib/api/client.ts) would attach it — this file does not reimplement
 * refresh, CSRF or retry, because nothing here runs long enough to need a token refresh.
 */

export interface ApiSession {
  readonly baseUrl: string
  readonly tenantCode: string
  readonly accessToken: string
}

/**
 * The API's own origin — NOT the web app's. playwright.config.ts's default `chromium` project
 * already points `baseURL` here, but mvp-journey.spec.ts overrides `test.use({ baseURL })` to
 * the web app's origin for the same reason m2-accounting.spec.ts does (see that file's own
 * comment), so every direct-to-API call in this helper builds an absolute URL instead of relying
 * on the ambient baseURL.
 */
export function apiBaseUrl(): string {
  const port = Number(process.env.E2E_API_PORT ?? 3011)
  return `http://127.0.0.1:${port}`
}

async function readJson(response: APIResponse): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Signs in for real, against the real database this test's fixture just wrote to. */
export async function apiLogin(
  request: APIRequestContext,
  baseUrl: string,
  tenantCode: string,
  email: string,
  password: string,
): Promise<ApiSession> {
  const response = await request.post(`${baseUrl}/api/auth/login`, {
    data: { tenantCode, email, password },
  })
  const body = (await readJson(response)) as { accessToken?: string } | undefined
  if (!response.ok() || !body?.accessToken) {
    throw new Error(
      `apiLogin failed for ${tenantCode}/${email}: ${response.status()} ${JSON.stringify(body)}`,
    )
  }
  return { baseUrl, tenantCode, accessToken: body.accessToken }
}

export interface ApiCallOptions {
  readonly data?: unknown
  readonly idempotencyKey?: string
  readonly query?: Record<string, string | number | undefined>
}

export interface ApiResult<T = unknown> {
  readonly status: number
  readonly ok: boolean
  readonly body: T
  readonly response: APIResponse
}

/**
 * One authenticated call, bearer-token style, to an absolute API path (e.g. `/api/customers`).
 * Every POST that api-contract.md §1 marks "Idempotency-Key required" needs `idempotencyKey`
 * passed explicitly — this helper never invents one, the same discipline the real UI's
 * `IdempotencyGuard` follows (one key per submission, reused only for a retry of THAT
 * submission).
 */
export async function apiCall<T = unknown>(
  request: APIRequestContext,
  session: ApiSession,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${session.accessToken}` }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  // `data` below is passed as an already-serialized JSON string (so a GET's absence of a body
  // is unambiguous), and APIRequestContext.fetch() does not infer Content-Type from a string
  // body the way it does from a plain object — set it explicitly, or the API's JSON body parser
  // never runs and every POST looks bodyless.
  if (options.data !== undefined) headers['Content-Type'] = 'application/json'

  const url = new URL(`${session.baseUrl}${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const response = await request.fetch(url.toString(), {
    method,
    headers,
    data: options.data === undefined ? undefined : JSON.stringify(options.data),
  })
  const body = (await readJson(response)) as T
  return { status: response.status(), ok: response.ok(), body, response }
}

/** A fresh idempotency key per submission — never reused across two logically different requests. */
export function newIdempotencyKey(): string {
  return randomUUID()
}
