import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from './harness'
import { useRouterState } from './router-store'
import { AuthProvider, useAuth } from '@/lib/api/auth-context'
import { apiFetch, refresh } from '@/lib/api/client'
import { setAccessToken } from '@/lib/api/session'

/*
 * The REAL <AuthProvider> (apps/web/src/lib/api/auth-context.tsx) — the
 * session-required guard, the session-expired redirect, the already-
 * authenticated-on-/login redirect, and the 403 -> /unauthorized wiring.
 * harness.tsx's default `<App/>` deliberately substitutes a FAKE, already-
 * authenticated context value for every ported screen test (jsdom cannot
 * answer a real `GET /api/auth/me`), so none of that provider's own logic is
 * exercised anywhere else. This file renders the provider itself, with
 * `fetch` stubbed, per the M1-W brief's acceptance criteria 5-6.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function CurrentPath() {
  const { pathname, search } = useRouterState()
  return <span data-testid="current-path">{pathname + search}</span>
}

function Protected() {
  const { user } = useAuth()
  return <div>Protected content for {user?.fullName ?? 'nobody'}</div>
}

function ProtectedWithRetry() {
  const { user, retry } = useAuth()
  return (
    <div>
      <div>Protected content for {user?.fullName ?? 'nobody'}</div>
      <button onClick={retry}>recheck session</button>
    </div>
  )
}

/** Renders the live answer of `can('customer.view')` — used to prove permissions actually
 * reload (not just `permissionVersion`) after a refresh, without a page reload. */
function CanMarker() {
  const { can } = useAuth()
  return <span data-testid="can-marker">{can('customer.view') ? 'yes' : 'no'}</span>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <CurrentPath />
        <Protected />
        <CanMarker />
      </AuthProvider>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('AuthProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setAccessToken(null)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('redirects an unauthenticated visit to a protected route to /login?next=<path>', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}))

    renderAt('/dashboard')

    await waitFor(() =>
      expect(screen.getByTestId('current-path')).toHaveTextContent('/login?next=%2Fdashboard'),
    )
  })

  it('never redirects away from /login or /unauthorized while unauthenticated', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}))

    renderAt('/unauthorized')

    // Give the session check every chance to run and settle.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.getByTestId('current-path')).toHaveTextContent('/unauthorized')
  })

  it('marks the redirect as an expiry (?reason=expired) only after a real session existed', async () => {
    // First check: a genuine session. Second (via `retry()`): the session is
    // gone — this is an EXPIRY, not "never logged in", and only the ref that
    // remembers a real session existed can tell the two apart.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          user: { id: 'u1', fullName: 'Ada', email: 'a@b.com' },
          tenant: { id: 't1', code: 'ACME', name: 'Acme' },
          sessionId: 's1',
          permissionVersion: 1,
        }),
      )
      .mockResolvedValue(jsonResponse(401, {}))

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <CurrentPath />
          <ProtectedWithRetry />
        </AuthProvider>
      </MemoryRouter>,
    )

    await screen.findByText('Protected content for Ada')

    fireEvent.click(screen.getByRole('button', { name: 'recheck session' }))

    await waitFor(() =>
      expect(screen.getByTestId('current-path')).toHaveTextContent(
        '/login?next=%2Fdashboard&reason=expired',
      ),
    )
  })

  it('redirects to /unauthorized when any apiFetch call gets a 403', async () => {
    // Keyed by URL, not call order: the permissions-reload effect (auth-context.tsx) now
    // makes its own GET /api/me/permissions call right after /auth/me succeeds, and a
    // plain mockResolvedValueOnce chain would let that extra call silently consume the
    // 403 this test means for the explicit apiFetch('/api/reports/export') below.
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve(
          jsonResponse(200, {
            user: { id: 'u1', fullName: 'Ada', email: 'a@b.com' },
            tenant: { id: 't1', code: 'ACME', name: 'Acme' },
            sessionId: 's1',
            permissionVersion: 1,
          }),
        )
      }
      if (url === '/api/me/permissions') {
        return Promise.resolve(jsonResponse(200, { permissionVersion: 1, permissions: [] }))
      }
      return Promise.resolve(jsonResponse(403, { error: 'forbidden' }))
    })

    renderAt('/dashboard')
    await screen.findByText('Protected content for Ada')

    await expect(apiFetch('/api/reports/export')).rejects.toThrow()

    await waitFor(() =>
      expect(screen.getByTestId('current-path')).toHaveTextContent('/unauthorized'),
    )
  })

  it('reloads permissions after a token refresh, so a revoked permission disappears without a reload', async () => {
    let grantedPermissions = ['customer.view']
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') {
        return Promise.resolve(
          jsonResponse(200, {
            user: { id: 'u1', fullName: 'Ada', email: 'a@b.com' },
            tenant: { id: 't1', code: 'ACME', name: 'Acme' },
            sessionId: 's1',
            permissionVersion: 1,
          }),
        )
      }
      if (url === '/api/me/permissions') {
        return Promise.resolve(
          jsonResponse(200, { permissionVersion: 1, permissions: grantedPermissions }),
        )
      }
      if (url === '/api/auth/refresh' && init?.method === 'POST') {
        // The rotation that follows a permission change server-side (ADR-0009): the new
        // token reflects it; this tab learns the new grant only once it reloads S1.
        grantedPermissions = []
        return Promise.resolve(
          jsonResponse(200, {
            accessToken: 'rotated-token',
            expiresIn: 900,
            user: { id: 'u1', fullName: 'Ada', email: 'a@b.com' },
            tenant: { id: 't1', code: 'ACME', name: 'Acme' },
          }),
        )
      }
      return Promise.resolve(jsonResponse(404, {}))
    })

    renderAt('/dashboard')
    await screen.findByText('Protected content for Ada')
    await waitFor(() => expect(screen.getByTestId('can-marker')).toHaveTextContent('yes'))

    await act(async () => {
      await refresh()
    })

    await waitFor(() => expect(screen.getByTestId('can-marker')).toHaveTextContent('no'))
  })

  it('sends an already-authenticated visitor away from /login, honouring ?next=', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        user: { id: 'u1', fullName: 'Ada', email: 'a@b.com' },
        tenant: { id: 't1', code: 'ACME', name: 'Acme' },
        sessionId: 's1',
        permissionVersion: 1,
      }),
    )

    // auth-context.tsx reads `?next=` from the real `window.location` (its own
    // comment explains why: it sits above app-frame.tsx's Suspense boundary,
    // so it cannot use the router shim's useSearchParams). The MemoryRouter
    // test harness never touches window.location itself, so a real browser's
    // URL is reproduced here the same way real navigation would set it.
    window.history.pushState({}, '', '/login?next=%2Freports')

    renderAt('/login?next=%2Freports')

    await waitFor(() => expect(screen.getByTestId('current-path')).toHaveTextContent('/reports'))
  })
})
